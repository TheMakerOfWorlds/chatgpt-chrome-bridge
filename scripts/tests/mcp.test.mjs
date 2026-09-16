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

test("MCP server advertises the optimized ChatGPT command surface", async (t) => {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "chatgpt-bridge-mcp-test-"),
  );
  const stateRoot = path.join(fixtureRoot, "state");
  const chromeUserData = path.join(fixtureRoot, "chrome");
  await fs.mkdir(path.join(chromeUserData, "Profile 2"), { recursive: true });
  await fs.writeFile(
    path.join(chromeUserData, "Local State"),
    `${JSON.stringify({
      profile: {
        last_used: "Profile 2",
        info_cache: {
          "Profile 2": { name: "Test ChatGPT" },
        },
      },
    })}\n`,
  );
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));

  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
    cwd: pluginRoot,
    env: {
      ...childEnv,
      CHATGPT_CHROME_BRIDGE_STATE_DIR: stateRoot,
      CHATGPT_CHROME_USER_DATA_DIR: chromeUserData,
    },
  });
  const client = new Client({ name: "bridge-test-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of [
    "list_chrome_profiles",
    "configure_chatgpt_bridge",
    "open_chatgpt_for_login",
    "sync_chatgpt_options",
    "prepare_repository_bundle",
    "delegate_research_to_chatgpt",
    "ask_chatgpt",
    "reply_to_chatgpt_conversation",
    "collect_chatgpt_response_files",
    "inspect_chatgpt_conversation",
    "list_chatgpt_jobs",
    "wait_for_chatgpt_response",
    "get_chatgpt_bridge_status",
    "check_chatgpt_bridge_updates",
    "update_chatgpt_bridge",
  ]) {
    assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
  }
  const delegate = listed.tools.find(
    (tool) => tool.name === "delegate_research_to_chatgpt",
  );
  assert.equal(delegate.inputSchema.properties.attachments.maxItems, 10);
  assert.equal(delegate.inputSchema.properties.model, undefined);
  assert.ok(delegate.inputSchema.properties.reasoning);
  assert.equal(
    delegate.inputSchema.properties.download_response_files.default,
    true,
  );
  assert.equal(delegate.inputSchema.properties.expect_response_files.default, false);
  const directAsk = listed.tools.find((tool) => tool.name === "ask_chatgpt");
  assert.equal(directAsk.inputSchema.properties.attachments.maxItems, 10);
  assert.equal(directAsk.inputSchema.properties.model, undefined);
  assert.equal(directAsk.inputSchema.properties.new_chat, undefined);
  assert.ok(directAsk.inputSchema.properties.reasoning);
  assert.equal(
    directAsk.inputSchema.properties.download_response_files.default,
    true,
  );
  const reply = listed.tools.find(
    (tool) => tool.name === "reply_to_chatgpt_conversation",
  );
  assert.ok(reply.inputSchema.properties.job_id);
  assert.ok(reply.inputSchema.properties.conversation_url);
  assert.ok(reply.inputSchema.properties.prompt);
  assert.equal(reply.inputSchema.properties.attachments.maxItems, 10);
  assert.equal(reply.inputSchema.properties.model, undefined);
  assert.equal(reply.inputSchema.properties.project_url, undefined);
  assert.equal(reply.inputSchema.properties.new_chat, undefined);
  assert.ok(reply.inputSchema.properties.reasoning);
  assert.equal(reply.inputSchema.properties.wait.default, true);
  assert.equal(reply.inputSchema.properties.download_response_files.default, true);
  const repositoryBundle = listed.tools.find(
    (tool) => tool.name === "prepare_repository_bundle",
  );
  assert.deepEqual(repositoryBundle.inputSchema.properties.selection.enum, [
    "git-worktree",
    "git-tracked",
    "selected",
    "directory",
  ]);
  assert.equal(repositoryBundle.inputSchema.properties.selection.default, "git-worktree");
  assert.equal(
    repositoryBundle.inputSchema.properties.max_total_megabytes.default,
    80,
  );
  assert.equal(repositoryBundle.inputSchema.properties.max_files.default, 5_000);
  const inspectConversation = listed.tools.find(
    (tool) => tool.name === "inspect_chatgpt_conversation",
  );
  assert.deepEqual(
    inspectConversation.inputSchema.properties.browser_visibility.enum,
    ["unchanged", "visible", "background"],
  );
  assert.equal(
    inspectConversation.inputSchema.properties.keep_open.default,
    false,
  );
  const configure = listed.tools.find(
    (tool) => tool.name === "configure_chatgpt_bridge",
  );
  assert.equal(configure.inputSchema.properties.default_model, undefined);
  assert.ok(configure.inputSchema.properties.default_reasoning);
  assert.equal(
    configure.inputSchema.properties.submission_interval_seconds.maximum,
    60,
  );
  assert.equal(configure.inputSchema.properties.timeout_seconds.maximum, 14_400);
  const waitForJob = listed.tools.find(
    (tool) => tool.name === "wait_for_chatgpt_response",
  );
  assert.equal(waitForJob.inputSchema.properties.timeout_seconds.default, 300);
  const invalidCollection = await client.callTool({
    name: "collect_chatgpt_response_files",
    arguments: {},
  });
  assert.equal(invalidCollection.isError, true);
  assert.match(invalidCollection.structuredContent.error, /job_id or conversation_url/);
  const invalidInspection = await client.callTool({
    name: "inspect_chatgpt_conversation",
    arguments: {},
  });
  assert.equal(invalidInspection.isError, true);
  assert.match(invalidInspection.structuredContent.error, /job_id or conversation_url/);
  const invalidReplyTarget = await client.callTool({
    name: "reply_to_chatgpt_conversation",
    arguments: { prompt: "Follow up" },
  });
  assert.equal(invalidReplyTarget.isError, true);
  assert.match(invalidReplyTarget.structuredContent.error, /exactly one/);
  const invalidReplyUrl = await client.callTool({
    name: "reply_to_chatgpt_conversation",
    arguments: {
      conversation_url: "https://example.com/c/not-chatgpt",
      prompt: "Follow up",
    },
  });
  assert.equal(invalidReplyUrl.isError, true);
  assert.match(invalidReplyUrl.structuredContent.error, /ChatGPT conversation URL/);
  const invalidBundle = await client.callTool({
    name: "prepare_repository_bundle",
    arguments: { repository_root: "/" },
  });
  assert.equal(invalidBundle.isError, true);
  assert.match(invalidBundle.structuredContent.error, /filesystem root/);
  const jobStatus = await client.callTool({
    name: "list_chatgpt_jobs",
    arguments: {},
  });
  assert.equal(jobStatus.isError, false);
  assert.equal(jobStatus.structuredContent.globalSubmissionPacer, undefined);
  const detailedJobs = await client.callTool({name: "list_chatgpt_jobs", arguments: {details: true}});
  assert.equal(detailedJobs.structuredContent.globalSubmissionPacer.global, true);
  assert.ok(Array.isArray(jobStatus.structuredContent.jobs));
  const bridgeStatus = await client.callTool({
    name: "get_chatgpt_bridge_status",
    arguments: {},
  });
  assert.equal(bridgeStatus.isError, false);
  assert.equal(bridgeStatus.structuredContent.browserRunning, false);
  assert.equal(bridgeStatus.structuredContent.config.projectUrl, null);
  assert.equal(bridgeStatus.structuredContent.jobs.running, 0);
  assert.equal(bridgeStatus.structuredContent.recentJobs, undefined);
  assert.equal(bridgeStatus.structuredContent.browserCache, undefined);
  const detailedStatus = await client.callTool({name: "get_chatgpt_bridge_status", arguments: {details: true}});
  assert.equal(detailedStatus.structuredContent.browserLifecycle.activeOperations, 0);
  assert.equal(detailedStatus.structuredContent.browserLifecycle.idleCloseScheduled, false);
  assert.ok(Array.isArray(detailedStatus.structuredContent.cachedReasoningOptions));
  assert.ok(Array.isArray(detailedStatus.structuredContent.recentJobs));
  assert.ok(detailedStatus.structuredContent.browserCache);
  for (const name of ["get_chatgpt_bridge_status", "list_chatgpt_jobs", "wait_for_chatgpt_response", "ask_chatgpt", "delegate_research_to_chatgpt", "reply_to_chatgpt_conversation"]) {
    assert.equal(listed.tools.find(tool => tool.name === name).inputSchema.properties.details.default, false);
  }
  const profiles = await client.callTool({ name: "list_chrome_profiles", arguments: {} });
  assert.equal(profiles.isError, false);
  assert.ok(Array.isArray(profiles.structuredContent.profiles));
});
