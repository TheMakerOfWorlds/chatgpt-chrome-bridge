#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { installationPaths, updateInstallation } from "./lib/releases.mjs";
import { readJson } from "./lib/config.mjs";

if (process.argv.includes("--healthcheck")) {
  process.stdout.write("ChatGPT Bridge dependencies loaded successfully.\n");
  process.exit(0);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AskJobQueue, ChatGptChromeBridge } from "./lib/bridge.mjs";
import { MAX_ATTACHMENTS } from "./lib/attachments.mjs";
import {
  DEFAULT_CONFIG,
  DEFAULT_STATUS_WAIT_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_SUBMISSION_INTERVAL_SECONDS,
} from "./lib/config.mjs";
import { buildDelegationPrompt } from "./lib/delegation.mjs";
import { compactJob, compactBridgeStatus } from "./lib/compact-output.mjs";
import { responseResourceLinks } from "./lib/mcp-output.mjs";
import {
  createRepositoryBundle,
  DEFAULT_BUNDLE_MAX_BYTES,
  DEFAULT_BUNDLE_MAX_FILE_BYTES,
  DEFAULT_BUNDLE_MAX_FILES,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_FILES,
} from "./lib/repository-bundle.mjs";

const bridge = await new ChatGptChromeBridge().initialize();
const jobs = new AskJobQueue(bridge);
const server = new McpServer({
  name: "chatgpt-chrome-bridge",
  version: (await readJson(fileURLToPath(new URL("../package.json", import.meta.url)))).version,
});

const detailsSchema = z.boolean().default(false).describe("Include full diagnostic metadata.");

const attachmentPathsSchema = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe(
    `Up to ${MAX_ATTACHMENTS} exact absolute files authorized for upload to ChatGPT. No directories, globs, symlinks, secrets or session data. HEIC/HEIF is sent as JPEG; originals remain unchanged.`,
  );

const responseFileOutputDirectorySchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "response_file_output_directory must be an absolute path",
  })
  .optional()
  .describe(
    "Absolute output directory; defaults to private bridge storage. Existing files are never overwritten.",
  );

const downloadResponseFilesSchema = z
  .boolean()
  .default(true)
  .describe(
    "Download generated files using the signed-in session.",
  );

const expectResponseFilesSchema = z
  .boolean()
  .default(false)
  .describe(
    "Set true for requested file deliverables; missing files trigger recovery guidance.",
  );

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
      ...responseResourceLinks(data),
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
            "Check get_chatgpt_bridge_status. If signed out, use open_chatgpt_for_login. " +
            "If the UI changed, run sync_chatgpt_options with force_rescan=true.",
        },
        true,
      );
    }
  });
}

register(
  "list_chrome_profiles",
  {
    title: "List Chrome Profiles",
    description:
      "List local Chrome profiles for account selection; does not open Chrome.",
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
  "configure_chatgpt_bridge",
  {
    title: "Configure ChatGPT Bridge",
    description:
      "Save account profile, project and runtime preferences. Keeps the website model unchanged.",
    inputSchema: {
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
      project_url: z
        .string()
        .optional()
        .describe("Default https://chatgpt.com/g/g-p-…/project URL; empty clears it"),
      headless: z
        .boolean()
        .optional()
        .describe("Run normal ChatGPT requests in the background when true"),
      default_reasoning: z
        .string()
        .optional()
        .describe("Visible reasoning label or alias such as high, xhigh, max, or pro"),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Job response deadline, not a status-wait interval.",
        ),
      max_concurrent: z
        .number()
        .int()
        .min(1)
        .max(MAX_CONCURRENT_JOBS)
        .optional()
        .describe("Maximum simultaneous ChatGPT tabs in this Codex worker"),
      submission_interval_seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_SUBMISSION_INTERVAL_SECONDS)
        .optional()
        .describe(
          "Minimum global gap between actual Send actions across all Codex bridge workers; defaults to 5 seconds",
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
      defaultReasoning: args.default_reasoning,
      timeoutSeconds: args.timeout_seconds,
      maxConcurrent: args.max_concurrent,
      submissionIntervalSeconds: args.submission_interval_seconds,
    }),
);

