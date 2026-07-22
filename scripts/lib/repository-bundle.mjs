import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export const DEFAULT_BUNDLE_MAX_BYTES = 80 * MIB;
export const DEFAULT_BUNDLE_MAX_FILE_BYTES = 25 * MIB;
export const DEFAULT_BUNDLE_MAX_FILES = 5_000;
export const MAX_BUNDLE_BYTES = 500 * MIB;
export const MAX_BUNDLE_FILE_BYTES = 100 * MIB;
export const MAX_BUNDLE_FILES = 20_000;

const SELECTIONS = new Set([
  "git-tracked",
  "git-worktree",
  "selected",
  "directory",
]);

const HARD_EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  ".nyc_output",
  "dist",
  "build",
  "target",
  ".gradle",
  "pods",
  "deriveddata",
  ".codex",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  "keychains",
  "chatgpt chrome bridge",
]);

const HARD_EXCLUDED_BASENAMES = new Set([
  ".ds_store",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".dockerconfigjson",
  "cookies",
  "cookies-journal",
  "login data",
  "login data-journal",
  "web data",
  "web data-journal",
  "history",
  "history-journal",
  "local state",
  "google-services.json",
  "googleservice-info.plist",
]);

const OPAQUE_ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".apk",
  ".bz2",
  ".dmg",
  ".ear",
  ".gz",
  ".ipa",
  ".iso",
  ".jar",
  ".rar",
  ".tar",
  ".tgz",
  ".war",
  ".xz",
  ".zip",
]);

const SECRET_PATTERNS = [
  {
    id: "private-key",
    expression:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i,
  },
  {
    id: "aws-access-key",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    id: "github-token",
    expression:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    id: "openai-or-anthropic-key",
    expression: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/,
  },
  {
    id: "slack-token",
    expression: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  },
  {
    id: "stripe-secret",
    expression: /\b(?:sk_live_|rk_live_|whsec_)[A-Za-z0-9]{12,}\b/,
  },
  {
    id: "google-api-key",
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "npm-token",
    expression: /\bnpm_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: "pypi-token",
    expression: /\bpypi-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "jwt",
    expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: "credentialed-url",
    expression: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/i,
  },
];

