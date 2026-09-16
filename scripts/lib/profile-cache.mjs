import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const BROWSER_CACHE_POLICY = Object.freeze({
  diskCacheBytes: 32 * 1024 * 1024,
  cleanupIntervalMs: 15 * 60 * 1000,
  orphanGraceMs: 5 * 60 * 1000,
  serviceWorkerCacheCopied: false,
  activeProfilesPruned: false,
  downloadedResponseFilesPruned: false,
});

export const LIGHTWEIGHT_CHROME_ARGUMENTS = Object.freeze([
  `--disk-cache-size=${BROWSER_CACHE_POLICY.diskCacheBytes}`,
  "--disable-features=OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel",
]);

const ROOT_CACHES = new Set([
  "OptGuideOnDeviceModel", "optimization_guide_model_store", "WasmTtsEngine",
  "component_crx_cache", "extensions_crx_cache", "ShaderCache", "GrShaderCache",
  "GraphiteDawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GPUCache",
  "BrowserMetrics",
]);
const PROFILE_CACHES = new Set([
  "Cache", "Code Cache", "GPUCache", "Media Cache", "Service Worker",
  "DawnGraphiteCache", "DawnWebGPUCache", "GraphiteDawnCache",
]);

async function entries(directory) {
  return fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
async function stat(target) {
  return fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function json(file) {
  return JSON.parse(await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "null";
    throw error;
  }));
}
export async function directoryBytes(target) {
  const info = await stat(target);
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const entry of await entries(target)) bytes += await directoryBytes(path.join(target, entry.name));
  return bytes;
}

export async function readProcessSnapshot() {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axww", "-o", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const processes = String(stdout).split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
  if (!processes.length) throw new Error("No process snapshot; browser cache cleanup skipped.");
  return processes;
}

// Only known disposable data within bridge-owned profiles is eligible. Never
// follow symlinks or prune a profile referenced by a live process.
export async function pruneProfileCaches(paths, {
  withLock,
  processSnapshot = readProcessSnapshot,
  now = Date.now(),
  orphanGraceMs = BROWSER_CACHE_POLICY.orphanGraceMs,
} = {}) {
  const result = { checkedAt: new Date(now).toISOString(), reclaimedBytes: 0,
    removedCaches: 0, removedWorkers: 0, skippedActive: 0, protectedRecovery: 0 };
  if (!(await stat(paths.profilesRoot))?.isDirectory()) return result;
  if (typeof withLock !== "function") throw new Error("A session lock is required for profile cleanup.");
  for (const entry of await entries(paths.profilesRoot)) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
    const root = path.join(paths.profilesRoot, entry.name);
    await withLock(path.join(root, ".session-sync.lock"), async () => {
      // Take the snapshot after acquiring the same lock used to create/copy workers.
      const processes = await processSnapshot();
      const alive = (pid) => Number(pid) > 0 && processes.some((item) => item.pid === Number(pid));
      const inUse = (directory) => processes.some((item) => item.command.includes(`--user-data-dir=${directory}`));
      const remove = async (target, worker = false) => {
        const info = await stat(target);
        if (!info || info.isSymbolicLink()) return;
        const bytes = await directoryBytes(target);
        await fs.rm(target, { recursive: true, force: true });
        result.reclaimedBytes += bytes;
        if (worker) result.removedWorkers += 1;
        else result.removedCaches += 1;
      };
      const trim = async (userData) => {
        if (!(await stat(userData))?.isDirectory()) return;
        if (inUse(userData)) { result.skippedActive += 1; return; }
        const pruneLevel = async (directory, disposable) => {
          for (const item of await entries(directory)) {
            if (item.isSymbolicLink()) continue;
            const target = path.join(directory, item.name);
            if (disposable.has(item.name)) { await remove(target); continue; }
            const temp = item.name.match(/^(.*)\.(syncing|replaced)-(\d+)-[a-f0-9-]+$/);
            if (!temp || alive(temp[3])) continue;
            const info = await stat(target);
            if (!info || now - info.mtimeMs < orphanGraceMs) continue;
            // If the original is absent, this may be the only recoverable session.
            if (disposable.has(temp[1]) || await stat(path.join(directory, temp[1]))) await remove(target);
          }
        };
        await pruneLevel(userData, ROOT_CACHES);
        for (const item of await entries(userData)) {
          if (!item.isDirectory() || !/^(Default|Profile \d+)$/.test(item.name)) continue;
          const profile = path.join(userData, item.name);
          await pruneLevel(profile, PROFILE_CACHES);
          const network = path.join(profile, "Network");
          if ((await stat(network))?.isDirectory()) await pruneLevel(network, new Set());
        }
      };
      await trim(path.join(root, "User Data"));
      const workers = path.join(root, "workers");
      if (!(await stat(workers))?.isDirectory()) return;
      for (const worker of await entries(workers)) {
        if (!worker.isDirectory()) continue;
        const workerRoot = path.join(workers, worker.name);
        const userData = path.join(workerRoot, "User Data");
        const marker = await json(path.join(workerRoot, "worker.json"));
        const ownerPid = marker?.ownerPid || Number(worker.name.match(/^(\d+)-/)?.[1]);
        if (alive(ownerPid) || alive(marker?.browserPid) || inUse(userData)) {
          result.skippedActive += 1;
          continue;
        }
        if (marker?.recoveryRequired) {
          result.protectedRecovery += 1;
          await trim(userData);
          continue;
        }
        const info = await stat(workerRoot);
        const createdAt = Date.parse(marker?.createdAt || "") || info?.mtimeMs || now;
        if (now - createdAt < orphanGraceMs) continue;
        await remove(workerRoot, true);
      }
    });
  }
  return result;
}
