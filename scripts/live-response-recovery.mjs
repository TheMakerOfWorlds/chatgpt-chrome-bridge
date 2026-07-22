#!/usr/bin/env node

import path from "node:path";

import { ChatGptChromeBridge } from "./lib/bridge.mjs";
import { responseResourceLinks } from "./lib/mcp-output.mjs";

const conversationUrl = String(
  process.env.CHATGPT_EXISTING_CONVERSATION_URL || "",
).trim();
if (!conversationUrl) {
  throw new Error("Set CHATGPT_EXISTING_CONVERSATION_URL to the exact ChatGPT URL.");
}
const outputDirectory = path.resolve(
  process.env.CHATGPT_LIVE_ARTIFACT_OUTPUT ||
    path.join(process.cwd(), "chatgpt-live-artifact-recovery"),
);
const bridge = await new ChatGptChromeBridge().initialize();

function compactSnapshot(snapshot) {
  return {
    url: snapshot?.url,
    active: snapshot?.active,
    latestAssistant: snapshot?.latestAssistant,
    responseFileCandidates: snapshot?.responseFileCandidates,
    responseFileUiHints: snapshot?.responseFileUiHints,
    topToolbarUiHints: (snapshot?.interactiveUiHints || []).filter(
      (hint) => hint.bounds?.y < 140 && hint.bounds?.x > 600,
    ),
  };
}

try {
  const inspection = await bridge.inspectConversation({
    conversationUrl,
    browserVisibility: "background",
    captureScreenshot: true,
    keepOpen: true,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        event: "conversation_inspected",
        conversationUrl: inspection.conversationUrl,
        hydration: inspection.hydration,
        screenshotPath: inspection.screenshotPath,
        snapshot: compactSnapshot(inspection.snapshot),
        resources: responseResourceLinks(inspection),
      },
      null,
      2,
    )}\n`,
  );
  const responseFiles = await bridge.collectConversationFiles({
    conversationUrl,
    outputDirectory,
    expected: true,
    rescan: true,
    keepOpen: false,
  });
  const postCollectionInspection = responseFiles.inspectionRecommended
    ? await bridge.inspectConversation({
        conversationUrl,
        browserVisibility: "background",
        captureScreenshot: true,
        keepOpen: true,
      })
    : null;
  process.stdout.write(
    `${JSON.stringify(
      {
        event: "response_files_collected",
        conversationUrl,
        responseFiles,
        resources: responseResourceLinks({ responseFiles }),
        postCollectionInspection: postCollectionInspection
          ? {
              conversationUrl: postCollectionInspection.conversationUrl,
              screenshotPath: postCollectionInspection.screenshotPath,
              snapshot: compactSnapshot(postCollectionInspection.snapshot),
            }
          : null,
        postCollectionResources: responseResourceLinks(
          postCollectionInspection || {},
        ),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await bridge.closeBrowser();
}
