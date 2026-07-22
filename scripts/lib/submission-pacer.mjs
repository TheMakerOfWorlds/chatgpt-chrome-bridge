import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  bridgePaths,
  DEFAULT_CONFIG,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_SUBMISSION_INTERVAL_SECONDS,
  readJson,
  writeJsonAtomic,
} from "./config.mjs";

const DEFAULT_POLL_INTERVAL_MS = 75;
const DEFAULT_STALE_LOCK_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampIntervalSeconds(value) {
  return Math.max(
    0,
    Math.min(
      MAX_SUBMISSION_INTERVAL_SECONDS,
      Number(value ?? DEFAULT_CONFIG.submissionIntervalSeconds),
    ),
  );
}

export class GlobalSubmissionPacer {
  constructor({
    paths = bridgePaths(),
    workerId = `${process.pid}-${crypto.randomUUID()}`,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
  } = {}) {
    this.paths = paths;
    this.workerId = workerId;
    this.pollIntervalMs = pollIntervalMs;
    this.staleLockMs = staleLockMs;
  }

  async acquire({ timeoutMs = MAX_JOB_TIMEOUT_SECONDS * 1000 } = {}) {
    await fs.mkdir(this.paths.stateRoot, { recursive: true });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const token = crypto.randomUUID();
      try {
        await fs.mkdir(this.paths.submissionPacerLock);
        await fs.writeFile(
          path.join(this.paths.submissionPacerLock, "owner.json"),
          `${JSON.stringify({
            token,
            workerId: this.workerId,
            acquiredAt: new Date().toISOString(),
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        return { token, waitedMs: Date.now() - started };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(this.paths.submissionPacerLock);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) {
            await fs.rm(this.paths.submissionPacerLock, {
              recursive: true,
              force: true,
            });
            continue;
          }
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
          continue;
        }
        const jitter = Math.floor(Math.random() * this.pollIntervalMs);
        await sleep(this.pollIntervalMs + jitter);
      }
    }
    throw new Error(
      "Timed out waiting for the global ChatGPT submission gate. " +
        "Use get_chatgpt_bridge_status to inspect the pacer.",
    );
  }

  async release(token) {
    const owner = await readJson(
      path.join(this.paths.submissionPacerLock, "owner.json"),
      null,
    );
    if (owner?.token !== token) return;
    await fs.rm(this.paths.submissionPacerLock, {
      recursive: true,
      force: true,
    });
  }

  async run(
    submit,
    {
      intervalSeconds = DEFAULT_CONFIG.submissionIntervalSeconds,
      onWaiting = null,
    } = {},
  ) {
    if (typeof submit !== "function") {
      throw new Error("A submission callback is required.");
    }
    const interval = clampIntervalSeconds(intervalSeconds);
    const acquired = await this.acquire();
    try {
      const state =
        (await readJson(this.paths.submissionPacerFile, null)) || {
          version: 1,
        };
      const previousAt = Math.max(
        timestamp(state.lastAttemptAt),
        timestamp(state.lastSubmittedAt),
      );
      const spacingWaitMs = Math.max(
        0,
        previousAt + interval * 1000 - Date.now(),
      );
      const nextTurnAt = new Date(Date.now() + spacingWaitMs).toISOString();
      if (typeof onWaiting === "function") {
        await onWaiting({
          intervalSeconds: interval,
          lockWaitMs: acquired.waitedMs,
          spacingWaitMs,
          nextTurnAt,
        });
      }
      if (spacingWaitMs > 0) await sleep(spacingWaitMs);

      const attemptedAt = new Date().toISOString();
      await writeJsonAtomic(this.paths.submissionPacerFile, {
        ...state,
        version: 1,
        intervalSeconds: interval,
        lastAttemptAt: attemptedAt,
        lastWorkerId: this.workerId,
      });

      let result;
      try {
        result = await submit();
      } catch (error) {
        await writeJsonAtomic(this.paths.submissionPacerFile, {
          ...state,
          version: 1,
          intervalSeconds: interval,
          lastAttemptAt: attemptedAt,
          lastFailedAttemptAt: new Date().toISOString(),
          lastWorkerId: this.workerId,
        });
        throw error;
      }

      const submittedAt = new Date().toISOString();
      await writeJsonAtomic(this.paths.submissionPacerFile, {
        ...state,
        version: 1,
        intervalSeconds: interval,
        lastAttemptAt: attemptedAt,
        lastSubmittedAt: submittedAt,
        lastWorkerId: this.workerId,
      });
      return {
        result,
        pacing: {
          intervalSeconds: interval,
          lockWaitMs: acquired.waitedMs,
          spacingWaitMs,
          submittedAt,
        },
      };
    } finally {
      await this.release(acquired.token);
    }
  }

  async status(intervalSeconds = DEFAULT_CONFIG.submissionIntervalSeconds) {
    const interval = clampIntervalSeconds(intervalSeconds);
    const state = (await readJson(this.paths.submissionPacerFile, {})) || {};
    const previousAt = Math.max(
      timestamp(state.lastAttemptAt),
      timestamp(state.lastSubmittedAt),
    );
    let lockActive = false;
    let lockAgeMs = null;
    try {
      const stat = await fs.stat(this.paths.submissionPacerLock);
      lockActive = true;
      lockAgeMs = Math.max(0, Date.now() - stat.mtimeMs);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      global: true,
      intervalSeconds: interval,
      lockActive,
      lockAgeMs,
      lastAttemptAt: state.lastAttemptAt || null,
      lastSubmittedAt: state.lastSubmittedAt || null,
      lastWorkerId: state.lastWorkerId || null,
      nextAllowedAt: previousAt
        ? new Date(previousAt + interval * 1000).toISOString()
        : new Date().toISOString(),
    };
  }
}
