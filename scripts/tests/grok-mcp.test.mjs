import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("Grok MCP server advertises a context-isolated writing surface", async (t) => {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "grok-bridge-mcp-test-"),
  );
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const stateRoot = path.join(fixtureRoot, "state");
  const chromeUserData = path.join(fixtureRoot, "chrome");
  await fs.mkdir(path.join(chromeUserData, "Profile 1"), { recursive: true });
  await fs.writeFile(
    path.join(chromeUserData, "Local State"),
    `${JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: {
          Default: { name: "Other Account" },
          "Profile 1": { name: "Jackson Stone Personal" },
        },
      },
    })}\n`,
  );

  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "grok-mcp-server.mjs")],
    cwd: pluginRoot,
    env: {
      ...childEnv,
      GROK_CHROME_BRIDGE_STATE_DIR: stateRoot,
      GROK_CHROME_USER_DATA_DIR: chromeUserData,
    },
  });
  const client = new Client({ name: "grok-test-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of [
    "list_grok_chrome_profiles",
    "configure_grok_bridge",
    "open_grok_for_login",
    "refresh_grok_login_from_chrome",
    "sync_grok_options",
    "write_with_grok",
    "ask_grok",
    "list_grok_jobs",
    "wait_for_grok_response",
    "inspect_grok_conversation",
    "get_grok_bridge_status",
    "stop_grok_bridge",
  ]) {
    assert.ok(names.includes(expected), `missing Grok MCP tool ${expected}`);
  }
  const write = listed.tools.find((tool) => tool.name === "write_with_grok");
  assert.match(write.description, /natural-writing worker/);
  assert.match(write.description, /Prefer ChatGPT for deep reasoning/);
  assert.match(write.description, /cannot see the Codex conversation/);
  assert.match(write.description, /no worker-role preamble/);
  assert.equal(write.inputSchema.properties.attachments.maxItems, 10);
  assert.match(
    write.inputSchema.properties.context.description,
    /no local\/project context/,
  );

  const profiles = await client.callTool({
    name: "list_grok_chrome_profiles",
    arguments: {},
  });
  assert.equal(profiles.isError, false);
  assert.ok(
    profiles.structuredContent.profiles.some(
      (profile) =>
        profile.directory === "Profile 1" &&
        profile.name === "Jackson Stone Personal",
    ),
  );
  const configured = await client.callTool({
    name: "configure_grok_bridge",
    arguments: {
      profile: "Jackson Stone Personal",
      project_url:
        "https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6",
      default_model: "Fast",
      max_concurrent: 30,
      submission_interval_seconds: 5,
    },
  });
  assert.equal(configured.isError, false);
  assert.equal(configured.structuredContent.config.profile, "Profile 1");
  assert.equal(configured.structuredContent.config.defaultModel, "Fast");
  assert.equal(configured.structuredContent.config.maxConcurrent, 30);

  const status = await client.callTool({
    name: "get_grok_bridge_status",
    arguments: {},
  });
  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.config.profile, "Profile 1");
  assert.equal(status.structuredContent.browserRunning, false);
  assert.equal(
    status.structuredContent.browserLifecycle.activeOperations,
    0,
  );
  const invalidInspection = await client.callTool({
    name: "inspect_grok_conversation",
    arguments: {},
  });
  assert.equal(invalidInspection.isError, true);
  assert.match(invalidInspection.structuredContent.error, /job_id or conversation_url/);
});
