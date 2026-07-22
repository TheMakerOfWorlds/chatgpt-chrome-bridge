import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeLoginArguments } from "../lib/native-login.mjs";

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
