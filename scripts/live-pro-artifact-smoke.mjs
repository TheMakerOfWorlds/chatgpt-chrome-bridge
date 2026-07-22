#!/usr/bin/env node

import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outputDirectory = path.resolve(
  process.env.CHATGPT_LIVE_ARTIFACT_OUTPUT ||
    path.join(process.cwd(), "chatgpt-live-artifact-output"),
);
const projectUrl =
  process.env.CHATGPT_LIVE_PROJECT_URL ||
  "https://chatgpt.com/g/g-p-6a5e648cac488191befbdf735bb011fb/project";
const artifactPrompt =
  process.env.CHATGPT_LIVE_ARTIFACT_PROMPT ||
  "Create a tiny UTF-8 CSV file named bridge-pro-artifact.csv with exactly the columns item,status and exactly these two data rows: final_signal,passed and file_retrieval,passed. Return it as a downloadable file. In the final response, state that bridge-pro-artifact.csv is ready. Do not use external sources or personal data.";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
  cwd: pluginRoot,
});
const client = new Client({
  name: "chatgpt-chrome-bridge-live-artifact-smoke",
  version: "1.0.0",
});

function line(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
}

function assertSuccessful(result, operation) {
  if (result?.isError) {
    throw new Error(
      `${operation} failed: ${result.structuredContent?.error || "unknown error"}`,
    );
  }
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const synced = assertSuccessful(
    await client.callTool({
      name: "sync_chatgpt_options",
      arguments: { project_url: projectUrl, force_rescan: true },
    }),
    "option sync",
  );
  line("options_synced", {
    profile: synced.profile,
    projectUrl: synced.projectUrl,
    modelOptions: synced.modelOptions,
    reasoningOptions: synced.reasoningOptions,
  });

  const submitted = assertSuccessful(
    await client.callTool({
      name: "ask_chatgpt",
      arguments: {
        prompt: artifactPrompt,
        project_url: projectUrl,
        reasoning: "Pro",
        allow_fallback: false,
        wait: false,
        timeout_seconds: 7200,
        download_response_files: true,
        expect_response_files: true,
        response_file_output_directory: outputDirectory,
      },
    }),
    "Pro artifact submission",
  );
  const jobId = submitted.id;
  line("job_submitted", { jobId, phase: submitted.phase, outputDirectory });

  let terminal = submitted;
  let terminalToolResult = null;
  while (["queued", "running"].includes(terminal.status)) {
    const waited = await client.callTool({
      name: "wait_for_chatgpt_response",
      arguments: { job_id: jobId, timeout_seconds: 30 },
    });
    terminalToolResult = waited;
    terminal = assertSuccessful(waited, "job wait");
    line("job_status", {
      jobId,
      status: terminal.status,
      phase: terminal.phase,
      conversationUrl: terminal.conversationUrl,
      progress: terminal.progress
        ? {
            preview: String(terminal.progress.preview || "").slice(0, 300),
            active: terminal.progress.active,
            activeSignal: terminal.progress.activeSignal,
            terminalCandidate: terminal.progress.terminalCandidate,
            looksInterim: terminal.progress.looksInterim,
            responseFileCandidateNames:
              terminal.progress.responseFileCandidateNames || [],
          }
        : null,
    });
  }
  if (terminal.status !== "completed") {
    throw new Error(`Pro artifact job ended as ${terminal.status}: ${terminal.error}`);
  }

  const inspectionResult = await client.callTool({
    name: "inspect_chatgpt_conversation",
    arguments: {
      job_id: jobId,
      browser_visibility: "background",
      capture_screenshot: true,
      keep_open: false,
    },
  });
  const inspection = assertSuccessful(inspectionResult, "conversation inspection");
  const cachedCollectionResult = await client.callTool({
    name: "collect_chatgpt_response_files",
    arguments: { job_id: jobId, rescan: false },
  });
  const cachedCollection = assertSuccessful(
    cachedCollectionResult,
    "cached response-file collection",
  );

  line("live_test_complete", {
    jobId,
    conversationUrl: terminal.result?.conversationUrl,
    model: terminal.result?.model,
    reasoning: terminal.result?.reasoning,
    completionSignal: terminal.result?.completionSignal,
    responseCompletion: terminal.result?.responseCompletion,
    responsePreview: String(terminal.result?.response || "").slice(0, 1_000),
    responseFiles: terminal.result?.responseFiles,
    responseResourceLinks: (terminalToolResult?.content || []).filter(
      (item) => item.type === "resource_link",
    ),
    cachedResponseFiles: cachedCollection.responseFiles,
    cachedResourceLinks: (cachedCollectionResult.content || []).filter(
      (item) => item.type === "resource_link",
    ),
    inspection: {
      screenshotPath: inspection.screenshotPath,
      screenshotError: inspection.screenshotError,
      latestAssistant: inspection.snapshot?.latestAssistant,
      active: inspection.snapshot?.active,
      responseFileCandidates: inspection.snapshot?.responseFileCandidates,
    },
    inspectionResourceLinks: (inspectionResult.content || []).filter(
      (item) => item.type === "resource_link",
    ),
  });
} catch (error) {
  line("live_test_failed", {
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
