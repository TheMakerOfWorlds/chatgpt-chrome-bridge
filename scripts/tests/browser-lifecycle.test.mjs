import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ChatGptChromeBridge } from "../lib/bridge.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("keeps Chrome alive while an operation is active and closes it after idle", async () => {
  const bridge = new ChatGptChromeBridge({ browserIdleCloseMs: 20 });
  bridge.context = {};
  let closeCalls = 0;
  bridge.closeBrowser = async () => {
    bridge.cancelBrowserIdleClose();
    closeCalls += 1;
    bridge.context = null;
    return { closed: true, persistedSession: false };
  };

  const release = bridge.acquireBrowserActivity();
  assert.deepEqual(await bridge.closeBrowserIfIdle(), {
    closed: false,
    reason: "active-operations",
  });
  await delay(35);
  assert.equal(closeCalls, 0);

  release();
  await delay(45);
  assert.equal(closeCalls, 1);
  assert.equal(bridge.browserActivityCount, 0);
});

test("a new operation cancels a pending idle close", async () => {
  const bridge = new ChatGptChromeBridge({ browserIdleCloseMs: 25 });
  bridge.context = {};
  let closeCalls = 0;
  bridge.closeBrowser = async () => {
    bridge.cancelBrowserIdleClose();
    closeCalls += 1;
    bridge.context = null;
    return { closed: true, persistedSession: false };
  };

  const releaseFirst = bridge.acquireBrowserActivity();
  releaseFirst();
  assert.equal(bridge.browserIdleCloseTimer !== null, true);

  const releaseSecond = bridge.acquireBrowserActivity();
  await delay(40);
  assert.equal(closeCalls, 0);

  releaseSecond();
  await delay(50);
  assert.equal(closeCalls, 1);
});

test("graceful shutdown sends Browser.close once and serializes callers", async () => {
  const bridge = new ChatGptChromeBridge();
  const processController = new EventEmitter();
  processController.exitCode = null;
  processController.kill = () => {
    throw new Error("signal fallback should not be needed");
  };

  let browserCloseCommands = 0;
  let connectionCloseCalls = 0;
  bridge.browserProcess = processController;
  bridge.browserConnection = {
    async newBrowserCDPSession() {
      return {
        async send(method) {
          assert.equal(method, "Browser.close");
          browserCloseCommands += 1;
          processController.exitCode = 0;
          processController.emit("exit", 0, null);
        },
        async detach() {},
      };
    },
    async close() {
      connectionCloseCalls += 1;
    },
  };
  bridge.context = {};

  const [first, second] = await Promise.all([
    bridge.closeBrowser(),
    bridge.closeBrowser(),
  ]);
  assert.deepEqual(first, { closed: true, persistedSession: false });
  assert.deepEqual(second, first);
  assert.equal(browserCloseCommands, 1);
  assert.equal(connectionCloseCalls, 1);
  assert.equal(bridge.context, null);
  assert.ok(bridge.lastBrowserClosedAt);
});

test("failed startup cleanup preserves the worker until Chrome is verified stopped", async () => {
  const bridge = new ChatGptChromeBridge();
  const runtime = { root: "/private/worker", userDataDir: "/private/worker/User Data" };
  const failedLaunch = { userDataDir: runtime.userDataDir };
  bridge.workerRuntime = runtime;
  bridge.failedBrowserLaunch = failedLaunch;
  let removed = 0;
  bridge.profileStore.removeWorker = async value => {
    assert.equal(value, runtime);
    removed += 1;
  };
  bridge.profileStore.pruneCaches = async () => {};
  bridge.stopNativeChrome = async () => { throw new Error("Chrome still running"); };

  await assert.rejects(bridge.closeBrowser(), /Chrome still running/);
  assert.equal(removed, 0);
  assert.equal(bridge.workerRuntime, runtime);
  assert.equal(bridge.failedBrowserLaunch, failedLaunch);

  bridge.stopNativeChrome = async value => {
    assert.equal(value, failedLaunch);
    return { stopped: true };
  };
  await bridge.closeBrowser();
  assert.equal(removed, 1);
  assert.equal(bridge.workerRuntime, null);
  assert.equal(bridge.failedBrowserLaunch, null);
});

test("startup failure without cleanup metadata cannot delete a possibly live profile", async () => {
  const bridge = new ChatGptChromeBridge();
  const runtime = { root: "/private/worker" };
  bridge.workerRuntime = runtime;
  bridge.failedBrowserLaunch = {};
  bridge.profileStore.removeWorker = async () => { assert.fail("profile must be retained"); };
  await assert.rejects(bridge.closeBrowser(), /no verified cleanup metadata/);
  assert.equal(bridge.workerRuntime, runtime);
});
