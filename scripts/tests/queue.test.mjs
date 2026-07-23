import assert from "node:assert/strict";
import test from "node:test";

import { AskJobQueue } from "../lib/bridge.mjs";

test("runs multiple ChatGPT jobs concurrently up to the configured limit", async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const bridge = {
    config: { maxConcurrent: 2 },
    async ask({ label }) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { response: label };
    },
  };
  const queue = new AskJobQueue(bridge);
  const first = queue.create({ label: "one" });
  const second = queue.create({ label: "two" });
  const third = queue.create({ label: "three" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.summary(), {
    maxConcurrent: 2,
    running: 2,
    queued: 1,
    completed: 0,
    failed: 0,
    phases: { preparing: 2, queued: 1 },
  });
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.summary().running, 2);
  assert.equal(queue.summary().queued, 0);
  releases.splice(0).forEach((release) => release());

  const results = await Promise.all([
    queue.wait(first.id, 2),
    queue.wait(second.id, 2),
    queue.wait(third.id, 2),
  ]);
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((job) => job.status),
    ["completed", "completed", "completed"],
  );
});

test("supports a 30-tab worker limit while queueing overflow", async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const bridge = {
    config: { maxConcurrent: 30 },
    async ask({ label }) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { response: label };
    },
  };
  const queue = new AskJobQueue(bridge);
  const jobs = Array.from({ length: 31 }, (_, index) =>
    queue.create({ label: `job-${index + 1}` }),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.summary().maxConcurrent, 30);
  assert.equal(queue.summary().running, 30);
  assert.equal(queue.summary().queued, 1);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.summary().running, 30);
  assert.equal(queue.summary().queued, 0);

  releases.splice(0).forEach((release) => release());
  const results = await Promise.all(jobs.map((job) => queue.wait(job.id, 2)));
  assert.equal(peak, 30);
  assert.ok(results.every((job) => job.status === "completed"));
  const listed = queue.list({ status: "completed" });
  assert.equal(listed.length, 31);
  assert.ok(listed.every((job) => job.phase === "completed"));
  assert.ok(listed.every((job) => job.result?.response === undefined));
});

test("exposes nonblocking preparation, pacing, and generation phases", async () => {
  let releasePacer;
  let releaseGeneration;
  const pacerGate = new Promise((resolve) => {
    releasePacer = resolve;
  });
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const bridge = {
    config: { maxConcurrent: 1 },
    async ask({ onPhase }) {
      onPhase("waiting_to_submit", {
        pacing: { intervalSeconds: 5, nextTurnAt: "future" },
      });
      await pacerGate;
      onPhase("generating", {
        submission: { intervalSeconds: 5, submittedAt: "now" },
        conversationUrl: "https://chatgpt.com/c/test",
        progress: {
          preview: "I am still researching the complete answer.",
          looksInterim: true,
          active: true,
        },
      });
      await generationGate;
      onPhase("collecting_files", {
        conversationUrl: "https://chatgpt.com/c/test",
        progress: {
          preview: "Final answer with report.",
          looksInterim: false,
          active: false,
          terminalCandidate: true,
        },
      });
      return {
        response: "done",
        conversationUrl: "https://chatgpt.com/c/test",
        elapsedMs: 100,
        responseFiles: {
          status: "downloaded",
          expected: true,
          detectedCount: 1,
          outputDirectory: "/tmp/chatgpt-files",
          manifestPath: "/tmp/chatgpt-files/manifest.json",
          totalBytes: 12,
          files: [
            {
              name: "report.csv",
              path: "/tmp/chatgpt-files/report.csv",
              sizeBytes: 12,
              sha256: "abc",
              mimeType: "text/csv",
              discoveryMethod: "chatgpt-download-control",
            },
          ],
          errors: [],
          inspectionRecommended: false,
        },
      };
    },
  };
  const queue = new AskJobQueue(bridge);
  const created = queue.create({
    jobLabel: "Status-visible research",
    prompt: "Research something.",
  });

  await new Promise((resolve) => setImmediate(resolve));
  let listed = queue.list();
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].label, "Status-visible research");
  assert.equal(listed[0].phase, "waiting_to_submit");
  assert.equal(listed[0].pacing.intervalSeconds, 5);

  releasePacer();
  await new Promise((resolve) => setImmediate(resolve));
  listed = queue.list();
  assert.equal(listed[0].phase, "generating");
  assert.equal(listed[0].submission.submittedAt, "now");
  assert.equal(listed[0].conversationUrl, "https://chatgpt.com/c/test");
  assert.equal(listed[0].progress.looksInterim, true);

  releaseGeneration();
  const completed = await queue.wait(created.id, 2);
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.result.response, "done");
  assert.equal(completed.responseFiles.status, "downloaded");
  assert.equal(completed.result.responseFiles.files[0].name, "report.csv");
  const summarized = queue.list()[0].result.responseFiles;
  assert.equal(summarized.files[0].path, "/tmp/chatgpt-files/report.csv");
  assert.equal(summarized.errorCount, 0);
});

test("retains terminal job records for 24 hours", () => {
  const queue = new AskJobQueue({ config: { maxConcurrent: 1 } });
  queue.jobs.set("recent", {
    status: "completed",
    completedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
  });
  queue.jobs.set("expired", {
    status: "failed",
    completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });

  queue.prune();

  assert.equal(queue.jobs.has("recent"), true);
  assert.equal(queue.jobs.has("expired"), false);
});

test("closes the browser to persist session state when the queue becomes idle", async () => {
  let closeCalls = 0;
  const bridge = {
    config: { maxConcurrent: 1 },
    async ask() {
      return { response: "done" };
    },
    async closeBrowser() {
      closeCalls += 1;
    },
  };
  const queue = new AskJobQueue(bridge);
  const created = queue.create({ prompt: "Test persistence." });

  const completed = await queue.wait(created.id, 2);
  assert.equal(completed.status, "completed");
  assert.equal(closeCalls, 1);
});
