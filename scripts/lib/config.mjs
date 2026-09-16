import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneProfileCaches } from "./profile-cache.mjs";

export const DEFAULT_CHROME_EXECUTABLE =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const MAX_CONCURRENT_JOBS = 30;
export const DEFAULT_JOB_TIMEOUT_SECONDS = 2 * 60 * 60;
export const MAX_JOB_TIMEOUT_SECONDS = 4 * 60 * 60;
export const DEFAULT_STATUS_WAIT_SECONDS = 5 * 60;
export const DEFAULT_SUBMISSION_INTERVAL_SECONDS = 5;
export const MAX_SUBMISSION_INTERVAL_SECONDS = 60;

export function bridgePaths(env = process.env) {
  const home = os.homedir();
  const stateRoot = env.CHATGPT_CHROME_BRIDGE_STATE_DIR
    ? path.resolve(env.CHATGPT_CHROME_BRIDGE_STATE_DIR)
    : path.join(home, "Library", "Application Support", "ChatGPT Chrome Bridge");
  const chromeUserData = env.CHATGPT_CHROME_USER_DATA_DIR
    ? path.resolve(env.CHATGPT_CHROME_USER_DATA_DIR)
    : path.join(home, "Library", "Application Support", "Google", "Chrome");
  return {
    stateRoot,
    configFile: path.join(stateRoot, "config.json"),
    cacheFile: path.join(stateRoot, "ui-cache.json"),
    submissionPacerFile: path.join(stateRoot, "submission-pacer.json"),
    submissionPacerLock: path.join(stateRoot, "submission-pacer.lock"),
    conversationLocksRoot: path.join(stateRoot, "conversation-locks"),
    profilesRoot: path.join(stateRoot, "profiles"),
    chromeUserData,
    localStateFile: path.join(chromeUserData, "Local State"),
    chromeExecutable:
      env.CHATGPT_CHROME_EXECUTABLE || DEFAULT_CHROME_EXECUTABLE,
  };
}

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  profile: null,
  projectUrl: null,
  headless: true,
  defaultReasoning: "Extra High",
  timeoutSeconds: DEFAULT_JOB_TIMEOUT_SECONDS,
  maxConcurrent: MAX_CONCURRENT_JOBS,
  submissionIntervalSeconds: DEFAULT_SUBMISSION_INTERVAL_SECONDS,
});

