import assert from "node:assert/strict";
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
    cwd: pluginRoot,
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
    "collect_chatgpt_response_files",
    "inspect_chatgpt_conversation",
    "list_chatgpt_jobs",
    "wait_for_chatgpt_response",
    "get_chatgpt_bridge_status",
  ]) {
    assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
  }
  const delegate = listed.tools.find(
    (tool) => tool.name === "delegate_research_to_chatgpt",
  );
  assert.match(delegate.description, /fields in this tool call plus the contents/);
  assert.match(delegate.description, /cannot see the Codex conversation/);
  assert.match(delegate.description, /only organizes chats/);
  assert.match(delegate.description, /globally paced five seconds apart/);
  assert.match(delegate.description, /take an hour or longer/);
  assert.match(delegate.description, /never submit a duplicate/);
  assert.match(
    delegate.inputSchema.properties.task.description,
    /Complete standalone assignment/,
  );
  assert.match(
    delegate.inputSchema.properties.context.description,
    /no local context beyond any exact explicit attachments/,
  );
  assert.equal(delegate.inputSchema.properties.attachments.maxItems, 10);
  assert.equal(
    delegate.inputSchema.properties.download_response_files.default,
    true,
  );
  assert.equal(delegate.inputSchema.properties.expect_response_files.default, false);
  assert.match(
    delegate.inputSchema.properties.response_file_output_directory.description,
    /never overwritten/,
  );
  assert.match(
    delegate.inputSchema.properties.attachments.description,
    /user has authorized Codex to transmit/,
  );
  assert.match(
    delegate.inputSchema.properties.attachments.description,
    /HEIC\/HEIF photos are sent as temporary JPEG copies/,
  );
  const directAsk = listed.tools.find((tool) => tool.name === "ask_chatgpt");
  assert.match(directAsk.description, /prompt plus the contents/);
  assert.match(
    directAsk.inputSchema.properties.prompt.description,
    /knows nothing about the Codex task or local project beyond this exact text/,
  );
  assert.equal(directAsk.inputSchema.properties.attachments.maxItems, 10);
  assert.equal(
    directAsk.inputSchema.properties.download_response_files.default,
    true,
  );
  const repositoryBundle = listed.tools.find(
    (tool) => tool.name === "prepare_repository_bundle",
  );
  assert.match(repositoryBundle.description, /performs no upload, Git commit, push/);
  assert.match(repositoryBundle.description, /cannot prove that every possible secret/);
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
  const collectFiles = listed.tools.find(
    (tool) => tool.name === "collect_chatgpt_response_files",
  );
  assert.match(collectFiles.description, /never resubmits the prompt/);
  assert.match(collectFiles.description, /MCP resource links/);
  const inspectConversation = listed.tools.find(
    (tool) => tool.name === "inspect_chatgpt_conversation",
  );
  assert.match(inspectConversation.description, /Browser fail-safe/);
  assert.deepEqual(
    inspectConversation.inputSchema.properties.browser_visibility.enum,
    ["unchanged", "visible", "background"],
  );
  const configure = listed.tools.find(
    (tool) => tool.name === "configure_chatgpt_bridge",
  );
  assert.equal(
    configure.inputSchema.properties.submission_interval_seconds.maximum,
    60,
  );
  assert.equal(configure.inputSchema.properties.timeout_seconds.maximum, 14_400);
  const listJobs = listed.tools.find((tool) => tool.name === "list_chatgpt_jobs");
  assert.match(listJobs.description, /waiting_to_submit/);
  assert.match(listJobs.description, /healthy nonterminal phases/);
  const waitForJob = listed.tools.find(
    (tool) => tool.name === "wait_for_chatgpt_response",
  );
  assert.equal(waitForJob.inputSchema.properties.timeout_seconds.default, 300);
  assert.match(waitForJob.description, /does not cancel/);
  assert.match(waitForJob.description, /same job ID/);
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
  assert.equal(jobStatus.structuredContent.globalSubmissionPacer.global, true);
  assert.ok(Array.isArray(jobStatus.structuredContent.jobs));
  const profiles = await client.callTool({ name: "list_chrome_profiles", arguments: {} });
  assert.equal(profiles.isError, false);
  assert.ok(Array.isArray(profiles.structuredContent.profiles));
});
