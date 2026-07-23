#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { MAX_ATTACHMENTS } from "./lib/attachments.mjs";
import { AskJobQueue } from "./lib/bridge.mjs";
import {
  DEFAULT_STATUS_WAIT_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_SUBMISSION_INTERVAL_SECONDS,
} from "./lib/config.mjs";
import { GrokChromeBridge } from "./lib/grok-bridge.mjs";
import { DEFAULT_GROK_CONFIG } from "./lib/grok-config.mjs";
import { responseResourceLinks } from "./lib/mcp-output.mjs";

const bridge = await new GrokChromeBridge().initialize();
const jobs = new AskJobQueue(bridge);
const server = new McpServer({
  name: "grok-chrome-bridge",
  version: "0.1.0",
});

const attachmentPathsSchema = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe(
    `Up to ${MAX_ATTACHMENTS} exact absolute paths the user has authorized Codex to transmit to the signed-in Grok account. No directories, globs, symlinks, credentials, secrets, or browser-session data. HEIC/HEIF photos are sent as private temporary JPEG copies while originals remain unchanged. Grok receives no other local files or project context.`,
  );

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
      ...responseResourceLinks(data, { serviceName: "Grok" }),
    ],
    structuredContent: data,
    isError,
  };
}

function register(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return toolResult(await handler(args || {}));
    } catch (error) {
      return toolResult(
        {
          error: error instanceof Error ? error.message : String(error),
          recovery:
            "Check get_grok_bridge_status. If signed out, copy the Grok session from Jackson Stone Personal with refresh_grok_login_from_chrome or use open_grok_for_login. If controls changed, run sync_grok_options with force_rescan=true. Never duplicate a nonterminal job.",
        },
        true,
      );
    }
  });
}

function buildWritingPrompt({
  task,
  context,
  audience,
  voice,
  constraints,
  deliverable,
}) {
  const sections = [String(task).trim()];
  if (context?.trim()) sections.push(`Context:\n${context.trim()}`);
  if (audience?.trim()) sections.push(`Audience:\n${audience.trim()}`);
  if (voice?.trim()) sections.push(`Voice and tone:\n${voice.trim()}`);
  if (constraints?.trim()) {
    sections.push(`Constraints:\n${constraints.trim()}`);
  }
  if (deliverable?.trim()) {
    sections.push(`Deliverable:\n${deliverable.trim()}`);
  }
  return sections.join("\n\n");
}

async function createAndMaybeWait(params, wait, timeoutSeconds) {
  const job = jobs.create(params);
  if (!wait) return job;
  const waited = await jobs.wait(
    job.id,
    (timeoutSeconds ||
      bridge.config.timeoutSeconds ||
      DEFAULT_GROK_CONFIG.timeoutSeconds) + 5,
  );
  if (waited.status === "failed") throw new Error(waited.error);
  return waited;
}

