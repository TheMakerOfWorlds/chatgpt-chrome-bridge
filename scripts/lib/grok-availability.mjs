import { readJson, writeJsonAtomic } from "./config.mjs";

export const DEFAULT_GROK_AVAILABILITY_MAX_AGE_SECONDS = 15 * 60;

export const DEFAULT_GROK_AVAILABILITY = Object.freeze({
  version: 1,
  observedState: "unknown",
  reasonCode: "never_checked",
  reason: "Grok availability has not been checked on this machine.",
  source: "initial",
  profile: null,
  projectUrl: null,
  modelOptions: [],
  lastCheckedAt: null,
  lastAvailableAt: null,
  lastUnavailableAt: null,
  updatedAt: null,
});

function normalizeObservedState(value) {
  return ["available", "unavailable", "unknown"].includes(value)
    ? value
    : "unknown";
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function recoveryFor(record) {
  if (record.observedState !== "unavailable") return null;
  if (record.reasonCode === "signed_out") {
    return {
      action:
        "Do not retry Grok work. Use ChatGPT/local tools, or ask the user to restore Grok login. After the user confirms sign-in, call refresh_grok_login_from_chrome and then verify_grok_availability.",
      tools: [
        "refresh_grok_login_from_chrome",
        "open_grok_for_login",
        "verify_grok_availability",
      ],
    };
  }
  return {
    action:
      "Do not repeatedly probe Grok. Use ChatGPT/local tools for this work. Diagnose only when the user asks, then run verify_grok_availability once.",
    tools: ["get_grok_bridge_status", "verify_grok_availability"],
  };
}

export function evaluateGrokAvailability(
  record,
  {
    maxAgeSeconds = DEFAULT_GROK_AVAILABILITY_MAX_AGE_SECONDS,
    now = Date.now(),
  } = {},
) {
  const normalized = {
    ...DEFAULT_GROK_AVAILABILITY,
    ...(record || {}),
    observedState: normalizeObservedState(record?.observedState),
    modelOptions: Array.isArray(record?.modelOptions)
      ? record.modelOptions
      : [],
  };
  const boundedMaxAgeSeconds = Math.max(
    60,
    Math.min(24 * 60 * 60, Number(maxAgeSeconds) || 0),
  );
  const checkedAt = parseTimestamp(normalized.lastCheckedAt);
  const ageSeconds =
    checkedAt === null ? null : Math.max(0, Math.floor((now - checkedAt) / 1000));
  const stale =
    normalized.observedState === "available" &&
    (ageSeconds === null || ageSeconds > boundedMaxAgeSeconds);

  let state = normalized.observedState;
  let usable = state === "available";
  let needsVerification = state === "unknown";
  let recommendedAction = usable ? "use_grok" : "verify_once";
  let skipReason = null;

  if (stale) {
    state = "stale";
    usable = false;
    needsVerification = true;
    recommendedAction = "verify_once";
    skipReason =
      "The last successful authentication check is stale; verify once before submitting.";
  } else if (state === "unknown") {
    usable = false;
    needsVerification = true;
    recommendedAction = "verify_once";
    skipReason =
      "Availability is unknown; perform one live verification before submitting.";
  } else if (state === "unavailable") {
    usable = false;
    needsVerification = false;
    recommendedAction = "skip_grok";
    skipReason = normalized.reason;
  }

  return {
    state,
    observedState: normalized.observedState,
    available: usable,
    usable,
    stale,
    needsVerification,
    recommendedAction,
    skipReason,
    reasonCode: normalized.reasonCode,
    reason: normalized.reason,
    source: normalized.source,
    profile: normalized.profile,
    projectUrl: normalized.projectUrl,
    modelOptions: normalized.modelOptions,
    lastCheckedAt: normalized.lastCheckedAt,
    lastAvailableAt: normalized.lastAvailableAt,
    lastUnavailableAt: normalized.lastUnavailableAt,
    updatedAt: normalized.updatedAt,
    ageSeconds,
    maxAgeSeconds: boundedMaxAgeSeconds,
    recovery: recoveryFor(normalized),
  };
}

export async function loadGrokAvailability(paths) {
  const stored = await readJson(paths.availabilityFile, {});
  return {
    ...DEFAULT_GROK_AVAILABILITY,
    ...(stored || {}),
    observedState: normalizeObservedState(stored?.observedState),
    modelOptions: Array.isArray(stored?.modelOptions)
      ? stored.modelOptions
      : [],
  };
}

async function persistGrokAvailability(paths, patch) {
  const current = await loadGrokAvailability(paths);
  const now = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: now,
  };
  await writeJsonAtomic(paths.availabilityFile, next);
  return next;
}

export async function markGrokAvailable(
  paths,
  {
    source,
    profile,
    projectUrl,
    modelOptions,
    reason = "The signed-in Grok composer was verified.",
  } = {},
) {
  const now = new Date().toISOString();
  return persistGrokAvailability(paths, {
    observedState: "available",
    reasonCode: "authenticated",
    reason,
    source: source || "authentication_check",
    profile: profile || null,
    projectUrl: projectUrl || null,
    modelOptions: Array.isArray(modelOptions) ? modelOptions : [],
    lastCheckedAt: now,
    lastAvailableAt: now,
  });
}

export async function markGrokUnavailable(
  paths,
  {
    source,
    profile,
    projectUrl,
    reasonCode = "authentication_unavailable",
    reason = "Grok authentication could not be verified.",
  } = {},
) {
  const now = new Date().toISOString();
  return persistGrokAvailability(paths, {
    observedState: "unavailable",
    reasonCode,
    reason,
    source: source || "authentication_check",
    profile: profile || null,
    projectUrl: projectUrl || null,
    lastCheckedAt: now,
    lastUnavailableAt: now,
  });
}

export async function markGrokUnknown(
  paths,
  {
    source,
    profile,
    projectUrl,
    reasonCode = "needs_verification",
    reason = "Grok must be verified before the next submission.",
  } = {},
) {
  return persistGrokAvailability(paths, {
    observedState: "unknown",
    reasonCode,
    reason,
    source: source || "configuration_change",
    profile: profile || null,
    projectUrl: projectUrl || null,
    modelOptions: [],
    lastCheckedAt: null,
  });
}
