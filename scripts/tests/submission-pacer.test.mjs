import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bridgePaths } from "../lib/config.mjs";
import { GlobalSubmissionPacer } from "../lib/submission-pacer.mjs";

test("spaces actual sends across independent bridge workers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-pacer-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = bridgePaths({ CHATGPT_CHROME_BRIDGE_STATE_DIR: root });
  const workerA = new GlobalSubmissionPacer({
    paths,
    workerId: "worker-a",
    pollIntervalMs: 5,
  });
  const workerB = new GlobalSubmissionPacer({
    paths,
    workerId: "worker-b",
    pollIntervalMs: 5,
  });
  const sendTimes = [];
  const submit = (label) => async () => {
    sendTimes.push({ label, at: Date.now() });
    return label;
  };

  const results = await Promise.all([
    workerA.run(submit("a"), { intervalSeconds: 0.08 }),
    workerB.run(submit("b"), { intervalSeconds: 0.08 }),
    workerA.run(submit("c"), { intervalSeconds: 0.08 }),
  ]);

  const ordered = [...sendTimes].sort((a, b) => a.at - b.at);
  assert.equal(ordered.length, 3);
  assert.ok(ordered[1].at - ordered[0].at >= 65);
  assert.ok(ordered[2].at - ordered[1].at >= 65);
  assert.deepEqual(
    results.map((entry) => entry.result).sort(),
    ["a", "b", "c"],
  );
  const status = await workerB.status(0.08);
  assert.equal(status.global, true);
  assert.equal(status.intervalSeconds, 0.08);
  assert.equal(status.lockActive, false);
  assert.ok(status.lastSubmittedAt);
  assert.ok(status.nextAllowedAt);
});

test("enforces the same submission gap across separate processes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-pacer-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pacerModule = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "lib",
      "submission-pacer.mjs",
    ),
  ).href;
  const childCode = `
    import path from "node:path";
    import { GlobalSubmissionPacer } from ${JSON.stringify(pacerModule)};
    const [root, label] = process.argv.slice(1);
    const paths = {
      stateRoot: root,
      submissionPacerFile: path.join(root, "submission-pacer.json"),
      submissionPacerLock: path.join(root, "submission-pacer.lock"),
    };
    const pacer = new GlobalSubmissionPacer({
      paths,
      workerId: label,
      pollIntervalMs: 5,
    });
    const completed = await pacer.run(
      () => ({ label, at: Date.now() }),
      { intervalSeconds: 0.25 },
    );
    process.stdout.write(JSON.stringify(completed.result));
  `;

  const runChild = (label) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", childCode, root, label],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Pacer child ${label} failed: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    });

  const results = await Promise.all([
    runChild("process-a"),
    runChild("process-b"),
    runChild("process-c"),
  ]);
  const ordered = [...results].sort((a, b) => a.at - b.at);
  assert.ok(ordered[1].at - ordered[0].at >= 220);
  assert.ok(ordered[2].at - ordered[1].at >= 220);
});