const SENSITIVE_FIELD_PATTERN =
  "[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY)[A-Z0-9_.-]*";
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  `(?:^|[\\s,{])["']?(${SENSITIVE_FIELD_PATTERN})["']?\\s*[:=]\\s*(["'])([^"'\\r\\n]{8,})\\2`,
  "gim",
);
const LINE_SECRET_ASSIGNMENT = new RegExp(
  `^\\s*(${SENSITIVE_FIELD_PATTERN})\\s*[:=]\\s*([^\\s#"',;}{]{8,})\\s*(?:#.*)?$`,
  "gim",
);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeToken(value, fallback = "repository") {
  return (
    String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[^a-z0-9_.-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || fallback
  );
}

function toArchivePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function normalizeRelativePath(value, label = "path") {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(`${label} may not be empty.`);
  if (path.isAbsolute(raw)) {
    throw new Error(`${label} must be relative to repository_root: ${raw}`);
  }
  if (raw.includes("\0") || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  if (raw.includes("\\")) {
    throw new Error(`${label} may not contain backslashes: ${raw}`);
  }
  const normalized = path.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside repository_root: ${raw}`);
  }
  return normalized;
}

function isPlaceholderSecret(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  if (!normalized) return true;
  if (
    normalized.startsWith("${") ||
    normalized.startsWith("$(") ||
    normalized.startsWith("process.env") ||
    normalized.startsWith("os.environ") ||
    normalized.startsWith("env.") ||
    (normalized.startsWith("<") && normalized.endsWith(">"))
  ) {
    return true;
  }
  if (/^[x*_.-]{8,}$/.test(normalized)) return true;
  const exactPlaceholders = new Set([
    "example",
    "sample",
    "placeholder",
    "changeme",
    "change-me",
    "replace-me",
    "replace_me",
    "your-key",
    "your_key",
    "your-token",
    "your_token",
    "not-a-secret",
    "do-not-send",
    "redacted",
    "dummy",
    "fake",
    "test-only",
  ]);
  return (
    exactPlaceholders.has(normalized) ||
    /^(?:example|sample|placeholder|dummy|fake|test|your|replace|change)[-_.]/.test(
      normalized,
    ) ||
    /[-_.](?:example|sample|placeholder|dummy|fake|test)$/.test(normalized)
  );
}

export function detectSecretTypes(content) {
  const text = Buffer.isBuffer(content)
    ? content.toString("utf8")
    : String(content || "");
  const detected = new Set();
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.expression.test(text)) detected.add(pattern.id);
  }
  QUOTED_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_SECRET_ASSIGNMENT)) {
    if (!isPlaceholderSecret(match[3])) detected.add("secret-assignment");
  }
  LINE_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(LINE_SECRET_ASSIGNMENT)) {
    if (!isPlaceholderSecret(match[2])) detected.add("secret-assignment");
  }
  return [...detected].sort();
}

function pathExclusion(relativePath, userExclusions) {
  const archivePath = toArchivePath(relativePath);
  const segments = archivePath.split("/");
  const base = segments.at(-1) || "";
  const lowerBase = base.toLowerCase();
  for (const excluded of userExclusions) {
    const candidate = toArchivePath(excluded);
    if (archivePath === candidate || archivePath.startsWith(`${candidate}/`)) {
      return "user-excluded";
    }
  }
  if (segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) {
    return "runtime-or-generated-path";
  }
  if (HARD_EXCLUDED_BASENAMES.has(lowerBase)) return "sensitive-filename";
  if (/^\.env(?:\.|$)/i.test(base) && !/^\.env\.(?:example|sample|template)$/i.test(base)) {
    return "sensitive-filename";
  }
  if (
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i.test(base) ||
    /(?:^|[-_.])(?:credentials?|service[-_.]?account|private[-_.]?key|secrets?)(?:[-_.]|$)/i.test(
      base,
    )
  ) {
    return "sensitive-filename";
  }
  if (/\.(?:log|tmp|temp|swp|swo)$/i.test(base)) return "runtime-or-generated-file";
  if (OPAQUE_ARCHIVE_EXTENSIONS.has(path.extname(lowerBase))) {
    return "opaque-archive";
  }
  if (/\.(?:app|bundle|framework)$/i.test(base)) return "opaque-package";
  if (/\.(?:db|sqlite|sqlite3|keychain-db)$/i.test(base)) return "opaque-database";
  return null;
}

async function assertSafeRoot(repositoryRoot) {
  const raw = String(repositoryRoot || "").trim();
  if (!path.isAbsolute(raw)) {
    throw new Error("repository_root must be an exact absolute directory path.");
  }
  const normalized = path.normalize(raw);
  const stat = await fs.lstat(normalized).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`repository_root does not exist: ${normalized}`);
    throw error;
  });
  if (stat.isSymbolicLink()) {
    throw new Error(`repository_root may not be a symbolic link: ${normalized}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`repository_root is not a directory: ${normalized}`);
  }
  const realRoot = await fs.realpath(normalized);
  const realHome = await fs.realpath(os.homedir());
  if (realRoot === path.parse(realRoot).root || realRoot === realHome) {
    throw new Error("Refusing to bundle a filesystem root or the entire home directory.");
  }
  const forbidden = [
    path.join(realHome, ".ssh"),
    path.join(realHome, ".gnupg"),
    path.join(realHome, ".aws"),
    path.join(realHome, ".azure"),
    path.join(realHome, ".gcloud"),
    path.join(realHome, ".kube"),
    path.join(realHome, ".codex"),
    path.join(realHome, "Library", "Keychains"),
    path.join(realHome, "Library", "Application Support", "Google", "Chrome"),
    path.join(
      realHome,
      "Library",
      "Application Support",
      "ChatGPT Chrome Bridge",
    ),
  ];
  if (forbidden.some((entry) => isWithin(entry, realRoot))) {
    throw new Error(
      "Refusing to bundle a credentials, browser-session, Codex-state, or keychain directory.",
    );
  }
  return realRoot;
}

