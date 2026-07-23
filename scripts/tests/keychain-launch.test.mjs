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
  assert.deepEqual(openArguments.slice(0, 5), [
    "-W",
    "-n",
    "-g",
    "-a",
    "/Applications/Google Chrome.app",
  ]);
  assert.deepEqual(openArguments.slice(5), ["--args", ...chromeArguments]);
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
