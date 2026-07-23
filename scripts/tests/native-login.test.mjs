import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildNativeLoginArguments,
  waitForNativeLoginStartup,
} from "../lib/native-login.mjs";

test("native login uses the isolated profile without automation flags", () => {
  const args = buildNativeLoginArguments({
    userDataDir: "/private/bridge/User Data",
    profileDirectory: "Profile 1",
    url: "https://chatgpt.com/",
  });
  assert.ok(args.includes("--user-data-dir=/private/bridge/User Data"));
  assert.ok(args.includes("--profile-directory=Profile 1"));
  assert.ok(args.includes("--new-window"));
  assert.ok(args.includes("https://chatgpt.com/"));
  assert.equal(args.some((arg) => /automation|remote-debugging/i.test(arg)), false);
});

test("rejects a native login Chrome process that exits during startup", async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  setImmediate(() => {
    child.exitCode = 21;
    child.emit("exit", 21, null);
  });

  await assert.rejects(
    waitForNativeLoginStartup(child, { graceMs: 100 }),
    /exited before its window was ready.*Another bridge login Chrome process/s,
  );
});

test("accepts a native login Chrome process that survives startup", async () => {
  const child = new EventEmitter();
  child.pid = 5678;
  child.exitCode = null;
  child.signalCode = null;

  assert.equal(
    await waitForNativeLoginStartup(child, { graceMs: 5 }),
    child,
  );
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});
