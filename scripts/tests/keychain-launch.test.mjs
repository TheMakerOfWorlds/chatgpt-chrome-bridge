import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMacOpenArguments,
  buildNativeControllerArguments,
  chromeApplicationPath,
  parseChromeProcessId,
} from "../lib/native-controller.mjs";

test("native controlled Chrome preserves the macOS keychain and binds DevTools to loopback", () => {
  const args = buildNativeControllerArguments({
    userDataDir: "/private/bridge/User Data",
    profileDirectory: "Profile 1",
    port: 19333,
    background: true,
    url: "https://chatgpt.com/",
  });
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=19333"));
  assert.ok(args.includes("--window-position=-32000,-32000"));
  assert.equal(args.some((arg) => /mock-keychain|password-store|automation/i.test(arg)), false);
});

test("background Chrome uses LaunchServices without taking foreground focus", () => {
  const executable =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const applicationPath = chromeApplicationPath(executable);
  assert.equal(applicationPath, "/Applications/Google Chrome.app");

  const chromeArguments = ["--remote-debugging-port=19333", "https://chatgpt.com/"];
  const openArguments = buildMacOpenArguments({
    applicationPath,
    background: true,
    chromeArguments,
  });
  assert.deepEqual(openArguments.slice(0, 6), [
    "-W",
    "-n",
    "-g",
    "-j",
    "-a",
    "/Applications/Google Chrome.app",
  ]);
  assert.deepEqual(openArguments.slice(6), ["--args", ...chromeArguments]);
});

test("visible Chrome launch intentionally omits the no-focus flag", () => {
  const openArguments = buildMacOpenArguments({
    applicationPath: "/Applications/Google Chrome.app",
    background: false,
    chromeArguments: ["https://chatgpt.com/"],
  });
  assert.equal(openArguments.includes("-g"), false);
  assert.ok(openArguments.includes("-W"));
  assert.ok(openArguments.includes("-n"));
});

test("resolves the controlled Chrome PID from its unique worker arguments", () => {
  const output = [
    "  777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9000 --user-data-dir=/tmp/other",
    " 1234 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=19333 --user-data-dir=/private/bridge/User Data",
  ].join("\n");
  assert.equal(
    parseChromeProcessId(output, {
      port: 19333,
      userDataDir: "/private/bridge/User Data",
    }),
    1234,
  );
  assert.equal(
    parseChromeProcessId(output, {
      port: 19334,
      userDataDir: "/private/bridge/User Data",
    }),
    null,
  );
});


test("worker process matching excludes launchers, helpers and argument prefix collisions", () => {
  const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const identity = { port: 19333, userDataDir: "/private/bridge/User Data", executable };
  for (const command of [
    `${executable} --remote-debugging-port=193330 --user-data-dir=${identity.userDataDir}`,
    `${executable} --remote-debugging-port=19333 --user-data-dir=${identity.userDataDir}-other`,
    `${executable} --remote-debugging-port=19333 --user-data-dir=${identity.userDataDir} backup --profile-directory=Default`,
    `/usr/bin/open -W -a /Applications/Google Chrome.app --args --remote-debugging-port=19333 --user-data-dir=${identity.userDataDir}`,
    `${executable} --type=renderer --remote-debugging-port=19333 --user-data-dir=${identity.userDataDir}`,
    `/tmp/unrelated --remote-debugging-port=19333 --user-data-dir=${identity.userDataDir}`,
  ]) assert.equal(parseChromeProcessId(`42 ${command}`, identity), null, command);
  assert.equal(parseChromeProcessId(`42 ${executable} --user-data-dir=${identity.userDataDir} --profile-directory=Profile 1 --remote-debugging-port=19333 https://chatgpt.com/`, identity), 42);
});
