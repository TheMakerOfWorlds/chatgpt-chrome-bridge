import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_ATTACHMENTS,
  prepareAttachments,
  validateAttachmentPaths,
} from "../lib/attachments.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-attachments-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("requires exact regular, non-secret, supported absolute file paths", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "folder");
  const secret = path.join(root, ".env.production");
  const unsupported = path.join(root, "program.exe");
  await fs.mkdir(directory);
  await fs.writeFile(secret, "TOKEN=do-not-send");
  await fs.writeFile(unsupported, "archive");

  await assert.rejects(validateAttachmentPaths(["relative.txt"]), /must be absolute/);
  await assert.rejects(validateAttachmentPaths([directory]), /regular files/);
  await assert.rejects(validateAttachmentPaths([secret]), /credentials, keys/);
  await assert.rejects(validateAttachmentPaths([unsupported]), /Unsupported attachment type/);
  await assert.rejects(
    validateAttachmentPaths(
      Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) =>
        path.join(root, `file-${index}.txt`),
      ),
    ),
    /At most 10 files/,
  );
});

test("accepts a prepared ZIP as one bounded ChatGPT attachment", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "sanitized-repository.zip");
  await fs.writeFile(archive, "zip-fixture");
  const validated = await validateAttachmentPaths([archive]);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].category, "archive");
  assert.equal(validated[0].originalExtension, ".zip");
});

test("stages HEIC as a temporary JPEG, reports it, and preserves originals", async (t) => {
  const root = await fixture(t);
  const stateRoot = path.join(root, "State");
  const heic = path.join(root, "Chair Photo.HEIC");
  const notes = path.join(root, "notes.txt");
  await fs.writeFile(heic, "fake-heic-image-bytes");
  await fs.writeFile(notes, "context notes");

  const prepared = await prepareAttachments([heic, notes], {
    stateRoot,
    workerId: "worker/test",
    convertHeic: (source, destination) => fs.copyFile(source, destination),
  });

  assert.equal(prepared.attachments.length, 2);
  const converted = prepared.attachments[0];
  assert.equal(converted.converted, true);
  assert.equal(converted.uploadExtension, ".jpg");
  assert.match(converted.uploadName, /^Chair-Photo-chatgpt-1\.jpg$/);
  assert.equal(await fs.readFile(converted.uploadPath, "utf8"), "fake-heic-image-bytes");
  assert.equal(await fs.readFile(heic, "utf8"), "fake-heic-image-bytes");
  assert.equal(prepared.attachments[1].uploadPath, notes);
  assert.deepEqual(prepared.publicAttachments[0], {
    originalPath: heic,
    originalName: "Chair Photo.HEIC",
    originalFormat: "HEIC",
    originalSizeBytes: 21,
    sentName: "Chair-Photo-chatgpt-1.jpg",
    sentFormat: "JPG",
    sentSizeBytes: 21,
    category: "image",
    converted: true,
    conversion: "Temporary local HEIC/HEIF-to-JPEG conversion; original unchanged",
  });

  const stagingDirectory = prepared.stagingDirectory;
  await fs.access(stagingDirectory);
  await prepared.cleanup();
  await assert.rejects(fs.access(stagingDirectory));
  await fs.access(heic);
  await fs.access(notes);
});

test("does not create a staging directory when all files are directly supported", async (t) => {
  const root = await fixture(t);
  const image = path.join(root, "chair.jpg");
  await fs.writeFile(image, "jpeg-data");
  const prepared = await prepareAttachments([image], {
    stateRoot: path.join(root, "State"),
  });
  assert.equal(prepared.stagingDirectory, null);
  assert.equal(prepared.attachments[0].uploadPath, image);
  assert.equal(prepared.publicAttachments[0].converted, false);
  await prepared.cleanup();
  await fs.access(image);
});