async function gitRepositoryRoot(root) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { timeout: 30_000, maxBuffer: MIB },
    );
    return fs.realpath(stdout.trim());
  } catch (error) {
    throw new Error(
      `repository_root must be a Git worktree for this selection: ${
        error?.stderr?.trim() || error.message
      }`,
    );
  }
}

async function gitCandidates(root, selection) {
  const topLevel = await gitRepositoryRoot(root);
  if (topLevel !== root) {
    throw new Error(
      `repository_root must be the Git worktree root (${topLevel}), not a nested directory.`,
    );
  }
  const args = ["-C", root, "ls-files", "-z", "--cached"];
  if (selection === "git-worktree") args.push("--others", "--exclude-standard");
  const { stdout } = await execFileAsync("git", args, {
    timeout: 60_000,
    maxBuffer: 64 * MIB,
    encoding: "buffer",
  });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => normalizeRelativePath(entry, "Git path"));
}

async function walkDirectory(root, relativeDirectory, output, seen) {
  const absolute = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const relative = relativeDirectory
      ? path.join(relativeDirectory, entry.name)
      : entry.name;
    const normalized = normalizeRelativePath(relative, "directory entry");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (entry.isSymbolicLink()) {
      output.push(normalized);
      continue;
    }
    if (entry.isDirectory()) {
      if (pathExclusion(normalized, [])) {
        output.push(normalized);
        continue;
      }
      await walkDirectory(root, normalized, output, seen);
      continue;
    }
    output.push(normalized);
  }
}

async function selectedCandidates(root, includePaths) {
  if (!includePaths?.length) {
    throw new Error("selection=selected requires at least one include_paths entry.");
  }
  const output = [];
  const seen = new Set();
  for (const value of includePaths) {
    const relative = normalizeRelativePath(value, "include path");
    const absolute = path.join(root, relative);
    if (!isWithin(root, absolute)) {
      throw new Error(`include path escapes repository_root: ${value}`);
    }
    const stat = await fs.lstat(absolute).catch((error) => {
      if (error?.code === "ENOENT") throw new Error(`include path does not exist: ${value}`);
      throw error;
    });
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (pathExclusion(relative, [])) {
        output.push(relative);
      } else {
        await walkDirectory(root, relative, output, seen);
      }
    } else {
      output.push(relative);
    }
  }
  return output;
}

async function candidatePaths(root, selection, includePaths) {
  if (selection === "git-tracked" || selection === "git-worktree") {
    return gitCandidates(root, selection);
  }
  if (selection === "selected") return selectedCandidates(root, includePaths);
  const output = [];
  await walkDirectory(root, "", output, new Set());
  return output;
}

