import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { responseResourceLinks } from "../lib/mcp-output.mjs";
import {
  filenameFromContentDisposition,
  prepareResponseOutputDirectory,
  safeRemoteUrl,
  sanitizeResponseFilename,
  saveResponseBuffer,
  writeResponseFileManifest,
} from "../lib/response-files.mjs";

test("sanitizes generated filenames and strips signed remote query strings", () => {
  assert.equal(sanitizeResponseFilename("../../private/report?.csv"), "report-.csv");
  assert.equal(sanitizeResponseFilename("..\\..\\final\u0000.docx"), "final.docx");
  assert.equal(
    filenameFromContentDisposition(
      "attachment; filename*=UTF-8''Quarterly%20Review%202026.xlsx",
    ),
    "Quarterly Review 2026.xlsx",
  );
  assert.equal(
    safeRemoteUrl("https://files.example/report.csv?token=secret#download"),
    "https://files.example/report.csv",
  );
  assert.equal(safeRemoteUrl("blob:https://chatgpt.com/private-id"), "blob:redacted");
});

test("creates private output directories and rejects relative or symlink targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-response-dir-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    prepareResponseOutputDirectory({
      stateRoot: root,
      collectionId: "job",
      outputDirectory: "relative-output",
    }),
    /must be an absolute path/,
  );
  const destination = await prepareResponseOutputDirectory({
    stateRoot: root,
    collectionId: "job-123",
  });
  assert.equal(destination, path.join(root, "response-files", "job-123"));
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);

  const target = path.join(root, "real-directory");
  const link = path.join(root, "linked-directory");
  await fs.mkdir(target);
  await fs.symlink(target, link);
  await assert.rejects(
    prepareResponseOutputDirectory({
      stateRoot: root,
      collectionId: "job",
      outputDirectory: link,
    }),
    /may not be a symbolic link/,
  );
});

test("saves collision-safe response files with hashes and a manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-response-save-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = await prepareResponseOutputDirectory({
    stateRoot: root,
    collectionId: "artifact-job",
  });
  const body = Buffer.from("item,status\nfinal_signal,passed\n", "utf8");
  const first = await saveResponseBuffer(body, {
    outputDirectory: destination,
    requestedName: "bridge-result.csv",
    mimeType: "text/csv; charset=utf-8",
    sourceUrl: "https://chatgpt.com/backend-api/files/abc?sig=private",
  });
  const second = await saveResponseBuffer(body, {
    outputDirectory: destination,
    requestedName: "bridge-result.csv",
    mimeType: "application/octet-stream",
  });
  assert.equal(first.name, "bridge-result.csv");
  assert.equal(second.name, "bridge-result-2.csv");
  assert.equal(first.mimeType, "text/csv");
  assert.equal(first.sha256, crypto.createHash("sha256").update(body).digest("hex"));
  assert.equal(first.sourceUrl, "https://chatgpt.com/backend-api/files/abc");
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(second.path, "utf8"), body.toString("utf8"));

  const manifestPath = await writeResponseFileManifest(destination, {
    collectionId: "artifact-job",
    conversationUrl: "https://chatgpt.com/c/example",
    files: [first, second],
    errors: [],
    detectedCount: 2,
    expected: true,
  });
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.expected, true);
  assert.equal(manifest.detectedCount, 2);
  assert.deepEqual(
    manifest.files.map((file) => file.name),
    ["bridge-result.csv", "bridge-result-2.csv"],
  );
  assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
});

test("exposes downloaded files, manifests, and inspection screenshots as MCP resources", () => {
  const links = responseResourceLinks({
    screenshotPath: "/tmp/bridge-inspection.png",
    archive: {
      name: "sanitized-repository.zip",
      path: "/tmp/sanitized-repository.zip",
      sizeBytes: 84,
      mimeType: "application/zip",
    },
    manifest: {
      name: "sanitized-repository.manifest.json",
      path: "/tmp/sanitized-repository.manifest.json",
      sizeBytes: 21,
      mimeType: "application/json",
    },
    result: {
      responseFiles: {
        manifestPath: "/tmp/chatgpt-response-manifest.json",
        files: [
          {
            name: "analysis.docx",
            path: "/tmp/analysis.docx",
            sizeBytes: 42,
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    },
  });
  assert.deepEqual(
    links.map((link) => link.name),
    [
      "analysis.docx",
      "chatgpt-response-manifest.json",
      "sanitized-repository.zip",
      "sanitized-repository.manifest.json",
      "bridge-inspection.png",
    ],
  );
  assert.ok(links.every((link) => link.type === "resource_link"));
  assert.ok(links.every((link) => link.uri.startsWith("file:///")));
  assert.equal(links[0].size, 42);
  assert.equal(links[2].mimeType, "application/zip");
  assert.equal(links[4].mimeType, "image/png");
});
