#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conversationUrl = String(
  process.env.CHATGPT_EXISTING_CONVERSATION_URL || "",
).trim();
if (!conversationUrl) {
  throw new Error("Set CHATGPT_EXISTING_CONVERSATION_URL to the exact ChatGPT URL.");
}
const outputDirectory = path.resolve(
  process.env.CHATGPT_LIVE_ARTIFACT_OUTPUT ||
    path.join(process.cwd(), "chatgpt-live-mcp-recovery"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
  cwd: pluginRoot,
});
const client = new Client({
  name: "chatgpt-chrome-bridge-live-mcp-recovery",
  version: "1.0.0",
});

function checked(result, operation) {
  if (result?.isError) {
    throw new Error(
      `${operation} failed: ${result.structuredContent?.error || "unknown error"}`,
    );
  }
  return result;
}

try {
  await client.connect(transport);
  const inspectionResult = checked(
    await client.callTool({
      name: "inspect_chatgpt_conversation",
      arguments: {
        conversation_url: conversationUrl,
        browser_visibility: "background",
        capture_screenshot: true,
        keep_open: true,
      },
    }),
    "MCP inspection",
  );
  const collectionResult = checked(
    await client.callTool({
      name: "collect_chatgpt_response_files",
      arguments: {
        conversation_url: conversationUrl,
        output_directory: outputDirectory,
        expected: true,
        rescan: true,
        keep_open: false,
      },
    }),
    "MCP response-file collection",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        event: "mcp_response_recovery_complete",
        conversationUrl,
        inspection: {
          screenshotPath: inspectionResult.structuredContent?.screenshotPath,
          hydration: inspectionResult.structuredContent?.hydration,
          latestAssistant:
            inspectionResult.structuredContent?.snapshot?.latestAssistant,
          responseFileCandidates:
            inspectionResult.structuredContent?.snapshot?.responseFileCandidates,
          resourceLinks: (inspectionResult.content || []).filter(
            (item) => item.type === "resource_link",
          ),
        },
        collection: collectionResult.structuredContent,
        resourceLinks: (collectionResult.content || []).filter(
          (item) => item.type === "resource_link",
        ),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close().catch(() => {});
}
