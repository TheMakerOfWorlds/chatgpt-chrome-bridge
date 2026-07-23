import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_GROK_CONFIG,
  grokBridgePaths,
  normalizeGrokProjectUrl,
  saveGrokConfig,
} from "../lib/grok-config.mjs";

test("accepts only canonical grok.com project destinations", () => {
  assert.equal(
    normalizeGrokProjectUrl(
      "https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6/?ignored=yes#section",
    ),
    "https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6",
  );
  assert.equal(normalizeGrokProjectUrl("off"), null);
  assert.throws(
    () =>
      normalizeGrokProjectUrl(
        "https://example.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6",
      ),
    /Grok project URL/,
  );
  assert.throws(
    () => normalizeGrokProjectUrl("https://grok.com/share/something"),
    /Grok project URL/,
  );
});

test("uses separate state and normalizes Grok queue limits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-config-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    ...grokBridgePaths({}),
    stateRoot: root,
    configFile: path.join(root, "config.json"),
  };
  const saved = await saveGrokConfig(
    {
      ...DEFAULT_GROK_CONFIG,
      projectUrl:
        "https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6",
      defaultModel: "Fast",
      maxConcurrent: 300,
      timeoutSeconds: 99_999,
      submissionIntervalSeconds: 600,
    },
    paths,
  );
  assert.equal(saved.defaultModel, "Fast");
  assert.equal(saved.maxConcurrent, 30);
  assert.equal(saved.timeoutSeconds, 14_400);
  assert.equal(saved.submissionIntervalSeconds, 60);
  assert.match(paths.stateRoot, /grok-config-test-/);
});