async function ensurePrivateDirectory(directory) {
  const normalized = path.normalize(directory);
  try {
    const stat = await fs.lstat(normalized);
    if (stat.isSymbolicLink()) {
      throw new Error(`Output directory may not be a symbolic link: ${normalized}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Output path is not a directory: ${normalized}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(normalized, { recursive: true, mode: 0o700 });
  }
  return normalized;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function copyUnique(source, outputDirectory, requestedName) {
  const extension = path.extname(requestedName);
  const stem = path.basename(requestedName, extension);
  for (let index = 0; index < 1_000; index += 1) {
    const name = index ? `${stem}-${index + 1}${extension}` : requestedName;
    const target = path.join(outputDirectory, name);
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      await fs.chmod(target, 0o600);
      return { name, path: target };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not reserve a unique output name for ${requestedName}.`);
}

export async function createRepositoryBundle({
  repositoryRoot,
  selection = "git-worktree",
  includePaths = [],
  excludePaths = [],
  outputDirectory = null,
  archiveName = null,
  stateRoot,
  workerId = `${process.pid}`,
  maxTotalBytes = DEFAULT_BUNDLE_MAX_BYTES,
  maxFileBytes = DEFAULT_BUNDLE_MAX_FILE_BYTES,
  maxFiles = DEFAULT_BUNDLE_MAX_FILES,
} = {}) {
  if (!SELECTIONS.has(selection)) {
    throw new Error(`Unsupported repository bundle selection: ${selection}`);
  }
  if (!stateRoot || !path.isAbsolute(stateRoot)) {
    throw new Error("A private absolute bridge stateRoot is required.");
  }
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_BUNDLE_BYTES) {
    throw new Error(`maxTotalBytes must be between 1 and ${MAX_BUNDLE_BYTES}.`);
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(`maxFileBytes must be between 1 and ${MAX_BUNDLE_FILE_BYTES}.`);
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BUNDLE_FILES) {
    throw new Error(`maxFiles must be between 1 and ${MAX_BUNDLE_FILES}.`);
  }

  const root = await assertSafeRoot(repositoryRoot);
  const userExclusions = excludePaths.map((entry) =>
    normalizeRelativePath(entry, "exclude path"),
  );
  const candidates = [...new Set(await candidatePaths(root, selection, includePaths))].sort();
  if (candidates.length > maxFiles) {
    throw new Error(
      `The selection contains ${candidates.length} paths, above the ${maxFiles}-path limit. Narrow include_paths or raise max_files deliberately.`,
    );
  }

  const bundleId = crypto.randomUUID();
  const safeWorker = safeToken(workerId, "worker");
  const stagingRoot = path.join(
    stateRoot,
    "repository-bundles",
    "staging",
    safeWorker,
    bundleId,
  );
  const repositoryName = safeToken(path.basename(root), "repository");
  const contentRoot = path.join(stagingRoot, "content");
  const stagedRepository = path.join(contentRoot, repositoryName);
  const included = [];
  const excluded = [];
  let includedBytes = 0;

  await fs.mkdir(stagedRepository, { recursive: true, mode: 0o700 });
  try {
    for (const relativePath of candidates) {
      const excludedReason = pathExclusion(relativePath, userExclusions);
      if (excludedReason) {
        excluded.push({ path: toArchivePath(relativePath), reason: excludedReason });
        continue;
      }
      const absolutePath = path.join(root, relativePath);
      if (!isWithin(root, absolutePath)) {
        excluded.push({ path: toArchivePath(relativePath), reason: "outside-root" });
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        excluded.push({ path: toArchivePath(relativePath), reason: "unreadable" });
        continue;
      }
      if (stat.isSymbolicLink()) {
        excluded.push({ path: toArchivePath(relativePath), reason: "symbolic-link" });
        continue;
      }
      if (!stat.isFile()) {
        excluded.push({ path: toArchivePath(relativePath), reason: "non-regular-file" });
        continue;
      }
      const realFile = await fs.realpath(absolutePath).catch(() => null);
      if (!realFile || !isWithin(root, realFile)) {
        excluded.push({ path: toArchivePath(relativePath), reason: "outside-root" });
        continue;
      }
      if (stat.size > maxFileBytes) {
        excluded.push({ path: toArchivePath(relativePath), reason: "file-size-limit" });
        continue;
      }
      let body;
      try {
        body = await fs.readFile(absolutePath);
      } catch {
        excluded.push({ path: toArchivePath(relativePath), reason: "unreadable" });
        continue;
      }
      if (body.length > maxFileBytes) {
        excluded.push({ path: toArchivePath(relativePath), reason: "file-size-limit" });
        continue;
      }
      const detections = detectSecretTypes(body);
      if (detections.length) {
        excluded.push({
          path: toArchivePath(relativePath),
          reason: "secret-content",
          detections,
        });
        continue;
      }
      if (includedBytes + body.length > maxTotalBytes) {
        throw new Error(
          `Included files exceed the ${Math.round(maxTotalBytes / MIB)} MB bundle limit. Narrow the selection rather than creating a silently truncated archive.`,
        );
      }
      const stagedPath = path.join(stagedRepository, relativePath);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(stagedPath, body, { mode: stat.mode & 0o111 ? 0o700 : 0o600 });
      const sha256 = crypto.createHash("sha256").update(body).digest("hex");
      includedBytes += body.length;
      included.push({
        path: toArchivePath(relativePath),
        sizeBytes: body.length,
        sha256,
      });
    }

    if (!included.length) {
      throw new Error(
        "No files remained after path exclusions and secret scanning; no archive was created.",
      );
    }

    let gitCommit = null;
    if (selection.startsWith("git-")) {
      gitCommit = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
        timeout: 30_000,
        maxBuffer: MIB,
      })
        .then(({ stdout }) => stdout.trim())
        .catch(() => null);
    }
    const warnings = [
      "Secret detection is conservative and pattern-based; it cannot prove that every possible secret was found.",
      "Review the manifest and archive contents before uploading or sharing the bundle.",
    ];
    const internalManifest = {
      version: 1,
      bundleId,
      createdAt: new Date().toISOString(),
      repositoryName,
      selection,
      gitCommit,
      localOnly: true,
      reviewRequired: true,
      limits: {
        maxFiles,
        maxFileBytes,
        maxTotalBytes,
      },
      summary: {
        candidateCount: candidates.length,
        includedCount: included.length,
        includedBytes,
        excludedCount: excluded.length,
      },
      included,
      excluded,
      warnings,
    };
    const internalManifestPath = path.join(
      stagedRepository,
      ".codex-repository-bundle.json",
    );
    await fs.writeFile(
      internalManifestPath,
      `${JSON.stringify(internalManifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const temporaryZip = path.join(stagingRoot, `${repositoryName}.zip`);
    await execFileAsync(
      "/usr/bin/zip",
      ["-q", "-r", "-X", temporaryZip, repositoryName],
      {
        cwd: contentRoot,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        timeout: 10 * 60_000,
        maxBuffer: 8 * MIB,
      },
    );
    if (outputDirectory && !path.isAbsolute(outputDirectory)) {
      throw new Error("output_directory must be an exact absolute path.");
    }
    const destinationRoot = await ensurePrivateDirectory(
      outputDirectory
        ? path.normalize(outputDirectory)
        : path.join(stateRoot, "repository-bundles", "completed"),
    );
    const requestedArchive = `${safeToken(
      archiveName ? path.basename(archiveName, path.extname(archiveName)) : repositoryName,
      repositoryName,
    )}.zip`;
    const archive = await copyUnique(temporaryZip, destinationRoot, requestedArchive);
    const archiveStat = await fs.stat(archive.path);
    const archiveSha256 = await sha256File(archive.path);
    const externalManifest = {
      ...internalManifest,
      archive: {
        name: archive.name,
        sizeBytes: archiveStat.size,
        sha256: archiveSha256,
        mimeType: "application/zip",
      },
      transmission: "No upload or network transmission was performed by this action.",
    };
    const temporaryManifest = path.join(stagingRoot, `${repositoryName}.manifest.json`);
    await fs.writeFile(
      temporaryManifest,
      `${JSON.stringify(externalManifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const manifest = await copyUnique(
      temporaryManifest,
      destinationRoot,
      `${path.basename(archive.name, ".zip")}.manifest.json`,
    );
    const manifestStat = await fs.stat(manifest.path);

    return {
      bundleId,
      repositoryRoot: root,
      repositoryName,
      selection,
      localOnly: true,
      uploaded: false,
      reviewRequired: true,
      archive: {
        ...archive,
        sizeBytes: archiveStat.size,
        sha256: archiveSha256,
        mimeType: "application/zip",
      },
      manifest: {
        ...manifest,
        sizeBytes: manifestStat.size,
        mimeType: "application/json",
      },
      summary: externalManifest.summary,
      excluded: excluded.slice(0, 200),
      excludedPreviewTruncated: excluded.length > 200,
      warnings,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
