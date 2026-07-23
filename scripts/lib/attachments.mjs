import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MIB = 1024 * 1024;

export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * MIB;
export const MAX_IMAGE_BYTES = 20 * MIB;
export const MAX_SPREADSHEET_BYTES = 50 * MIB;
export const MAX_DOCUMENT_BYTES = 50 * MIB;
export const MAX_ARCHIVE_BYTES = 100 * MIB;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const CONVERTIBLE_IMAGE_EXTENSIONS = new Set([".heic", ".heif"]);
const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".ods",
]);
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".odt",
  ".odp",
  ".rtf",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".tex",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".cs",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".gql",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".ipynb",
]);
const GOOGLE_SHORTCUT_EXTENSIONS = new Set([".gdoc", ".gsheet", ".gslides"]);
const ARCHIVE_EXTENSIONS = new Set([".zip"]);

function formatMib(bytes) {
  return `${Math.round((bytes / MIB) * 10) / 10} MB`;
}

function classifyExtension(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CONVERTIBLE_IMAGE_EXTENSIONS.has(extension)) return "convertible-image";
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  return null;
}

function isSensitivePath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const normalized = filePath.toLowerCase().replaceAll("\\", "/");
  return (
    /^\.env(?:\.|$)/.test(base) ||
    [
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "id_rsa",
      "id_ed25519",
      "cookies",
      "cookies-journal",
      "login data",
      "login data-journal",
    ].includes(base) ||
    /\.(?:pem|key|p12|pfx)$/.test(base) ||
    /(?:^|[-_.])(?:credentials?|service[-_.]?account|private[-_.]?key)(?:[-_.]|$)/.test(
      base,
    ) ||
    /\/(?:network\/)?(?:cookies|login data)(?:-journal)?$/.test(normalized)
  );
}

function publicRecord(record) {
  return {
    originalPath: record.originalPath,
    originalName: record.originalName,
    originalFormat: record.originalExtension.slice(1).toUpperCase(),
    originalSizeBytes: record.originalSizeBytes,
    sentName: record.uploadName,
    sentFormat: record.uploadExtension.slice(1).toUpperCase(),
    sentSizeBytes: record.uploadSizeBytes,
    category: record.category,
    converted: record.converted,
    conversion: record.conversion,
  };
}

async function convertHeicWithSips(source, destination) {
  try {
    await execFileAsync(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "90",
        source,
        "--out",
        destination,
      ],
      { timeout: 120_000, maxBuffer: MIB },
    );
  } catch (error) {
    throw new Error(
      `Could not convert ${path.basename(source)} from HEIC/HEIF to JPEG: ${
        error?.stderr?.trim() || error.message
      }`,
    );
  }
}

