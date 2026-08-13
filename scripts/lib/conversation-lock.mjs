import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { conversationKeyFromUrl } from "./config.mjs";

export const DEFAULT_CONVERSATION_LOCK_POLL_MS = 250;
export const DEFAULT_CONVERSATION_LOCK_STALE_MS = 2 * 60 * 1000;
export const DEFAULT_CONVERSATION_LOCK_HEARTBEAT_MS = 30 * 1000;

const execFileAsync = promisify(execFile);
const RECLAIMER_SCRIPT = fileURLToPath(
  new URL("./conversation-lock-reclaimer.mjs", import.meta.url),
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOwner(lockDirectory) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function processIsAlive(processId) {
  const pid = Number(processId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function reclaimAbandonedConversationLock(
  lockDirectory,
  staleMs,
  now = Date.now(),
) {
  const stat = await fs.stat(lockDirectory).catch(() => null);
  if (!stat || now - stat.mtimeMs <= staleMs) return false;
  const owner = await readOwner(lockDirectory);
  if (processIsAlive(owner?.processId)) return false;
  await fs.rm(lockDirectory, { recursive: true, force: true });
  return true;
}

export class GlobalConversationLock {
  constructor({
    paths,
    workerId,
    pollMs = DEFAULT_CONVERSATION_LOCK_POLL_MS,
    staleMs = DEFAULT_CONVERSATION_LOCK_STALE_MS,
    heartbeatMs = DEFAULT_CONVERSATION_LOCK_HEARTBEAT_MS,
  }) {
    this.paths = paths;
    this.workerId = workerId;
    this.pollMs = Math.max(25, Number(pollMs) || DEFAULT_CONVERSATION_LOCK_POLL_MS);
    this.staleMs = Math.max(1_000, Number(staleMs) || DEFAULT_CONVERSATION_LOCK_STALE_MS);
    this.heartbeatMs = Math.max(
      250,
      Math.min(
        this.staleMs / 2,
        Number(heartbeatMs) || DEFAULT_CONVERSATION_LOCK_HEARTBEAT_MS,
      ),
    );
  }

  lockDirectory(conversationUrl) {
    const digest = crypto
      .createHash("sha256")
      .update(conversationKeyFromUrl(conversationUrl))
      .digest("hex");
    return path.join(this.paths.conversationLocksRoot, `${digest}.lock`);
  }

  async tryReclaimAbandonedLock(lockDirectory) {
    const reclaimLockFile = path.join(
      this.paths.conversationLocksRoot,
      "reclaim.lock",
    );
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/lockf",
        [
          "-s",
          "-t",
          "0",
          "-k",
          reclaimLockFile,
          process.execPath,
          RECLAIMER_SCRIPT,
          lockDirectory,
          String(this.staleMs),
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        },
      );
      return Boolean(JSON.parse(String(stdout || "{}")).reclaimed);
    } catch (error) {
      if (Number(error?.code) === 75) return false;
      throw new Error(
        `Could not safely reclaim an abandoned conversation lease: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  async acquire(
    conversationUrl,
    { timeoutMs, jobId = null, onWaiting = null } = {},
  ) {
    const lockDirectory = this.lockDirectory(conversationUrl);
    const ownerToken = crypto.randomUUID();
    const startedAt = Date.now();
    const boundedTimeoutMs = Math.max(1_000, Number(timeoutMs) || 60_000);
    let lastWaitingNotificationAt = 0;
    await fs.mkdir(this.paths.conversationLocksRoot, {
      recursive: true,
      mode: 0o700,
    });

    while (true) {
      try {
        await fs.mkdir(lockDirectory, { mode: 0o700 });
        const owner = {
          version: 1,
          token: ownerToken,
          workerId: this.workerId,
          processId: process.pid,
          jobId,
          acquiredAt: new Date().toISOString(),
        };
        try {
          await fs.writeFile(
            path.join(lockDirectory, "owner.json"),
            `${JSON.stringify(owner, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        } catch (error) {
          await fs.rm(lockDirectory, { recursive: true, force: true });
          throw error;
        }
        const heartbeat = setInterval(async () => {
          const currentOwner = await readOwner(lockDirectory);
          if (currentOwner?.token !== ownerToken) {
            clearInterval(heartbeat);
            return;
          }
          const now = new Date();
          await fs.utimes(lockDirectory, now, now).catch(() => {});
        }, this.heartbeatMs);
        heartbeat.unref?.();
        let released = false;
        return {
          acquiredAt: owner.acquiredAt,
          waitedMs: Date.now() - startedAt,
          async release() {
            if (released) return false;
            released = true;
            clearInterval(heartbeat);
            const currentOwner = await readOwner(lockDirectory);
            if (currentOwner?.token !== ownerToken) return false;
            await fs.rm(lockDirectory, { recursive: true, force: true });
            return true;
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const stat = await fs.stat(lockDirectory).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > this.staleMs) {
        if (await this.tryReclaimAbandonedLock(lockDirectory)) continue;
      }
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= boundedTimeoutMs) {
        throw new Error(
          "Timed out waiting for another bridge worker to finish its reply " +
            "to this ChatGPT conversation. The original conversation was not modified by this job.",
        );
      }
      if (
        typeof onWaiting === "function" &&
        Date.now() - lastWaitingNotificationAt >= 1_000
      ) {
        lastWaitingNotificationAt = Date.now();
        await onWaiting({ waitedMs });
      }
      await sleep(this.pollMs);
    }
  }
}
