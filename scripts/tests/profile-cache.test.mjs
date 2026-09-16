import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChromeProfileStore, replaceCopy } from "../lib/config.mjs";
import { BROWSER_CACHE_POLICY } from "../lib/profile-cache.mjs";
import { buildNativeControllerArguments } from "../lib/native-controller.mjs";
import { buildNativeLoginArguments } from "../lib/native-login.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-cache-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { stateRoot: path.join(root, "state"), profilesRoot: path.join(root, "state", "profiles"), chromeUserData: path.join(root, "real-chrome") };
  const store = new ChromeProfileStore(paths);
  const profile = { directory: "Profile 2", name: "Test" };
  const seed = store.runtime(profile);
  const put = async (file, content = "preserve") => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const source = path.join(paths.chromeUserData, profile.directory);
  await put(path.join(source, "Network", "Cookies"));
  await put(path.join(source, "Local Storage", "login"));
  await put(path.join(source, "IndexedDB", "state"));
  await put(path.join(source, "Service Worker", "CacheStorage", "large-cache"));
  await store.prepare(profile);
  return { root, paths, store, profile, seed, put };
}
const exists = (file) => fs.access(file).then(() => true, () => false);

test("snapshots exclude service-worker caches and retain authentication through persistence", async (t) => {
  const { store, profile, seed } = await fixture(t);
  const worker = await store.prepareWorker(profile, "live-worker");
  assert.equal(await exists(path.join(worker.userDataDir, profile.directory, "Service Worker")), false);
  await fs.writeFile(path.join(worker.userDataDir, profile.directory, "Network", "Cookies"), "refreshed");
  await store.persistWorker(profile, worker);
  assert.equal(await fs.readFile(path.join(seed.userDataDir, profile.directory, "Network", "Cookies"), "utf8"), "refreshed");
  assert.equal(await exists(path.join(seed.userDataDir, profile.directory, "Service Worker")), false);
});

test("cleanup removes caches and dead workers, preserving active workers, recovery state and user files", async (t) => {
  const { root, paths, store, profile, seed, put } = await fixture(t);
  await put(path.join(seed.userDataDir, "OptGuideOnDeviceModel", "weights"));
  await put(path.join(seed.userDataDir, profile.directory, "Service Worker", "assets"));
  const stale = path.join(seed.userDataDir, profile.directory, "Service Worker.syncing-888-abcdef");
  await put(path.join(stale, "partial"));
  const needed = path.join(seed.userDataDir, profile.directory, "Session Storage.replaced-888-abcdef");
  await put(path.join(needed, "only-copy"));
  const outside = path.join(root, "outside");
  await put(path.join(outside, "important"));
  await fs.symlink(outside, path.join(seed.userDataDir, "GPUCache"));
  await put(path.join(paths.stateRoot, "response-files", "download.pdf"));
  for (const [id, marker] of [
    ["dead", { ownerPid: 100 }], ["active-owner", { ownerPid: 200 }],
    ["active-browser", { ownerPid: 100, browserPid: 201 }],
    ["active-command", { ownerPid: 100 }], ["recovery", { ownerPid: 100, recoveryRequired: true }],
    ["recent", { ownerPid: 100, createdAt: new Date().toISOString() }],
  ]) {
    const worker = store.worker(profile, id);
    await put(worker.markerFile, JSON.stringify({ createdAt: "2020-01-01T00:00:00Z", ...marker }));
    await put(path.join(worker.userDataDir, profile.directory, "Network", "Cookies"));
    await put(path.join(worker.userDataDir, profile.directory, "Cache", "data"));
  }
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(stale, old, old); await fs.utimes(needed, old, old);
  const result = await store.pruneCaches({ processSnapshot: async () => [
    { pid: 200, command: "node bridge" }, { pid: 201, command: "Chrome" },
    { pid: 202, command: `Chrome --user-data-dir=${store.worker(profile, "active-command").userDataDir}` },
  ] });
  assert.equal(result.removedWorkers, 1);
  assert.equal(result.skippedActive, 3);
  assert.equal(result.protectedRecovery, 1);
  assert.ok(result.reclaimedBytes > 0);
  assert.equal(await exists(stale), false);
  assert.equal(await exists(needed), true);
  assert.equal(await exists(store.worker(profile, "recent").root), true);
  assert.equal(await exists(path.join(store.worker(profile, "recovery").userDataDir, profile.directory, "Network", "Cookies")), true);
  assert.equal(await exists(path.join(store.worker(profile, "recovery").userDataDir, profile.directory, "Cache")), false);
  for (const file of [path.join(outside, "important"), path.join(paths.stateRoot, "response-files", "download.pdf"), path.join(seed.userDataDir, profile.directory, "IndexedDB", "state"), path.join(paths.chromeUserData, profile.directory, "Service Worker", "CacheStorage", "large-cache")]) assert.equal(await exists(file), true);
});

test("active seed Chrome and unavailable process inventory prevent deletion", async (t) => {
  const { store, seed, put } = await fixture(t);
  const cache = path.join(seed.userDataDir, "OptGuideOnDeviceModel", "weights");
  await put(cache);
  const result = await store.pruneCaches({ processSnapshot: async () => [{ pid: 123, command: `Chrome --user-data-dir=${seed.userDataDir}` }] });
  assert.equal(result.skippedActive, 1);
  assert.equal(await exists(cache), true);
  await assert.rejects(store.pruneCaches({ processSnapshot: async () => { throw new Error("ps unavailable"); } }), /ps unavailable/);
  assert.equal(await exists(cache), true);
  assert.match(store.lastCacheCleanupError, /ps unavailable/);
});

test("failed copies and failed swaps preserve original session without partial-copy debris", async (t) => {
  const { root, put } = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await put(source, "new"); await put(destination, "old");
  await assert.rejects(replaceCopy(source, destination, { fileSystem: { ...fs, cp: async (_, temp) => { await fs.writeFile(temp, "partial"); throw new Error("ENOSPC simulated"); } } }), /ENOSPC/);
  assert.equal(await fs.readFile(destination, "utf8"), "old");
  await assert.rejects(replaceCopy(source, destination, { fileSystem: { ...fs, rename: async (from, to) => {
    if (from.includes(".syncing-")) throw new Error("rename failed");
    return fs.rename(from, to);
  } } }), /rename failed/);
  assert.equal(await fs.readFile(destination, "utf8"), "old");
  assert.deepEqual((await fs.readdir(root)).filter((name) => /\.(syncing|replaced)-/.test(name)), []);
});

test("both private Chrome launch paths use the small cache budget and disable local model downloads", () => {
  for (const build of [buildNativeControllerArguments, buildNativeLoginArguments]) {
    const args = build({ userDataDir: "/bridge/private", profileDirectory: "Profile 2", port: 9000, url: "https://chatgpt.com" });
    assert.ok(args.includes(`--disk-cache-size=${BROWSER_CACHE_POLICY.diskCacheBytes}`));
    assert.ok(args.some((arg) => arg.startsWith("--disable-features=") && arg.includes("OptimizationGuideModelDownloading") && arg.includes("OptimizationGuideOnDeviceModel")));
  }
});
