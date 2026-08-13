#!/usr/bin/env node

import { reclaimAbandonedConversationLock } from "./conversation-lock.mjs";

const [lockDirectory, rawStaleMs] = process.argv.slice(2);
if (!lockDirectory || !Number.isFinite(Number(rawStaleMs))) {
  process.stderr.write("A lock directory and numeric stale duration are required.\n");
  process.exit(64);
}

try {
  const reclaimed = await reclaimAbandonedConversationLock(
    lockDirectory,
    Math.max(1_000, Number(rawStaleMs)),
  );
  process.stdout.write(`${JSON.stringify({ reclaimed })}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
}
