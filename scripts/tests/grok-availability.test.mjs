import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateGrokAvailability,
  loadGrokAvailability,
  markGrokAvailable,
  markGrokUnavailable,
  markGrokUnknown,
} from "../lib/grok-availability.mjs";
import { GrokChromeBridge } from "../lib/grok-bridge.mjs";
import { grokBridgePaths } from "../lib/grok-config.mjs";

async function fixture(t) {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-availability-test-"),
  );
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  return grokBridgePaths({
    GROK_CHROME_BRIDGE_STATE_DIR: stateRoot,
    GROK_CHROME_USER_DATA_DIR: path.join(stateRoot, "chrome"),
  });
}

test("tracks unknown, fresh, stale, unavailable, and recovery states", async (t) => {
  const paths = await fixture(t);
  const initial = evaluateGrokAvailability(
    await loadGrokAvailability(paths),
  );
  assert.equal(initial.state, "unknown");
  assert.equal(initial.available, false);
  assert.equal(initial.needsVerification, true);
  assert.equal(initial.recommendedAction, "verify_once");

  const availableRecord = await markGrokAvailable(paths, {
    source: "test",
    profile: "Profile 1",
    projectUrl: "https://grok.com/project/example",
    modelOptions: ["Fast", "Heavy"],
  });
  const fresh = evaluateGrokAvailability(availableRecord, {
    maxAgeSeconds: 900,
  });
  assert.equal(fresh.state, "available");
  assert.equal(fresh.available, true);
  assert.equal(fresh.recommendedAction, "use_grok");
  assert.deepEqual(fresh.modelOptions, ["Fast", "Heavy"]);

  const stale = evaluateGrokAvailability(availableRecord, {
    maxAgeSeconds: 60,
    now: Date.parse(availableRecord.lastCheckedAt) + 61_000,
  });
  assert.equal(stale.state, "stale");
  assert.equal(stale.available, false);
  assert.equal(stale.needsVerification, true);

  const unavailableRecord = await markGrokUnavailable(paths, {
    source: "test",
    profile: "Profile 1",
    reasonCode: "signed_out",
    reason: "The configured Grok browser session is signed out.",
  });
  const unavailable = evaluateGrokAvailability(unavailableRecord);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.needsVerification, false);
  assert.equal(unavailable.recommendedAction, "skip_grok");
  assert.match(unavailable.recovery.action, /Do not retry/);

  const unknownRecord = await markGrokUnknown(paths, {
    source: "test",
    reasonCode: "configuration_changed",
  });
  const unknown = evaluateGrokAvailability(unknownRecord);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.reasonCode, "configuration_changed");
  assert.equal(unknown.lastCheckedAt, null);

  const stat = await fs.stat(paths.availabilityFile);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("known unavailability fails fast without opening a browser", async (t) => {
  const paths = await fixture(t);
  await markGrokUnavailable(paths, {
    reasonCode: "signed_out",
    reason: "Signed out for test.",
  });
  const bridge = new GrokChromeBridge({ paths });
  let verifications = 0;
  bridge.verifyAvailability = async () => {
    verifications += 1;
    throw new Error("must not verify");
  };

  await assert.rejects(
    bridge.ensureAvailableForUse(),
    /marked unavailable.*Do not retry/s,
  );
  assert.equal(verifications, 0);
  assert.equal(bridge.context, null);
});

test("a recorded logout stays latched until an explicit recovery check", async (t) => {
  const paths = await fixture(t);
  await markGrokUnavailable(paths, {
    reasonCode: "signed_out",
    reason: "Signed out for test.",
  });
  const bridge = new GrokChromeBridge({ paths });

  const passive = await bridge.recordAuthentication(
    { authenticated: true, reason: "composer-visible" },
    { source: "passive_status" },
  );
  assert.equal(passive.state, "unavailable");
  assert.equal(passive.reasonCode, "signed_out");

  const recovered = await bridge.recordAuthentication(
    { authenticated: true, reason: "composer-visible" },
    {
      source: "explicit_verification",
      allowUnavailableRecovery: true,
    },
  );
  assert.equal(recovered.state, "available");
  assert.equal(recovered.reasonCode, "authenticated");
});

test("unknown availability performs only the bridge's one verification path", async (t) => {
  const paths = await fixture(t);
  const bridge = new GrokChromeBridge({ paths });
  let verifications = 0;
  bridge.verifyAvailability = async () => {
    verifications += 1;
    return {
      state: "available",
      available: true,
      reasonCode: "authenticated",
      reason: "Verified by test.",
    };
  };

  const result = await bridge.ensureAvailableForUse();
  assert.equal(result.available, true);
  assert.equal(verifications, 1);
});
