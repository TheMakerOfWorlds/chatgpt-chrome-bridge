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
  const summary = queue.summary();
  assert.equal(summary.maxConcurrent, 2);
  assert.equal(summary.running, 2);
  assert.equal(summary.queued, 1);
  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.phases, { preparing: 2, queued: 1 });
  assert.equal(summary.retention.terminalHours, 24);
  assert.equal(summary.retention.maxTerminalJobs, 200);
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

test("creates chained reply jobs with exact conversation lineage", async () => {
  const asks = [];
  const conversationUrl =
    "https://chatgpt.com/g/g-p-project/c/6a5eac19-a42c-83ea-a20a-c7abf06dc278";
  const bridge = {
    config: { maxConcurrent: 2 },
    async ask(params) {
      asks.push(params);
      params.onPhase("generating", { conversationUrl });
      return {
        response: `response-${asks.length}`,
        conversationUrl,
        profile: { directory: "Profile 1" },
      };
    },
    async closeBrowserIfIdle() {},
    getConversationRecord() {
      return null;
    },
  };
  const queue = new AskJobQueue(bridge);
  const initial = queue.create({ prompt: "Initial question", newChat: true });
  const initialResult = await queue.wait(initial.id, 2);
  assert.equal(initialResult.status, "completed");
  assert.equal(initialResult.continuation, false);
  assert.equal(initialResult.rootJobId, initial.id);
  assert.equal(initialResult.replyDepth, 0);

  const reply = queue.createReply({
    sourceJobId: initial.id,
    prompt: "Add this new information.",
  });
  assert.notEqual(reply.id, initial.id);
  assert.equal(reply.continuation, true);
  assert.equal(reply.parentJobId, initial.id);
  assert.equal(reply.rootJobId, initial.id);
  assert.equal(reply.replyDepth, 1);
  assert.equal(reply.conversationUrl, conversationUrl);
  const replyResult = await queue.wait(reply.id, 2);
  assert.equal(replyResult.status, "completed");
  assert.equal(asks[1].conversationUrl, conversationUrl);
  assert.equal(asks[1].newChat, false);
  assert.equal(asks[1].parentJobId, initial.id);

  const secondReply = queue.createReply({
    sourceJobId: reply.id,
    prompt: "One more follow-up.",
  });
  assert.equal(secondReply.parentJobId, reply.id);
  assert.equal(secondReply.rootJobId, initial.id);
  assert.equal(secondReply.replyDepth, 2);
  await queue.wait(secondReply.id, 2);
});

test("rejects replies to nonterminal or failed jobs", () => {
  const queue = new AskJobQueue({ config: { maxConcurrent: 1 } });
  queue.jobs.set("running-source", {
    id: "running-source",
    status: "running",
    phase: "generating",
  });
  queue.jobs.set("failed-source", {
    id: "failed-source",
    status: "failed",
    phase: "failed",
    completedAt: new Date().toISOString(),
  });
  assert.throws(
    () =>
      queue.createReply({
        sourceJobId: "running-source",
        prompt: "Too early",
      }),
    /Only a completed job can be continued/,
  );
  assert.throws(
    () =>
      queue.createReply({
        sourceJobId: "failed-source",
        prompt: "Uncertain website state",
      }),
    /Only a completed job can be continued/,
  );
});

test("serializes same-conversation replies while running other conversations", async () => {
  const activeByConversation = new Map();
  const peakByConversation = new Map();
  const releases = new Map();
  const bridge = {
    config: { maxConcurrent: 3 },
    async ask({ prompt, conversationUrl }) {
      const active = (activeByConversation.get(conversationUrl) || 0) + 1;
      activeByConversation.set(conversationUrl, active);
      peakByConversation.set(
        conversationUrl,
        Math.max(peakByConversation.get(conversationUrl) || 0, active),
      );
      await new Promise((resolve) => releases.set(prompt, resolve));
      activeByConversation.set(conversationUrl, active - 1);
      return { response: prompt, conversationUrl };
    },
    async closeBrowserIfIdle() {},
    getConversationRecord() {
      return null;
    },
  };
  const queue = new AskJobQueue(bridge);
  const sameUrl = "https://chatgpt.com/c/same-conversation";
  const otherUrl = "https://chatgpt.com/c/other-conversation";
  const first = queue.createReply({ conversationUrl: sameUrl, prompt: "first" });
  const second = queue.createReply({ conversationUrl: sameUrl, prompt: "second" });
  const other = queue.createReply({ conversationUrl: otherUrl, prompt: "other" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.summary().running, 2);
  assert.equal(queue.summary().queued, 1);
  assert.equal(releases.has("first"), true);
  assert.equal(releases.has("other"), true);
  assert.equal(releases.has("second"), false);

  releases.get("first")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.has("second"), true);
  releases.get("second")();
  releases.get("other")();
  await Promise.all([
    queue.wait(first.id, 2),
    queue.wait(second.id, 2),
    queue.wait(other.id, 2),
  ]);
  assert.equal(peakByConversation.get(sameUrl), 1);
});

test("caps terminal records, preserves active lineage, and forgets paired conversations", () => {
  const forgotten = [];
  const bridge = {
    config: { maxConcurrent: 1 },
    forgetConversation(id) {
      forgotten.push(id);
    },
  };
  const queue = new AskJobQueue(bridge);
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    const id = `terminal-${index}`;
    queue.jobs.set(id, {
      id,
      status: "completed",
      completedAt: new Date(now - index * 1_000).toISOString(),
      createdAt: new Date(now - index * 1_000).toISOString(),
    });
  }
  queue.jobs.set("active-reply", {
    id: "active-reply",
    status: "running",
    parentJobId: "terminal-3",
    rootJobId: "terminal-3",
  });

  const retention = queue.prune({
    now,
    maxAgeMs: 60_000,
    maxTerminalJobs: 1,
  });
  assert.equal(queue.jobs.has("terminal-0"), true);
  assert.equal(queue.jobs.has("terminal-3"), true, "active ancestor is protected");
  assert.equal(queue.jobs.has("terminal-1"), false);
  assert.equal(queue.jobs.has("terminal-2"), false);
  assert.deepEqual(new Set(forgotten), new Set(["terminal-1", "terminal-2"]));
  assert.equal(retention.removedJobIds.length, 2);
});

test("closes the browser to persist session state when the queue becomes idle", async () => {
  let closeCalls = 0;
  const bridge = {
    config: { maxConcurrent: 1 },
    async ask() {
      return { response: "done" };
    },
    async closeBrowserIfIdle() {
      closeCalls += 1;
      return { closed: true, reason: "idle" };
    },
    async closeBrowser() {
      throw new Error("queue should use activity-aware idle close");
    },
  };
  const queue = new AskJobQueue(bridge);
  const created = queue.create({ prompt: "Test persistence." });

  const completed = await queue.wait(created.id, 2);
  assert.equal(completed.status, "completed");
  assert.equal(closeCalls, 1);
});
