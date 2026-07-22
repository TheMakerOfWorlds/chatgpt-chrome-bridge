import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ChromeProfileStore,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  DEFAULT_STATUS_WAIT_SECONDS,
  DEFAULT_SUBMISSION_INTERVAL_SECONDS,
  DEFAULT_CONFIG,
  listChromeProfiles,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_SUBMISSION_INTERVAL_SECONDS,
  normalizeProjectUrl,
  resolveChromeProfile,
  saveConfig,
} from "../lib/config.mjs";

test("accepts only canonical ChatGPT project destinations", () => {
  assert.equal(
    normalizeProjectUrl(
      "https://chatgpt.com/g/g-p-6a5e648cac488191befbdf735bb011fb/project/?ignored=yes#section",
    ),
    "https://chatgpt.com/g/g-p-6a5e648cac488191befbdf735bb011fb/project",
  );
  assert.equal(normalizeProjectUrl(""), null);
  assert.throws(
    () => normalizeProjectUrl("https://example.com/g/g-p-123/project"),
    /ChatGPT project URL/,
  );
});

test("defaults to 30 jobs, a two-hour deadline, and five-second pacing", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.maxConcurrent, 30);
  assert.equal(DEFAULT_CONFIG.timeoutSeconds, DEFAULT_JOB_TIMEOUT_SECONDS);
  assert.equal(DEFAULT_CONFIG.timeoutSeconds, 7200);
  assert.equal(DEFAULT_STATUS_WAIT_SECONDS, 300);
  assert.equal(MAX_JOB_TIMEOUT_SECONDS, 14_400);
  assert.equal(
    DEFAULT_CONFIG.submissionIntervalSeconds,
    DEFAULT_SUBMISSION_INTERVAL_SECONDS,
  );

  const normalized = await saveConfig(
    {
      ...DEFAULT_CONFIG,
      maxConcurrent: 300,
      timeoutSeconds: 36_000,
      submissionIntervalSeconds: 600,
    },
    paths,
  );
  assert.equal(normalized.maxConcurrent, MAX_CONCURRENT_JOBS);
  assert.equal(normalized.timeoutSeconds, MAX_JOB_TIMEOUT_SECONDS);
  assert.equal(
    normalized.submissionIntervalSeconds,
    MAX_SUBMISSION_INTERVAL_SECONDS,
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-test-"));
  const chromeUserData = path.join(root, "Chrome");
  const stateRoot = path.join(root, "State");
  await fs.mkdir(path.join(chromeUserData, "Profile 2", "Network"), {
    recursive: true,
  });
  await fs.mkdir(path.join(chromeUserData, "Profile 2", "Local Storage"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(chromeUserData, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Profile 2",
        info_cache: {
          "Profile 2": { name: "Work ChatGPT" },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(chromeUserData, "Profile 2", "Network", "Cookies"),
    "cookie-db",
  );
  await fs.writeFile(
    path.join(chromeUserData, "Profile 2", "Local Storage", "state"),
    "site-state",
  );
  await fs.writeFile(
    path.join(chromeUserData, "Profile 2", "History"),
    "must-not-copy",
  );
  return {
    root,
    paths: {
      stateRoot,
      configFile: path.join(stateRoot, "config.json"),
      cacheFile: path.join(stateRoot, "ui-cache.json"),
      submissionPacerFile: path.join(stateRoot, "submission-pacer.json"),
      submissionPacerLock: path.join(stateRoot, "submission-pacer.lock"),
      profilesRoot: path.join(stateRoot, "profiles"),
      chromeUserData,
      localStateFile: path.join(chromeUserData, "Local State"),
      chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
  };
}

test("resolves a friendly profile name and preserves last-used metadata", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = await listChromeProfiles(paths);
  assert.deepEqual(profiles, [
    { directory: "Profile 2", name: "Work ChatGPT", lastUsed: true },
  ]);
  const resolved = await resolveChromeProfile("work chatgpt", paths);
  assert.equal(resolved.directory, "Profile 2");
});

test("copies session data into an isolated runtime profile without history", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = await resolveChromeProfile(null, paths);
  const store = new ChromeProfileStore(paths);
  const runtime = await store.prepare(profile);
  assert.equal(runtime.copied, true);
  const copiedProfile = path.join(runtime.userDataDir, "Profile 2");
  assert.equal(
    await fs.readFile(path.join(copiedProfile, "Network", "Cookies"), "utf8"),
    "cookie-db",
  );
  assert.equal(
    await fs.readFile(path.join(copiedProfile, "Local Storage", "state"), "utf8"),
    "site-state",
  );
  await assert.rejects(fs.access(path.join(copiedProfile, "History")));
  const reused = await store.prepare(profile);
  assert.equal(reused.copied, false);

  const workerA = await store.prepareWorker(profile, "agent-a");
  const workerB = await store.prepareWorker(profile, "agent-b");
  assert.notEqual(workerA.userDataDir, workerB.userDataDir);
  assert.equal(
    await fs.readFile(
      path.join(workerA.userDataDir, "Profile 2", "Network", "Cookies"),
      "utf8",
    ),
    "cookie-db",
  );
  assert.equal(
    await fs.readFile(
      path.join(workerB.userDataDir, "Profile 2", "Network", "Cookies"),
      "utf8",
    ),
    "cookie-db",
  );
  await assert.rejects(
    fs.access(path.join(workerA.userDataDir, "Profile 2", "History")),
  );
});