export async function validateAttachmentPaths(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("attachments must be an array of paths.");
  if (input.length > MAX_ATTACHMENTS) {
    throw new Error(
      `At most ${MAX_ATTACHMENTS} files may be attached to one bridge request.`,
    );
  }

  const validated = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const value of input) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Attachment paths may not be empty.");
    if (!path.isAbsolute(raw)) {
      throw new Error(
        `Attachment paths must be absolute so the bridge cannot resolve the wrong workspace file: ${raw}`,
      );
    }
    const absolutePath = path.normalize(raw);
    if (seen.has(absolutePath)) {
      throw new Error(`The same attachment was supplied more than once: ${absolutePath}`);
    }
    seen.add(absolutePath);
    if (isSensitivePath(absolutePath)) {
      throw new Error(
        `Refusing to upload a path that appears to contain credentials, keys, or browser session data: ${absolutePath}`,
      );
    }

    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Attachment does not exist: ${absolutePath}`);
      }
      throw new Error(`Could not inspect attachment ${absolutePath}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Symbolic-link attachments are not accepted; provide the exact real file path: ${absolutePath}`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `Only individual regular files may be attached; directories and other paths are not accepted: ${absolutePath}`,
      );
    }

    const extension = path.extname(absolutePath).toLowerCase();
    if (GOOGLE_SHORTCUT_EXTENSIONS.has(extension)) {
      throw new Error(
        `${path.basename(absolutePath)} is a Google Drive shortcut. Export it as DOCX, PDF, PPTX, XLSX, CSV, or another supported file first.`,
      );
    }
    const category = classifyExtension(extension);
    if (!category) {
      throw new Error(
        `Unsupported attachment type “${extension || "no extension"}” for ${path.basename(
          absolutePath,
        )}. Convert it to a common document, spreadsheet, text/code, ZIP archive, PNG, JPEG, GIF, HEIC, or HEIF file first.`,
      );
    }

    const maxBytes =
      category === "image"
        ? MAX_IMAGE_BYTES
        : category === "convertible-image"
          ? MAX_DOCUMENT_BYTES
          : category === "archive"
            ? MAX_ARCHIVE_BYTES
          : category === "spreadsheet"
            ? MAX_SPREADSHEET_BYTES
            : MAX_DOCUMENT_BYTES;
    if (stat.size > maxBytes) {
      throw new Error(
        `${path.basename(absolutePath)} is ${formatMib(stat.size)}, above this bridge's ${formatMib(
          maxBytes,
        )} limit for ${category === "convertible-image" ? "HEIC/HEIF inputs" : `${category} files`}.`,
      );
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `The selected files total ${formatMib(totalBytes)}, above this bridge's ${formatMib(
          MAX_TOTAL_ATTACHMENT_BYTES,
        )} per-request limit.`,
      );
    }
    validated.push({
      originalPath: absolutePath,
      originalName: path.basename(absolutePath),
      originalExtension: extension,
      originalSizeBytes: stat.size,
      category,
    });
  }
  return validated;
}

export async function prepareAttachments(
  input,
  {
    stateRoot,
    workerId = `${process.pid}`,
    convertHeic = convertHeicWithSips,
  } = {},
) {
  const validated = await validateAttachmentPaths(input);
  if (!validated.length) {
    return {
      attachments: [],
      publicAttachments: [],
      stagingDirectory: null,
      cleanup: async () => {},
    };
  }
  if (!stateRoot) throw new Error("A bridge state directory is required for attachments.");

  let stagingDirectory = null;
  const cleanup = async () => {
    if (stagingDirectory) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
      stagingDirectory = null;
    }
  };

  try {
    const attachments = [];
    let totalUploadBytes = 0;
    for (const [index, item] of validated.entries()) {
      let record;
      if (item.category === "convertible-image") {
        if (!stagingDirectory) {
          const safeWorker = String(workerId).replace(/[^a-z0-9_.-]+/gi, "-");
          stagingDirectory = path.join(
            stateRoot,
            "attachment-staging",
            safeWorker,
            crypto.randomUUID(),
          );
          await fs.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
        }
        const stem = path
          .basename(item.originalName, path.extname(item.originalName))
          .replace(/[^a-z0-9_.-]+/gi, "-")
          .replace(/^-+|-+$/g, "") || `image-${index + 1}`;
        const uploadName = `${stem}-chatgpt-${index + 1}.jpg`;
        const uploadPath = path.join(stagingDirectory, uploadName);
        await convertHeic(item.originalPath, uploadPath);
        const convertedStat = await fs.stat(uploadPath);
        if (!convertedStat.isFile() || convertedStat.size === 0) {
          throw new Error(`HEIC/HEIF conversion produced no JPEG data for ${item.originalName}.`);
        }
        if (convertedStat.size > MAX_IMAGE_BYTES) {
          throw new Error(
            `The temporary JPEG for ${item.originalName} is ${formatMib(
              convertedStat.size,
            )}, above this bridge's ${formatMib(MAX_IMAGE_BYTES)} image limit.`,
          );
        }
        await fs.chmod(uploadPath, 0o600);
        record = {
          ...item,
          category: "image",
          uploadPath,
          uploadName,
          uploadExtension: ".jpg",
          uploadSizeBytes: convertedStat.size,
          converted: true,
          conversion: "Temporary local HEIC/HEIF-to-JPEG conversion; original unchanged",
        };
      } else {
        record = {
          ...item,
          uploadPath: item.originalPath,
          uploadName: item.originalName,
          uploadExtension: item.originalExtension,
          uploadSizeBytes: item.originalSizeBytes,
          converted: false,
          conversion: null,
        };
      }
      totalUploadBytes += record.uploadSizeBytes;
      if (totalUploadBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new Error(
          `The files prepared for upload total ${formatMib(
            totalUploadBytes,
          )}, above this bridge's ${formatMib(MAX_TOTAL_ATTACHMENT_BYTES)} per-request limit.`,
        );
      }
      attachments.push(record);
    }
    return {
      attachments,
      publicAttachments: attachments.map(publicRecord),
      stagingDirectory,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
