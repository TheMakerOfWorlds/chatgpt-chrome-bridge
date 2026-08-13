import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatGptChromeBridge } from "../lib/bridge.mjs";

test("prunes stale internal inspection screenshots without deleting referenced or downloaded files", async (t) => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "chatgpt-retention-test-"),
  );
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const inspectionRoot = path.join(stateRoot, "inspections");
  const responseRoot = path.join(stateRoot, "response-files", "completed");
  await fs.mkdir(inspectionRoot, { recursive: true });
  await fs.mkdir(responseRoot, { recursive: true });
  const protectedScreenshot = path.join(inspectionRoot, "protected.png");
  const staleScreenshot = path.join(inspectionRoot, "stale.png");
  const currentScreenshot = path.join(inspectionRoot, "current.png");
  const downloadedFile = path.join(responseRoot, "report.pdf");
  await Promise.all([
    fs.writeFile(protectedScreenshot, "protected"),
    fs.writeFile(staleScreenshot, "stale"),
    fs.writeFile(currentScreenshot, "current"),
    fs.writeFile(downloadedFile, "user artifact"),
  ]);
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(protectedScreenshot, oldTime, oldTime);
  await fs.utimes(staleScreenshot, oldTime, oldTime);

  const bridge = new ChatGptChromeBridge({
    paths: {
      stateRoot,
      conversationLocksRoot: path.join(stateRoot, "conversation-locks"),
    },
    workerId: "retention-test",
  });
  bridge.conversationRecords.set("referenced-job", {
    jobId: "referenced-job",
    status: "completed",
    inspectionScreenshotPath: protectedScreenshot,
    updatedAt: new Date().toISOString(),
  });

  const result = await bridge.pruneInspectionArtifacts({
    now: Date.now(),
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxFiles: 1,
  });
  assert.equal(result.removedFiles, 1);
  await fs.access(protectedScreenshot);
  await assert.rejects(fs.access(staleScreenshot));
  await fs.access(currentScreenshot);
  await fs.access(downloadedFile);
});
