import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GlobalConversationLock } from "../lib/conversation-lock.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("serializes URL variants for one conversation and keeps a live lease fresh", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-lock-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { conversationLocksRoot: path.join(root, "locks") };
  const firstLock = new GlobalConversationLock({
    paths,
    workerId: "worker-one",
    pollMs: 25,
    staleMs: 1_000,
    heartbeatMs: 250,
  });
  const secondLock = new GlobalConversationLock({
    paths,
    workerId: "worker-two",
    pollMs: 25,
    staleMs: 1_000,
    heartbeatMs: 250,
  });
  const conversationId = "6a5eac19-a42c-83ea-a20a-c7abf06dc278";
  const firstLease = await firstLock.acquire(
    `https://chatgpt.com/g/g-p-project/c/${conversationId}`,
    { timeoutMs: 3_000, jobId: "first" },
  );
  let secondAcquired = false;
  const secondLeasePromise = secondLock
    .acquire(`https://chatgpt.com/c/${conversationId}`, {
      timeoutMs: 3_000,
      jobId: "second",
    })
    .then((lease) => {
      secondAcquired = true;
      return lease;
    });

  await delay(1_250);
  assert.equal(secondAcquired, false, "heartbeat lease must not look stale");
  await firstLease.release();
  const secondLease = await secondLeasePromise;
  assert.equal(secondAcquired, true);
  assert.ok(secondLease.waitedMs >= 1_000);
  await secondLease.release();
  assert.deepEqual(await fs.readdir(paths.conversationLocksRoot), []);
});

test("reclaims an abandoned stale conversation lease", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-lock-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { conversationLocksRoot: path.join(root, "locks") };
  const lock = new GlobalConversationLock({
    paths,
    workerId: "replacement-worker",
    pollMs: 25,
    staleMs: 1_000,
    heartbeatMs: 250,
  });
  const url = "https://chatgpt.com/c/abandoned-conversation";
  const staleDirectory = lock.lockDirectory(url);
  await fs.mkdir(staleDirectory, { recursive: true });
  await fs.writeFile(
    path.join(staleDirectory, "owner.json"),
    '{"token":"dead-worker"}\n',
  );
  const staleTime = new Date(Date.now() - 2_000);
  await fs.utimes(staleDirectory, staleTime, staleTime);

  const lease = await lock.acquire(url, { timeoutMs: 2_000 });
  assert.ok(lease.waitedMs < 1_000);
  await lease.release();
});

test("serializes concurrent attempts to reclaim one abandoned lease", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-lock-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { conversationLocksRoot: path.join(root, "locks") };
  const firstLock = new GlobalConversationLock({
    paths,
    workerId: "reclaimer-one",
    pollMs: 25,
    staleMs: 1_000,
    heartbeatMs: 250,
  });
  const secondLock = new GlobalConversationLock({
    paths,
    workerId: "reclaimer-two",
    pollMs: 25,
    staleMs: 1_000,
    heartbeatMs: 250,
  });
  const url = "https://chatgpt.com/c/concurrent-stale-reclaim";
  const staleDirectory = firstLock.lockDirectory(url);
  await fs.mkdir(staleDirectory, { recursive: true });
  await fs.writeFile(
    path.join(staleDirectory, "owner.json"),
    '{"token":"abandoned","processId":99999999}\n',
  );
  const staleTime = new Date(Date.now() - 2_000);
  await fs.utimes(staleDirectory, staleTime, staleTime);

  let acquiredCount = 0;
  const firstPromise = firstLock
    .acquire(url, { timeoutMs: 4_000 })
    .then((lease) => {
      acquiredCount += 1;
      return lease;
    });
  const secondPromise = secondLock
    .acquire(url, { timeoutMs: 4_000 })
    .then((lease) => {
      acquiredCount += 1;
      return lease;
    });
  const firstLease = await Promise.race([firstPromise, secondPromise]);
  await delay(1_250);
  assert.equal(
    acquiredCount,
    1,
    "a second reclaimer must not remove the replacement live lease",
  );
  await firstLease.release();
  const leases = await Promise.all([firstPromise, secondPromise]);
  const secondLease = leases.find((lease) => lease !== firstLease);
  assert.ok(secondLease);
  await secondLease.release();
  assert.deepEqual(await fs.readdir(paths.conversationLocksRoot), ["reclaim.lock"]);
});