export function normalizeProjectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(none|off|disabled)$/i.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ChatGPT project URL: ${raw}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    !/^\/g\/g-p-[a-z0-9_-]+\/project\/?$/i.test(parsed.pathname)
  ) {
    throw new Error(
      "A ChatGPT project URL must look like " +
        "https://chatgpt.com/g/g-p-…/project.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString();
}

export function normalizeConversationUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("A ChatGPT conversation URL is required.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ChatGPT conversation URL: ${raw}`);
  }
  const isConversationPath =
    /^\/c\/[a-z0-9_-]+\/?$/i.test(parsed.pathname) ||
    /^\/g\/[a-z0-9_-]+\/c\/[a-z0-9_-]+\/?$/i.test(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    !isConversationPath
  ) {
    throw new Error(
      "A ChatGPT conversation URL must look like " +
        "https://chatgpt.com/c/… or https://chatgpt.com/g/…/c/….",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString();
}

export function conversationKeyFromUrl(value) {
  const parsed = new URL(normalizeConversationUrl(value));
  const match = parsed.pathname.match(/\/c\/([a-z0-9_-]+)$/i);
  if (!match) throw new Error(`Could not identify ChatGPT conversation: ${value}`);
  return match[1].toLowerCase();
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Could not read JSON at ${file}: ${error.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function loadConfig(paths = bridgePaths()) {
  const stored = await readJson(paths.configFile, {});
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

export async function saveConfig(config, paths = bridgePaths()) {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...config,
    version: 1,
    projectUrl: normalizeProjectUrl(config.projectUrl),
    maxConcurrent: Math.max(
      1,
      Math.min(
        MAX_CONCURRENT_JOBS,
        Number(config.maxConcurrent || DEFAULT_CONFIG.maxConcurrent),
      ),
    ),
    timeoutSeconds: Math.max(
      10,
      Math.min(
        MAX_JOB_TIMEOUT_SECONDS,
        Number(config.timeoutSeconds || DEFAULT_CONFIG.timeoutSeconds),
      ),
    ),
    submissionIntervalSeconds: Math.max(
      1,
      Math.min(
        MAX_SUBMISSION_INTERVAL_SECONDS,
        Number(
          config.submissionIntervalSeconds ||
            DEFAULT_CONFIG.submissionIntervalSeconds,
        ),
      ),
    ),
  };
  delete normalized.defaultModel;
  await writeJsonAtomic(paths.configFile, normalized);
  return normalized;
}

export async function listChromeProfiles(paths = bridgePaths()) {
  const state = await readJson(paths.localStateFile);
  if (!state) {
    throw new Error(
      `Chrome profile metadata was not found at ${paths.localStateFile}. ` +
        "Set CHATGPT_CHROME_USER_DATA_DIR if Chrome stores profiles elsewhere.",
    );
  }
  const info = state?.profile?.info_cache || {};
  const lastUsed = state?.profile?.last_used || null;
  const profiles = [];
  for (const [directory, metadata] of Object.entries(info)) {
    const sourceDirectory = path.join(paths.chromeUserData, directory);
    try {
      const stat = await fs.stat(sourceDirectory);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    profiles.push({
      directory,
      name: metadata?.name || directory,
      lastUsed: directory === lastUsed,
    });
  }
  return profiles.sort((a, b) => {
    if (a.lastUsed !== b.lastUsed) return a.lastUsed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function fold(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export async function resolveChromeProfile(
  requested,
  paths = bridgePaths(),
  configured = null,
) {
  const profiles = await listChromeProfiles(paths);
  if (!profiles.length) throw new Error("No usable local Chrome profiles were found.");
  const needle = fold(requested || configured);
  if (!needle) return profiles.find((profile) => profile.lastUsed) || profiles[0];

  const exact = profiles.filter(
    (profile) =>
      fold(profile.directory) === needle || fold(profile.name) === needle,
  );
  if (exact.length === 1) return exact[0];

  const partial = profiles.filter(
    (profile) =>
      fold(profile.directory).includes(needle) || fold(profile.name).includes(needle),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Chrome profile “${requested || configured}” is ambiguous. Matches: ${partial
        .map((profile) => `${profile.name} (${profile.directory})`)
        .join(", ")}`,
    );
  }
  throw new Error(
    `Chrome profile “${requested || configured}” was not found. Available profiles: ${profiles
      .map((profile) => `${profile.name} (${profile.directory})`)
      .join(", ")}`,
  );
}

function profileKey(profile) {
  return crypto
    .createHash("sha256")
    .update(profile.directory)
    .digest("hex")
    .slice(0, 16);
}

const SESSION_PATHS = [
  "Preferences",
  "Secure Preferences",
  path.join("Network", "Cookies"),
  path.join("Network", "Cookies-journal"),
  "Cookies",
  "Cookies-journal",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  "Trust Tokens",
  "Trust Tokens-journal",
];

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function replaceCopy(source, destination, { removeMissing = false, fileSystem = fs } = {}) {
  if (!(await pathExists(source))) {
    if (removeMissing) await fileSystem.rm(destination, { recursive: true, force: true });
    return false;
  }
  await fileSystem.mkdir(path.dirname(destination), { recursive: true });
  const id = `${process.pid}-${crypto.randomUUID()}`;
  const temp = `${destination}.syncing-${id}`;
  const backup = `${destination}.replaced-${id}`;
  let backedUp = false;
  try {
    await fileSystem.cp(source, temp, {
      recursive: true, force: true,
      filter: (item) => {
        const base = path.basename(item);
        return base !== "LOCK" && !base.startsWith("Singleton");
      },
    });
    if (await pathExists(destination)) {
      await fileSystem.rename(destination, backup);
      backedUp = true;
    }
    try {
      await fileSystem.rename(temp, destination);
    } catch (error) {
      if (backedUp) await fileSystem.rename(backup, destination);
      throw error;
    }
    if (backedUp) await fileSystem.rm(backup, { recursive: true, force: true });
    return true;
  } finally {
    await fileSystem.rm(temp, { recursive: true, force: true });
  }
}

async function copySessionState({
  sourceUserDataDir,
  sourceProfileDirectory,
  targetUserDataDir,
  targetProfileDirectory,
  removeMissing = false,
}) {
  const sourceProfile = path.join(sourceUserDataDir, sourceProfileDirectory);
  const targetProfile = path.join(targetUserDataDir, targetProfileDirectory);
  await fs.mkdir(targetProfile, { recursive: true });
  const copied = [];
  if (
    await replaceCopy(
      path.join(sourceUserDataDir, "Local State"),
      path.join(targetUserDataDir, "Local State"),
      { removeMissing },
    )
  ) {
    copied.push("Local State");
  }
  for (const relative of SESSION_PATHS) {
    if (
      await replaceCopy(
        path.join(sourceProfile, relative),
        path.join(targetProfile, relative),
        { removeMissing },
      )
    ) {
      copied.push(relative);
    }
  }
  return copied;
}

async function withSessionSyncLock(
  lockDirectory,
  callback,
  { timeoutMs = 15_000, staleMs = 120_000 } = {},
) {
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockDirectory).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for session synchronization lock at ${lockDirectory}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await callback();
  } finally {
    await fs.rm(lockDirectory, { recursive: true, force: true });
  }
}

export class ChromeProfileStore {
  constructor(paths = bridgePaths()) {
    this.paths = paths;
    this.lastCacheCleanup = null;
    this.lastCacheCleanupError = null;
    this.cacheCleanupPromise = null;
  }

  async pruneCaches(options = {}) {
    if (this.cacheCleanupPromise) return this.cacheCleanupPromise;
    const cleanup = pruneProfileCaches(this.paths, { ...options, withLock: withSessionSyncLock });
    this.cacheCleanupPromise = cleanup;
    try {
      this.lastCacheCleanup = await cleanup;
      this.lastCacheCleanupError = null;
      return this.lastCacheCleanup;
    } catch (error) {
      this.lastCacheCleanupError = error.message;
      throw error;
    } finally {
      this.cacheCleanupPromise = null;
    }
  }

  runtime(profile) {
    const root = path.join(this.paths.profilesRoot, profileKey(profile));
    return {
      root,
      userDataDir: path.join(root, "User Data"),
      profileDirectory: profile.directory,
      markerFile: path.join(root, "session-copy.json"),
    };
  }

  worker(profile, workerId) {
    const seed = this.runtime(profile);
    const safeWorkerId = String(workerId || process.pid).replace(
      /[^a-z0-9_.-]/gi,
      "-",
    );
    const root = path.join(seed.root, "workers", safeWorkerId);
    return {
      root,
      userDataDir: path.join(root, "User Data"),
      profileDirectory: profile.directory,
      markerFile: path.join(root, "worker.json"),
      workerId: safeWorkerId,
    };
  }

  async prepare(profile, { force = false } = {}) {
    const runtime = this.runtime(profile);
    const marker = await readJson(runtime.markerFile);
    if (marker && !force) return { ...runtime, copied: false, marker };
    await fs.mkdir(runtime.root, { recursive: true });
    return withSessionSyncLock(
      path.join(runtime.root, ".session-sync.lock"),
      async () => {
        const copied = await copySessionState({
          sourceUserDataDir: this.paths.chromeUserData,
          sourceProfileDirectory: profile.directory,
          targetUserDataDir: runtime.userDataDir,
          targetProfileDirectory: profile.directory,
        });
        const nextMarker = {
          version: 1,
          sourceProfile: profile.directory,
          sourceName: profile.name,
          copiedAt: new Date().toISOString(),
          copied,
        };
        await writeJsonAtomic(runtime.markerFile, nextMarker);
        return { ...runtime, copied: true, marker: nextMarker };
      },
    );
  }

  async prepareWorker(profile, workerId, { force = false } = {}) {
    const seed = await this.prepare(profile);
    const runtime = this.worker(profile, workerId);
    const marker = await readJson(runtime.markerFile);
    if (marker && !force) return { ...runtime, copied: false, marker };

    return withSessionSyncLock(path.join(seed.root, ".session-sync.lock"), async () => {
      await fs.rm(runtime.root, { recursive: true, force: true });
      const nextMarker = {
        version: 1, workerId: runtime.workerId, ownerPid: process.pid,
        browserPid: null, sourceProfile: profile.directory,
        createdAt: new Date().toISOString(), copied: [],
      };
      await writeJsonAtomic(runtime.markerFile, nextMarker);
      try {
        nextMarker.copied = await copySessionState({
          sourceUserDataDir: seed.userDataDir,
          sourceProfileDirectory: profile.directory,
          targetUserDataDir: runtime.userDataDir,
          targetProfileDirectory: profile.directory,
        });
        await writeJsonAtomic(runtime.markerFile, nextMarker);
        return { ...runtime, copied: true, marker: nextMarker };
      } catch (error) {
        await fs.rm(runtime.root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async markWorkerBrowser(runtime, browserPid) {
    if (!runtime?.markerFile) return;
    const marker = (await readJson(runtime.markerFile, {})) || {};
    await writeJsonAtomic(runtime.markerFile, {
      ...marker,
      ownerPid: process.pid,
      browserPid,
      launchedAt: new Date().toISOString(),
    });
  }

  async persistWorker(profile, workerRuntime) {
    if (!workerRuntime?.workerId) {
      throw new Error("A prepared worker runtime is required to persist a session.");
    }
    const expected = this.worker(profile, workerRuntime.workerId);
    if (path.resolve(expected.root) !== path.resolve(workerRuntime.root)) {
      throw new Error("Refusing to persist session state from an unexpected worker path.");
    }
    await writeJsonAtomic(workerRuntime.markerFile, {
      ...(await readJson(workerRuntime.markerFile, {})), recoveryRequired: true,
    });
    const seed = this.runtime(profile);
    await fs.mkdir(seed.root, { recursive: true });
    return withSessionSyncLock(
      path.join(seed.root, ".session-sync.lock"),
      async () => {
        const copied = await copySessionState({
          sourceUserDataDir: workerRuntime.userDataDir,
          sourceProfileDirectory: profile.directory,
          targetUserDataDir: seed.userDataDir,
          targetProfileDirectory: profile.directory,
          removeMissing: true,
        });
        const persistedAt = new Date().toISOString();
        const nextMarker = {
          version: 2,
          sourceProfile: profile.directory,
          sourceName: profile.name,
          copiedAt: persistedAt,
          copied,
          persistedFromWorker: workerRuntime.workerId,
          persistedAt,
        };
        await writeJsonAtomic(seed.markerFile, nextMarker);
        return { ...seed, copied: true, marker: nextMarker };
      },
    );
  }

  async removeWorker(runtime) {
    if (!runtime?.root) return;
    await fs.rm(runtime.root, { recursive: true, force: true });
  }
}