register(
  "open_chatgpt_for_login",
  {
    title: "Open ChatGPT for Login",
    description:
      "Open native Chrome for user sign-in. After login, quit that dedicated instance with Command-Q before syncing options.",
    inputSchema: {
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
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
  "refresh_login_from_chrome",
  {
    title: "Refresh Login From Chrome",
    description:
      "Restart the private browser and copy the selected local Chrome profile's ChatGPT session. Excludes passwords and history.",
    inputSchema: {
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
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
  "sync_chatgpt_options",
  {
    title: "Sync ChatGPT Options",
    description:
      "Verify sign-in and discover available thinking efforts without changing the model. Use force_rescan for stale UI controls.",
    inputSchema: {
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
      project_url: z
        .string()
        .optional()
        .describe("Optional ChatGPT project destination; configured default is used otherwise"),
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
  "prepare_repository_bundle",
  {
    title: "Prepare Sanitized Repository Bundle",
    description:
      "Create a local secret-scanned ZIP and manifest from an authorized repository. No upload or Git changes. Secret detection is incomplete; review the bundle before separately authorizing attachment.",
    inputSchema: {
      repository_root: z
        .string()
        .min(1)
        .refine((value) => path.isAbsolute(value), {
          message: "repository_root must be an absolute path",
        })
        .describe(
          "Exact absolute user-authorized repository or directory root. Filesystem roots, the whole home directory, credentials, keychains, Chrome profiles, Codex state, and bridge state are refused.",
        ),
      selection: z
        .enum(["git-worktree", "git-tracked", "selected", "directory"])
        .default("git-worktree")
        .describe(
          "git-worktree includes tracked and non-ignored untracked files; git-tracked includes only tracked files; selected recursively expands only include_paths; directory walks the exact root while applying the same hard exclusions.",
        ),
      include_paths: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe(
          "For selection=selected, exact relative files or directories inside repository_root. Absolute paths, parent traversal, backslashes, symlinks, and unsafe trees are rejected or excluded.",
        ),
      exclude_paths: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe(
          "Optional additional relative files or directory prefixes to exclude. Mandatory security exclusions cannot be disabled.",
        ),
      output_directory: z
        .string()
        .min(1)
        .refine((value) => path.isAbsolute(value), {
          message: "output_directory must be an absolute path",
        })
        .optional()
        .describe(
          "Private absolute local destination for the ZIP and manifest. Existing files are never overwritten. Omit to use the bridge state directory.",
        ),
      archive_name: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Optional filename stem; unsafe characters are normalized and .zip is added."),
      max_total_megabytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_BUNDLE_BYTES / (1024 * 1024))
        .default(DEFAULT_BUNDLE_MAX_BYTES / (1024 * 1024))
        .describe(
          "Maximum uncompressed included bytes in MB. The default 80 MB stays below the bridge's 100 MB attachment ceiling; exceeding the limit aborts instead of silently truncating.",
        ),
      max_file_megabytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_BUNDLE_FILE_BYTES / (1024 * 1024))
        .default(DEFAULT_BUNDLE_MAX_FILE_BYTES / (1024 * 1024))
        .describe(
          "Maximum candidate file size in MB. Larger files are explicitly excluded from the manifest.",
        ),
      max_files: z
        .number()
        .int()
        .min(1)
        .max(MAX_BUNDLE_FILES)
        .default(DEFAULT_BUNDLE_MAX_FILES)
        .describe(
          "Maximum candidate path count. Exceeding it aborts so the caller can deliberately narrow the selection.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (args) =>
    createRepositoryBundle({
      repositoryRoot: args.repository_root,
      selection: args.selection,
      includePaths: args.include_paths || [],
      excludePaths: args.exclude_paths || [],
      outputDirectory: args.output_directory,
      archiveName: args.archive_name,
      stateRoot: bridge.paths.stateRoot,
      workerId: bridge.workerId,
      maxTotalBytes: args.max_total_megabytes * 1024 * 1024,
      maxFileBytes: args.max_file_megabytes * 1024 * 1024,
      maxFiles: args.max_files,
    }),
);

register(
  "delegate_research_to_chatgpt",
  {
    title: "Delegate Research to ChatGPT",
    description:
      "Delegate a standalone research, analysis or drafting task to ChatGPT. It sees only this prompt and authorized attachments, not Codex/local context; projects only organize chats. For long/parallel work use wait=false, retain the job ID, then wait for that same job. Never duplicate active work; Pro can take hours.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "Standalone assignment with all required context.",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Additional non-secret facts to share; no implicit local context.",
        ),
      deliverable: z
        .string()
        .optional()
        .describe(
          "Required output format, audience and acceptance criteria.",
        ),
      attachments: attachmentPathsSchema,
      download_response_files: downloadResponseFilesSchema,
      expect_response_files: expectResponseFilesSchema,
      response_file_output_directory: responseFileOutputDirectorySchema,
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
      project_url: z
        .string()
        .optional()
        .describe("Optional ChatGPT project destination; configured default is used otherwise"),
      reasoning: z
        .string()
        .optional()
        .describe("Visible label or alias: fast, low, medium, high, xhigh, max, pro, or auto"),
      allow_fallback: z.boolean().default(false),
      wait: z.boolean().default(true),
      details: detailsSchema,
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Job response deadline, not a polling interval. Never duplicate an active job.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const job = jobs.create({
      jobLabel: args.task,
      prompt: buildDelegationPrompt(args),
      attachments: args.attachments,
      profile: args.profile,
      projectUrl: args.project_url,
      reasoning: args.reasoning,
      newChat: true,
      allowFallback: args.allow_fallback,
      timeoutSeconds: args.timeout_seconds,
      downloadResponseFiles: args.download_response_files,
      expectResponseFiles: args.expect_response_files,
      responseFileOutputDirectory: args.response_file_output_directory,
    });
    if (!args.wait) return args.details ? job : compactJob(job);
    const waited = await jobs.wait(
      job.id,
      (args.timeout_seconds ||
        bridge.config.timeoutSeconds ||
        DEFAULT_CONFIG.timeoutSeconds) + 5,
    );
    if (waited.status === "failed") throw new Error(waited.error);
    return args.details ? waited : compactJob(waited);
  },
);

register(
  "ask_chatgpt",
  {
    title: "Ask ChatGPT",
    description:
      "Send a standalone user prompt to a new ChatGPT chat. Only the prompt and authorized attachments are shared; no implicit Codex/local context. For long jobs use wait=false and retain the ID. Never duplicate an active job. Use reply_to_chatgpt_conversation for follow-ups.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "Standalone prompt; include all needed context.",
        ),
      attachments: attachmentPathsSchema,
      download_response_files: downloadResponseFilesSchema,
      expect_response_files: expectResponseFilesSchema,
      response_file_output_directory: responseFileOutputDirectorySchema,
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
      project_url: z
        .string()
        .optional()
        .describe("Optional ChatGPT project destination; configured default is used otherwise"),
      reasoning: z
        .string()
        .optional()
        .describe("Visible label or alias: fast, low, medium, high, xhigh, max, pro, or auto"),
      allow_fallback: z
        .boolean()
        .default(false)
        .describe("Allow a requested unavailable option to fall back to a discovered option"),
      wait: z.boolean().default(true),
      details: detailsSchema,
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Job response deadline, not a polling interval. Never duplicate an active job.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const job = jobs.create({
      jobLabel: args.prompt,
      prompt: args.prompt,
      attachments: args.attachments,
      profile: args.profile,
      projectUrl: args.project_url,
      reasoning: args.reasoning,
      newChat: true,
      allowFallback: args.allow_fallback,
      timeoutSeconds: args.timeout_seconds,
      downloadResponseFiles: args.download_response_files,
      expectResponseFiles: args.expect_response_files,
      responseFileOutputDirectory: args.response_file_output_directory,
    });
    if (!args.wait) return args.details ? job : compactJob(job);
    const waited = await jobs.wait(
      job.id,
      (args.timeout_seconds ||
        bridge.config.timeoutSeconds ||
        DEFAULT_CONFIG.timeoutSeconds) + 5,
    );
    if (waited.status === "failed") throw new Error(waited.error);
    return args.details ? waited : compactJob(waited);
  },
);

register(
  "reply_to_chatgpt_conversation",
  {
    title: "Reply to ChatGPT Conversation",
    description:
      "Continue one completed chat using exactly one job_id or conversation_url. Inherits that ChatGPT history only; include all new context explicitly. Returns a new job ID; track that ID. Active same-chat replies serialize. Never duplicate active work.",
    inputSchema: {
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Completed ChatGPT job in this Codex worker. The bridge resolves its exact conversation URL and records reply lineage.",
        ),
      conversation_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Exact https://chatgpt.com/c/… or https://chatgpt.com/g/…/c/… URL. Use when the original job belongs to another worker/task or its local record was pruned.",
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "Complete follow-up message. It may rely on the selected ChatGPT conversation history, but must explicitly include all new Codex/task/local facts ChatGPT needs.",
        ),
      attachments: attachmentPathsSchema,
      download_response_files: downloadResponseFilesSchema,
      expect_response_files: expectResponseFilesSchema,
      response_file_output_directory: responseFileOutputDirectorySchema,
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
      reasoning: z
        .string()
        .optional()
        .describe("Visible effort label or alias: fast, low, medium, high, xhigh, max, pro, or auto"),
      allow_fallback: z
        .boolean()
        .default(false)
        .describe("Allow a requested unavailable effort to fall back to a discovered option"),
      wait: z.boolean().default(true),
      details: detailsSchema,
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Job response deadline; same-chat contention and long Pro runs remain active.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    if (Boolean(args.job_id) === Boolean(args.conversation_url)) {
      throw new Error(
        "Supply exactly one of job_id or conversation_url to reply to a ChatGPT conversation.",
      );
    }
    const job = jobs.createReply({
      sourceJobId: args.job_id,
      conversationUrl: args.conversation_url,
      jobLabel: args.prompt,
      prompt: args.prompt,
      attachments: args.attachments,
      profile: args.profile,
      reasoning: args.reasoning,
      allowFallback: args.allow_fallback,
      timeoutSeconds: args.timeout_seconds,
      downloadResponseFiles: args.download_response_files,
      expectResponseFiles: args.expect_response_files,
      responseFileOutputDirectory: args.response_file_output_directory,
    });
    if (!args.wait) return args.details ? job : compactJob(job);
    const waited = await jobs.wait(
      job.id,
      (args.timeout_seconds ||
        bridge.config.timeoutSeconds ||
        DEFAULT_CONFIG.timeoutSeconds) + 5,
    );
    if (waited.status === "failed") throw new Error(waited.error);
    return args.details ? waited : compactJob(waited);
  },
);

register(
  "collect_chatgpt_response_files",
  {
    title: "Collect ChatGPT Response Files",
    description:
      "Retrieve generated files from an existing completed chat as local MCP resource links; never resubmits. Use the same job/URL for recovery. rescan=false reuses cached downloads; inspect if extraction remains incomplete.",
    inputSchema: {
      job_id: z.string().uuid().optional(),
      conversation_url: z
        .string()
        .url()
        .optional()
        .describe("Exact ChatGPT conversation URL when a bridge job ID is unavailable"),
      output_directory: z
        .string()
        .min(1)
        .refine((value) => path.isAbsolute(value), {
          message: "output_directory must be an absolute path",
        })
        .optional()
        .describe(
          "Exact absolute local output directory. Existing files are never overwritten.",
        ),
      expected: z
        .boolean()
        .default(true)
        .describe("Wait for file controls and report none_found when no file appears"),
      rescan: z
        .boolean()
        .default(true)
        .describe(
          "Re-scan the conversation. Set false to return cached collection metadata for the job without downloading again.",
        ),
      keep_open: z
        .boolean()
        .default(false)
        .describe(
          "Keep the recovered browser tab open for a later inspection call for up to two idle minutes; false closes the standalone recovery browser immediately after collection",
        ),
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    if (!args.job_id && !args.conversation_url) {
      throw new Error("Supply job_id or conversation_url to collect response files.");
    }
    let job = null;
    if (args.job_id) {
      job = jobs.get(args.job_id);
      if (["queued", "running"].includes(job.status)) {
        throw new Error(
          `ChatGPT job ${job.id} is still active in phase ${job.phase}. Keep the same job ID and wait for terminal completion before collecting files; do not resubmit it.`,
        );
      }
      if (!args.rescan) {
        const cached = job.result?.responseFiles || job.responseFiles;
        if (cached) {
          return {
            jobId: job.id,
            conversationUrl:
              job.result?.conversationUrl || job.conversationUrl || null,
            cached: true,
            responseFiles: cached,
          };
        }
      }
    }
    const responseFiles = await bridge.collectConversationFiles({
      jobId: args.job_id,
      conversationUrl: args.conversation_url,
      profile: args.profile,
      outputDirectory: args.output_directory,
      expected: args.expected,
      rescan: args.rescan,
      keepOpen: args.keep_open,
    });
    if (args.job_id) jobs.updateResponseFiles(args.job_id, responseFiles);
    return {
      jobId: args.job_id || null,
      conversationUrl:
        bridge.getConversationRecord(args.job_id)?.conversationUrl ||
        args.conversation_url ||
        null,
      cached: false,
      responseFiles,
    };
  },
);

register(
  "inspect_chatgpt_conversation",
  {
    title: "Inspect ChatGPT Conversation",
    description:
      "Detailed browser recovery for the same job/URL: activity, text, file controls and screenshot. Never resubmits. Closes afterward unless keep_open=true. Use only when status or file recovery is insufficient.",
    inputSchema: {
      job_id: z.string().uuid().optional(),
      conversation_url: z
        .string()
        .url()
        .optional()
        .describe("Exact ChatGPT conversation URL when a bridge job ID is unavailable"),
      browser_visibility: z
        .enum(["unchanged", "visible", "background"])
        .default("unchanged")
        .describe(
          "Leave the Chrome window as-is, bring it on-screen, or move it back to the background",
        ),
      capture_screenshot: z.boolean().default(true),
      keep_open: z
        .boolean()
        .default(false)
        .describe(
          "Keep the inspected conversation tab available for follow-up inspection for up to two idle minutes; false closes the worker immediately after the standalone inspection",
        ),
      profile: z.string().min(1).optional().describe("Chrome profile name or directory"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    if (!args.job_id && !args.conversation_url) {
      throw new Error("Supply job_id or conversation_url to inspect a conversation.");
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
  "list_chatgpt_jobs",
  {
    title: "List ChatGPT Jobs",
    description:
      "List compact job states without full answers. details=true adds diagnostics. Queued/running phases are healthy; never resubmit them. Use wait_for_chatgpt_response for a result.",
    inputSchema: {
      status: z
        .enum(["all", "queued", "running", "completed", "failed"])
        .default("all"),
      limit: z.number().int().min(1).max(100).default(50),
      details: detailsSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (args) => ({
    summary: jobs.summary(),
    ...(args.details ? { globalSubmissionPacer: await bridge.submissionPacer.status(bridge.config.submissionIntervalSeconds) } : {}),
    jobs: jobs.list({ status: args.status, limit: args.limit }).map(job => args.details ? job : compactJob(job, { includeResult: false })),
  }),
);

register(
  "wait_for_chatgpt_response",
  {
    title: "Wait for ChatGPT Response",
    description:
      "Wait for an existing job; returns compact progress or the complete result and file links. A wait timeout does not cancel the job: keep the same ID. Pro may take hours. details=true adds diagnostics.",
    inputSchema: {
      job_id: z.string().uuid(),
      details: detailsSchema,
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .default(DEFAULT_STATUS_WAIT_SECONDS)
        .describe(
          "Status wait only; expiry never cancels the job.",
        ),
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
    return args.details ? job : compactJob(job);
  },
);

register(
  "get_chatgpt_bridge_status",
  {
    title: "Get ChatGPT Bridge Status",
    description:
      "Compact configuration, browser state, job counts, update state and errors. details=true adds full diagnostics and recent jobs. Use list_chatgpt_jobs for job IDs.",
    inputSchema: { details: detailsSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const jobSummary = jobs.summary();
    const status = {
      ...(await bridge.status({ details: args.details })),
      updates: await readJson(installationPaths(bridge.paths.stateRoot).state, { managed: false }),
      jobs: jobSummary,
      ...(args.details ? { recentJobs: jobs.list({ limit: 20 }) } : {}),
    };
    return args.details ? status : compactBridgeStatus(status);
  },
);

register(
  "stop_chatgpt_bridge",
  {
    title: "Stop ChatGPT Bridge Browser",
    description:
      "Close this worker's browser and persist its session. Normally closes automatically when idle; other workers are unaffected.",
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

register(
  "check_chatgpt_bridge_updates",
  { title: "Check ChatGPT Bridge Updates", description: "Check the configured GitHub stable release without installing it. Requires a managed install.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } },
  () => updateInstallation({ paths: installationPaths(bridge.paths.stateRoot), checkOnly: true }),
);
register(
  "update_chatgpt_bridge",
  { title: "Update ChatGPT Bridge", description: "Download, verify and install the latest stable GitHub release for new Codex tasks. Existing jobs keep running on their loaded version. Requires a managed install.", inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  async () => {
    const paths = installationPaths(bridge.paths.stateRoot);
    if (!(await readJson(paths.state))?.currentVersion) throw new Error("Run the repository installer first to enable managed updates.");
    return updateInstallation({ paths });
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

// Do not hold up MCP startup or change a process serving active jobs. Codex loads
// the newly installed plugin at the next task boundary.
const checkForUpdates = () => updateInstallation({ paths: installationPaths(bridge.paths.stateRoot), automatic: true }).catch(() => {});
checkForUpdates();
const updateTimer = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
updateTimer.unref();
