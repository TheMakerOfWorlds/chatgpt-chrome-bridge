import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CHROME_EXECUTABLE,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  DEFAULT_SUBMISSION_INTERVAL_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_SUBMISSION_INTERVAL_SECONDS,
  readJson,
  writeJsonAtomic,
} from "./config.mjs";

export const GROK_PROJECT_URL_PATTERN =
  /^\/project\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i;

export function grokBridgePaths(env = process.env) {
  const home = os.homedir();
  const stateRoot = env.GROK_CHROME_BRIDGE_STATE_DIR
    ? path.resolve(env.GROK_CHROME_BRIDGE_STATE_DIR)
    : path.join(home, "Library", "Application Support", "Grok Chrome Bridge");
  const chromeUserData = env.GROK_CHROME_USER_DATA_DIR
    ? path.resolve(env.GROK_CHROME_USER_DATA_DIR)
    : path.join(home, "Library", "Application Support", "Google", "Chrome");
  return {
    stateRoot,
    configFile: path.join(stateRoot, "config.json"),
    cacheFile: path.join(stateRoot, "ui-cache.json"),
    availabilityFile: path.join(stateRoot, "availability.json"),
    submissionPacerFile: path.join(stateRoot, "submission-pacer.json"),
    submissionPacerLock: path.join(stateRoot, "submission-pacer.lock"),
    profilesRoot: path.join(stateRoot, "profiles"),
    chromeUserData,
    localStateFile: path.join(chromeUserData, "Local State"),
    chromeExecutable: env.GROK_CHROME_EXECUTABLE || DEFAULT_CHROME_EXECUTABLE,
  };
}

export const DEFAULT_GROK_CONFIG = Object.freeze({
  version: 1,
  profile: null,
  projectUrl: null,
  headless: true,
  defaultModel: "Fast",
  timeoutSeconds: DEFAULT_JOB_TIMEOUT_SECONDS,
  maxConcurrent: MAX_CONCURRENT_JOBS,
  submissionIntervalSeconds: DEFAULT_SUBMISSION_INTERVAL_SECONDS,
});

export function normalizeGrokProjectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(none|off|disabled)$/i.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Grok project URL: ${raw}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "grok.com" ||
    !GROK_PROJECT_URL_PATTERN.test(parsed.pathname)
  ) {
    throw new Error(
      "A Grok project URL must look like https://grok.com/project/<project-id>.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString();
}

export async function loadGrokConfig(paths = grokBridgePaths()) {
  const stored = await readJson(paths.configFile, {});
  return { ...DEFAULT_GROK_CONFIG, ...(stored || {}) };
}

export async function saveGrokConfig(config, paths = grokBridgePaths()) {
  const normalized = {
    ...DEFAULT_GROK_CONFIG,
    ...config,
    version: 1,
    projectUrl: normalizeGrokProjectUrl(config.projectUrl),
    defaultModel: String(config.defaultModel || "Fast").trim() || "Fast",
    maxConcurrent: Math.max(
      1,
      Math.min(
        MAX_CONCURRENT_JOBS,
        Number(config.maxConcurrent || DEFAULT_GROK_CONFIG.maxConcurrent),
      ),
    ),
    timeoutSeconds: Math.max(
      10,
      Math.min(
        MAX_JOB_TIMEOUT_SECONDS,
        Number(config.timeoutSeconds || DEFAULT_GROK_CONFIG.timeoutSeconds),
      ),
    ),
    submissionIntervalSeconds: Math.max(
      1,
      Math.min(
        MAX_SUBMISSION_INTERVAL_SECONDS,
        Number(
          config.submissionIntervalSeconds ||
            DEFAULT_GROK_CONFIG.submissionIntervalSeconds,
        ),
      ),
    ),
  };
  await writeJsonAtomic(paths.configFile, normalized);
  return normalized;
}
