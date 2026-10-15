import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  launchNativeControlledChrome,
  stopNativeControlledChrome,
} from "../lib/native-controller.mjs";

const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDataDir = "/private/bridge/workers/test/User Data";
const options = {
  executable, userDataDir, profileDirectory: "Profile 1", background: true,
  url: "https://chatgpt.com/", timeoutMs: 200,
};

function nativeFixture({ stubborn = false, ready = false } = {}) {
  let time = 0;
  const signals = [];
  const processes = new Map([
    [51, "/usr/bin/open -W -n -g -j -a /Applications/Google Chrome.app"],
    [52, `${executable} --user-data-dir=${userDataDir} --profile-directory=Profile 1 --remote-debugging-port=19333`],
    [53, `${executable} --user-data-dir=${userDataDir}-other --profile-directory=Profile 1 --remote-debugging-port=19333`],
  ]);
  const launcher = new EventEmitter();
  Object.assign(launcher, { pid: 51, exitCode: null, signalCode: null });
  launcher.kill = (signal) => {
    signals.push([51, signal]);
    processes.delete(51);
    launcher.signalCode = signal;
    launcher.emit("exit", null, signal);
    return true;
  };
  const processList = () => [...processes].map(([pid, command]) => `${pid} ${command}`).join("\n");
  const operations = {
    reservePort: async () => 19333,
    spawn: () => launcher,
    now: () => time,
    sleep: async (ms) => { time += ms; },
    fetch: async () => ready
      ? { ok: true, json: async () => ({ Browser: "Chrome/test" }) }
      : Promise.reject(new Error("endpoint not listening")),
    processList: async () => processList(),
    processListSync: processList,
    signal: (pid, signal) => {
      if (!processes.has(pid)) throw Object.assign(new Error("not running"), { code: "ESRCH" });
      if (signal === 0) return true;
      signals.push([pid, signal]);
      if (!stubborn) processes.delete(pid);
      return true;
    },
  };
  return { operations, processes, signals, launcher };
}

test("a DevTools startup timeout stops the real Chrome process and confirms cleanup", async () => {
  const fixture = nativeFixture();
  await assert.rejects(launchNativeControlledChrome(options, fixture.operations), (error) => {
    assert.match(error.message, /Timed out waiting/);
    assert.equal(error.nativeChromeCleanupConfirmed, true);
    return true;
  });
  assert.deepEqual(fixture.signals, [[51, "SIGTERM"], [52, "SIGTERM"]]);
  assert.equal(fixture.processes.has(52), false);
  assert.equal(fixture.processes.has(53), true);
});

test("failed startup retains recoverable launch metadata if Chrome cannot be stopped", async () => {
  const fixture = nativeFixture({ stubborn: true });
  await assert.rejects(launchNativeControlledChrome(options, fixture.operations), (error) => {
    assert.equal(error.nativeChromeCleanupConfirmed, false);
    assert.match(error.message, /profile was retained/);
    assert.equal(error.nativeChromeLaunch.userDataDir, userDataDir);
    assert.equal(error.nativeChromeLaunch.executable, executable);
    return true;
  });
  assert.ok(fixture.signals.some(([pid, signal]) => pid === 52 && signal === "SIGKILL"));
  assert.equal(fixture.processes.has(53), true);
});

test("process inventory failure cannot be reported as successful cleanup", async () => {
  const fixture = nativeFixture({ ready: true });
  fixture.operations.processList = async () => { throw new Error("process inspection denied"); };
  await assert.rejects(launchNativeControlledChrome(options, fixture.operations), (error) => {
    assert.equal(error.nativeChromeCleanupConfirmed, false);
    assert.match(error.nativeChromeCleanupError, /process inspection denied/);
    return true;
  });
  assert.equal(fixture.processes.has(52), true);
});

test("the native controller tracks Chrome after open exits and refuses a reused PID", async () => {
  const fixture = nativeFixture({ ready: true });
  const launched = await launchNativeControlledChrome(options, fixture.operations);
  fixture.launcher.exitCode = 0;
  fixture.processes.delete(51);
  assert.equal(launched.child.pid, 52);
  assert.equal(launched.child.exitCode, null);
  fixture.processes.set(52, "/usr/bin/unrelated");
  assert.equal(launched.child.kill("SIGTERM"), false);
  assert.deepEqual(fixture.signals, []);
  fixture.processes.delete(52);
  assert.equal(launched.child.exitCode, 0);
});

test("CDP failure cleanup works even if the launcher has already exited", async () => {
  const fixture = nativeFixture({ ready: true });
  const launched = await launchNativeControlledChrome(options, fixture.operations);
  fixture.launcher.exitCode = 0;
  fixture.processes.delete(51);
  assert.deepEqual(await stopNativeControlledChrome(launched, fixture.operations), { stopped: true });
  assert.deepEqual(fixture.signals, [[52, "SIGTERM"]]);
  assert.equal(fixture.processes.has(53), true);
});

test("pre-spawn failures permit removal of an unused worker profile", async () => {
  const fixture = nativeFixture();
  for (const overrides of [
    { reservePort: async () => { throw new Error("no port"); } },
    { spawn: () => { throw new Error("spawn failed"); } },
  ]) {
    await assert.rejects(launchNativeControlledChrome(options, { ...fixture.operations, ...overrides }), (error) => {
      assert.equal(error.nativeChromeCleanupConfirmed, true);
      return true;
    });
  }
  assert.deepEqual(fixture.signals, []);
});

test("an asynchronous spawn error is handled without an uncaught error event", async () => {
  const fixture = nativeFixture();
  fixture.processes.delete(52);
  fixture.operations.spawn = () => {
    queueMicrotask(() => {
      fixture.processes.delete(51);
      fixture.launcher.pid = undefined;
      fixture.launcher.emit("error", new Error("executable unavailable"));
    });
    return fixture.launcher;
  };
  await assert.rejects(launchNativeControlledChrome(options, fixture.operations), (error) => {
    assert.match(error.message, /executable unavailable/);
    assert.equal(error.nativeChromeCleanupConfirmed, true);
    return true;
  });
});


test("an unobserved pending LaunchServices request stays protected across cleanup retries", async () => {
  const fixture = nativeFixture();
  const chromeCommand = fixture.processes.get(52);
  fixture.processes.delete(52);
  let pending;
  await assert.rejects(launchNativeControlledChrome(options, fixture.operations), (error) => {
    assert.equal(error.nativeChromeCleanupConfirmed, false);
    assert.match(error.nativeChromeCleanupError, /pending Chrome launch/);
    assert.equal(error.nativeChromeLaunch.userDataDir, userDataDir);
    pending = error.nativeChromeLaunch;
    return true;
  });
  assert.equal(pending.pendingLaunchUnverified, true);
  assert.equal(fixture.processes.has(51), false);
  await assert.rejects(stopNativeControlledChrome(pending, fixture.operations), (error) => {
    assert.equal(error.nativeChromeCleanupConfirmed, false);
    assert.match(error.message, /pending Chrome launch/);
    return true;
  });
  assert.equal(pending.pendingLaunchUnverified, true);

  // A delayed matching Chrome can still be safely stopped on a later retry.
  fixture.processes.set(52, chromeCommand);
  assert.deepEqual(await stopNativeControlledChrome(pending, fixture.operations), { stopped: true });
  assert.equal(pending.pendingLaunchUnverified, false);
  assert.equal(fixture.processes.has(52), false);
  assert.equal(fixture.processes.has(53), true);
});