register(
  "list_grok_chrome_profiles",
  {
    title: "List Grok Chrome Profiles",
    description:
      "List local Chrome profile directories and friendly names so the exact signed-in Grok account can be configured. This installation should use Jackson Stone Personal (Profile 1), regardless of which of the user's many Chrome profiles is currently focused.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  () => bridge.listProfiles(),
);

register(
  "configure_grok_bridge",
  {
    title: "Configure Grok Bridge",
    description:
      "Remember the exact Chrome profile, Grok project, background preference, default model, response deadline, per-worker concurrency, and global Send pacing. Profile resolution uses the profile name/directory, not the focused Chrome window. This installation defaults to Fast for natural writing, 30 concurrent tabs, a two-hour response deadline, and five seconds between actual submissions.",
    inputSchema: {
      profile: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Exact Chrome profile name or directory; use Jackson Stone Personal or Profile 1 on this Mac",
        ),
      project_url: z
        .string()
        .optional()
        .describe(
          "Default https://grok.com/project/<project-id> destination; empty clears it",
        ),
      headless: z
        .boolean()
        .optional()
        .describe(
          "Keep normal Grok workers in a focus-safe off-screen Chrome window",
        ),
      default_model: z
        .string()
        .optional()
        .describe(
          "Visible Grok model label. Fast is the writing default; current choices may include Auto, Expert, and Heavy.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Per-job response deadline in seconds (default 7200, maximum 14400); status waits do not cancel a job",
        ),
      max_concurrent: z
        .number()
        .int()
        .min(1)
        .max(MAX_CONCURRENT_JOBS)
        .optional()
        .describe("Maximum simultaneous Grok tabs in this Codex worker"),
      submission_interval_seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_SUBMISSION_INTERVAL_SECONDS)
        .optional()
        .describe(
          "Minimum cross-process gap between actual Grok Submit actions; defaults to five seconds",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (args) =>
    bridge.configure({
      profile: args.profile,
      projectUrl: args.project_url,
      headless: args.headless,
      defaultModel: args.default_model,
      timeoutSeconds: args.timeout_seconds,
      maxConcurrent: args.max_concurrent,
      submissionIntervalSeconds: args.submission_interval_seconds,
    }),
);

register(
  "open_grok_for_login",
  {
    title: "Open Grok for Login",
    description:
      "Open the bridge's isolated profile in ordinary native Chrome without automation or remote-debugging flags for one-time Grok sign-in. After signing in, quit that dedicated Chrome instance completely before syncing options.",
    inputSchema: {
      profile: z.string().min(1).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  (args) => bridge.openForLogin({ profile: args.profile }),
);

register(
  "refresh_grok_login_from_chrome",
  {
    title: "Refresh Grok Login From Chrome",
    description:
      "Refresh the bridge's isolated cookies and Grok site storage from an exact regular Chrome profile. Use Jackson Stone Personal (Profile 1) on this Mac. Passwords, tabs, history, and bookmarks are not copied.",
    inputSchema: {
      profile: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Exact source profile; configured Jackson Stone Personal/Profile 1 is used when omitted",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (args) => bridge.refreshLoginFromChrome({ profile: args.profile }),
);

register(
  "sync_grok_options",
  {
    title: "Sync Grok Options",
    description:
      "Verify the configured signed-in Grok session and dynamically discover current account model labels. Use force_rescan after a Grok UI update. The default is still Fast unless configuration changes it.",
    inputSchema: {
      profile: z.string().min(1).optional(),
      project_url: z.string().optional(),
      force_rescan: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  (args) =>
    bridge.syncOptions({
      profile: args.profile,
      projectUrl: args.project_url,
      forceRescan: args.force_rescan,
    }),
);

register(
  "write_with_grok",
  {
    title: "Write With Grok",
    description:
      "Use the signed-in Grok account as a context-isolated natural-writing worker for prose, rewrites, voice, tone, messaging, scripts, posts, correspondence, product/UX copy, and other standalone language work. Prefer this over a research subagent when the work needs no repository, terminal, local UI, or private project inspection and the main value is natural writing. Prefer ChatGPT for deep reasoning, research, complex analysis, factual synthesis, or verification. Grok receives only this tool call plus exact explicitly authorized attachments; it cannot see the Codex conversation, current task, project/repository, unlisted files, terminal, local UI, or other agents. The configured Grok project only organizes chats and supplies no Codex context. The prompt begins directly with the task and contains no worker-role preamble. New chats can run concurrently, actual submits are globally spaced five seconds apart, and status is retained by job ID.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "Complete standalone writing assignment that starts directly with the work; do not rely on prior Codex context",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Only the small non-secret facts intentionally sent to Grok; omitted means no local/project context beyond exact attachments",
        ),
      audience: z.string().optional(),
      voice: z
        .string()
        .optional()
        .describe("Desired voice, tone, cadence, reading level, or style traits"),
      constraints: z
        .string()
        .optional()
        .describe("Length, claims, phrases, format, and other explicit boundaries"),
      deliverable: z
        .string()
        .optional()
        .describe("Exact output type or variants requested"),
      attachments: attachmentPathsSchema,
      profile: z.string().min(1).optional(),
      project_url: z.string().optional(),
      model: z
        .string()
        .optional()
        .describe(
          "Visible model label; omit for configured Fast writing default. Available labels are discovered dynamically.",
        ),
      allow_fallback: z.boolean().default(false),
      wait: z.boolean().default(true),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Response deadline in seconds. A bounded wait ending is not a reason to duplicate a nonterminal job.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  (args) =>
    createAndMaybeWait(
      {
        jobLabel: args.task,
        prompt: buildWritingPrompt(args),
        attachments: args.attachments,
        profile: args.profile,
        projectUrl: args.project_url,
        model: args.model,
        newChat: true,
        allowFallback: args.allow_fallback,
        timeoutSeconds: args.timeout_seconds,
      },
      args.wait,
      args.timeout_seconds,
    ),
);

register(
  "ask_grok",
  {
    title: "Ask Grok",
    description:
      "Pass one complete user-authored standalone prompt to the selected signed-in Grok website account with no added framing. Use write_with_grok for Codex-created writing assignments. Grok sees only the prompt and exact authorized attachments—not the Codex conversation, local project, repository, terminal, UI, or unlisted files. Prefer ChatGPT for deep reasoning/research and Grok for natural writing.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "Complete standalone prompt; Grok has no implicit Codex or project context",
        ),
      attachments: attachmentPathsSchema,
      profile: z.string().min(1).optional(),
      project_url: z.string().optional(),
      model: z.string().optional(),
      new_chat: z.boolean().default(true),
      allow_fallback: z.boolean().default(false),
      wait: z.boolean().default(true),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  (args) =>
    createAndMaybeWait(
      {
        jobLabel: args.prompt,
        prompt: args.prompt,
        attachments: args.attachments,
        profile: args.profile,
        projectUrl: args.project_url,
        model: args.model,
        newChat: args.new_chat,
        allowFallback: args.allow_fallback,
        timeoutSeconds: args.timeout_seconds,
      },
      args.wait,
      args.timeout_seconds,
    ),
);

register(
  "list_grok_jobs",
  {
    title: "List Grok Jobs",
    description:
      "Return a fast nonblocking overview of Grok job IDs, queue positions, phases, conversation URLs, progress previews, timestamps, errors, and result metadata without full completed response text. queued, preparing, waiting_to_submit, and generating are healthy nonterminal phases. Keep each original job ID and do not submit duplicates.",
    inputSchema: {
      status: z
        .enum(["all", "queued", "running", "completed", "failed"])
        .default("all"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (args) => ({
    summary: jobs.summary(),
    globalSubmissionPacer: await bridge.submissionPacer.status(
      bridge.config.submissionIntervalSeconds,
    ),
    jobs: jobs.list({ status: args.status, limit: args.limit }),
  }),
);

register(
  "wait_for_grok_response",
  {
    title: "Wait for Grok Response",
    description:
      "Wait for or retrieve one existing Grok job by ID. The default five-minute call window does not cancel the underlying job. If it remains queued, preparing, waiting_to_submit, or generating, keep the same job ID and wait again. Never resubmit unless the original job reports failed.",
    inputSchema: {
      job_id: z.string().uuid(),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .default(DEFAULT_STATUS_WAIT_SECONDS),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const job = await jobs.wait(args.job_id, args.timeout_seconds);
    if (job.status === "failed") throw new Error(job.error);
    return job;
  },
);

register(
  "inspect_grok_conversation",
  {
    title: "Inspect Grok Conversation",
    description:
      "Browser fail-safe for one live or retained Grok job. It returns activity signals, response text, visible page text, diagnostics, and an optional screenshot without resubmitting. The worker can be brought on-screen for direct browser recovery and returns to automatic idle close afterward.",
    inputSchema: {
      job_id: z.string().uuid().optional(),
      conversation_url: z.string().url().optional(),
      browser_visibility: z
        .enum(["unchanged", "visible", "background"])
        .default("unchanged"),
      capture_screenshot: z.boolean().default(true),
      keep_open: z.boolean().default(false),
      profile: z.string().min(1).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    if (!args.job_id && !args.conversation_url) {
      throw new Error("Supply job_id or conversation_url to inspect Grok.");
    }
    if (args.job_id) jobs.get(args.job_id);
    return bridge.inspectConversation({
      jobId: args.job_id,
      conversationUrl: args.conversation_url,
      profile: args.profile,
      browserVisibility: args.browser_visibility,
      captureScreenshot: args.capture_screenshot,
      keepOpen: args.keep_open,
    });
  },
);

register(
  "get_grok_bridge_status",
  {
    title: "Get Grok Bridge Status",
    description:
      "Report configured profile/project/default model, browser lifecycle and visibility, authentication/UI diagnostics, cached Grok options, shared submission pacing, aggregate phases, and recent jobs. The configured profile directory is authoritative even when another Chrome profile is focused.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () => ({
    ...(await bridge.status()),
    jobs: jobs.summary(),
    recentJobs: jobs.list({ limit: 20 }),
  }),
);

register(
  "stop_grok_bridge",
  {
    title: "Stop Grok Bridge Browser",
    description:
      "Explicitly close this worker's Grok Chrome process. It normally closes itself after the queue and inspection activity become idle, while other Codex workers remain independent.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    await bridge.closeBrowser();
    return { stopped: true };
  },
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.closeBrowser();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
