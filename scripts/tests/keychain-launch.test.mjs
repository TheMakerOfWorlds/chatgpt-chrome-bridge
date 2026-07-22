import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeControllerArguments } from "../lib/native-controller.mjs";

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
