import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createRepositoryBundle,
  detectSecretTypes,
} from "../lib/repository-bundle.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-repository-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function runGit(root, ...args) {
  return execFileAsync("git", ["-C", root, ...args], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

test("creates a Git-aware ZIP and excludes sensitive, generated, and symlink paths", async (t) => {
  const root = await fixture(t);
  const repository = path.join(root, "sample-repository");
  const stateRoot = path.join(root, "state");
  const outputDirectory = path.join(root, "output");
  const githubToken = `gh${"p_"}${"A".repeat(36)}`;

  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "dist"), { recursive: true });
  await fs.writeFile(path.join(repository, "README.md"), "# Safe repository\n");
  await fs.writeFile(path.join(repository, "src", "index.js"), "export const ok = true;\n");
  await fs.writeFile(
    path.join(repository, "src", "private-config.js"),
    `export const token = "${githubToken}";\n`,
  );
  await fs.writeFile(path.join(repository, ".env"), "TOKEN=a-real-looking-value\n");
  await fs.writeFile(path.join(repository, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(repository, "ignored.txt"), "ignored content\n");
  await fs.writeFile(path.join(repository, "dist", "generated.js"), "generated\n");
  await fs.writeFile(path.join(repository, "old-bundle.zip"), "opaque archive bytes\n");

  await runGit(repository, "init", "-q");
  await runGit(repository, "config", "user.email", "bundle-test@example.invalid");
  await runGit(repository, "config", "user.name", "Bundle Test");
  await runGit(
    repository,
    "add",
    "README.md",
    "src",
    ".env",
    ".gitignore",
    "old-bundle.zip",
  );
  await runGit(repository, "add", "-f", "dist/generated.js");
  await runGit(repository, "commit", "-qm", "fixture");
  await fs.writeFile(path.join(repository, "notes.md"), "untracked but not ignored\n");
  await fs.symlink(path.join(repository, "README.md"), path.join(repository, "readme-link"));

  const result = await createRepositoryBundle({
    repositoryRoot: repository,
    selection: "git-worktree",
    stateRoot,
    outputDirectory,
    workerId: "test/worker",
  });

  assert.equal(result.localOnly, true);
  assert.equal(result.uploaded, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.archive.mimeType, "application/zip");
  assert.equal(result.archive.sha256.length, 64);
  assert.equal((await fs.stat(result.archive.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(result.manifest.path)).mode & 0o777, 0o600);

  const { stdout } = await execFileAsync(
    "/usr/bin/unzip",
    ["-Z1", result.archive.path],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const entries = stdout.trim().split("\n");
  assert.ok(entries.includes("sample-repository/README.md"));
  assert.ok(entries.includes("sample-repository/src/index.js"));
  assert.ok(entries.includes("sample-repository/notes.md"));
  assert.ok(entries.includes("sample-repository/.codex-repository-bundle.json"));
  assert.ok(!entries.some((entry) => entry.endsWith("/.env")));
  assert.ok(!entries.some((entry) => entry.includes("private-config.js")));
  assert.ok(!entries.some((entry) => entry.includes("dist/generated.js")));
  assert.ok(!entries.some((entry) => entry.includes("readme-link")));
  assert.ok(!entries.some((entry) => entry.includes("ignored.txt")));
  assert.ok(!entries.some((entry) => entry.includes("old-bundle.zip")));

  const manifestText = await fs.readFile(result.manifest.path, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.transmission, "No upload or network transmission was performed by this action.");
  assert.ok(manifest.included.some((item) => item.path === "src/index.js"));
  assert.deepEqual(
    manifest.excluded.find((item) => item.path === "src/private-config.js"),
    {
      path: "src/private-config.js",
      reason: "secret-content",
      detections: ["github-token", "secret-assignment"],
    },
  );
  assert.equal(
    manifest.excluded.find((item) => item.path === ".env")?.reason,
    "sensitive-filename",
  );
  assert.equal(
    manifest.excluded.find((item) => item.path === "dist/generated.js")?.reason,
    "runtime-or-generated-path",
  );
  assert.equal(
    manifest.excluded.find((item) => item.path === "readme-link")?.reason,
    "symbolic-link",
  );
  assert.equal(
    manifest.excluded.find((item) => item.path === "old-bundle.zip")?.reason,
    "opaque-archive",
  );
  assert.ok(!manifestText.includes(githubToken));
  assert.ok(!JSON.stringify(result).includes(githubToken));
});

test("supports exact selected paths and refuses broad or ambiguous roots", async (t) => {
  const root = await fixture(t);
  const repository = path.join(root, "selected-repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.writeFile(path.join(repository, "README.md"), "selected\n");
  await fs.writeFile(path.join(repository, "src", "one.js"), "one\n");
  await fs.writeFile(path.join(repository, "src", "two.js"), "two\n");

  const result = await createRepositoryBundle({
    repositoryRoot: repository,
    selection: "selected",
    includePaths: ["README.md", "src"],
    excludePaths: ["src/two.js"],
    stateRoot: path.join(root, "state"),
    maxTotalBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  const manifest = JSON.parse(await fs.readFile(result.manifest.path, "utf8"));
  assert.deepEqual(
    manifest.included.map((item) => item.path),
    ["README.md", "src/one.js"],
  );
  assert.equal(
    manifest.excluded.find((item) => item.path === "src/two.js")?.reason,
    "user-excluded",
  );

  await assert.rejects(
    createRepositoryBundle({
      repositoryRoot: "relative-repository",
      selection: "directory",
      stateRoot: path.join(root, "state"),
    }),
    /exact absolute directory path/,
  );
  await assert.rejects(
    createRepositoryBundle({
      repositoryRoot: os.homedir(),
      selection: "directory",
      stateRoot: path.join(root, "state"),
    }),
    /entire home directory/,
  );
  await assert.rejects(
    createRepositoryBundle({
      repositoryRoot: repository,
      selection: "selected",
      includePaths: ["../outside"],
      stateRoot: path.join(root, "state"),
    }),
    /stay inside repository_root/,
  );
});

test("detects known credentials but ignores explicit placeholder assignments", () => {
  const openAiKey = `sk-${"B".repeat(40)}`;
  assert.deepEqual(detectSecretTypes(`OPENAI_API_KEY=${openAiKey}`), [
    "openai-or-anthropic-key",
    "secret-assignment",
  ]);
  assert.deepEqual(detectSecretTypes("OPENAI_API_KEY=your-key-here"), []);
  assert.deepEqual(detectSecretTypes("TOKEN=do-not-send"), []);
});
