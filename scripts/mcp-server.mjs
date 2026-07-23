#!/usr/bin/env node

import path from "node:path";

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
  version: "0.1.0",
});

const attachmentPathsSchema = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe(
    `Up to ${MAX_ATTACHMENTS} exact absolute paths to individual files the user has authorized Codex to transmit to the signed-in ChatGPT account. No directories, globs, recursive workspace collection, symlinks, secrets, credentials, or browser-session data. HEIC/HEIF photos are sent as temporary JPEG copies while originals remain unchanged. Omit this field unless these exact files are intentionally being shared; ChatGPT receives no other local files.`,
  );

const responseFileOutputDirectorySchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "response_file_output_directory must be an absolute path",
  })
  .optional()
  .describe(
    "Exact absolute local directory where ChatGPT-generated response files should be saved. The directory is created if needed; existing files are never overwritten. Omit to use the bridge's private response-files directory.",
  );

const downloadResponseFilesSchema = z
  .boolean()
  .default(true)
  .describe(
    "Automatically discover and download files generated in the final ChatGPT response through the authenticated browser session.",
  );

const expectResponseFilesSchema = z
  .boolean()
  .default(false)
  .describe(
    "Set true when the prompt asks ChatGPT to generate a downloadable file. The bridge waits longer for file controls and reports none_found plus a browser-inspection recommendation instead of silently assuming no file was intended.",
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
      "List local Chrome profile directories and friendly names so the user can choose which signed-in account the ChatGPT bridge should use. Does not open Chrome or read browsing content.",
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
      "Remember a Chrome profile, ChatGPT project, default model/reasoning preferences, response deadline, per-worker concurrency, and the global delay between actual ChatGPT submissions. A profile may be its friendly name or directory (for example, Default or Profile 2). The response deadline defaults to two hours and may be configured up to four hours for long Pro runs.",
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
      default_model: z
        .string()
        .optional()
        .describe("Visible ChatGPT model label or auto"),
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
          "ChatGPT response deadline for each job, in seconds (default 7200; maximum 14400). This is not a status-poll interval or a signal to submit duplicates.",
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
      defaultModel: args.default_model,
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
      "Open the bridge's private profile in ordinary native Chrome with no automation or remote-debugging flags. Use for one-time sign-in, including Google OAuth. After signing in, the user must quit that dedicated Chrome instance completely (Command-Q on macOS); closing only its tab or window can leave the profile locked. The tool reports an error if Chrome exits before a usable login window is ready.",
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
      "Stop the private automation browser and refresh its cookies and ChatGPT site storage from the selected regular Chrome profile. Does not copy passwords, history, bookmarks, or tabs.",
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
      "Open ChatGPT in the bridge, verify the session, and dynamically discover model and reasoning choices visible to that account. Force rescanning to repair stale cached control signatures after a UI update.",
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
      "Create a private local ZIP from an exact user-authorized repository root or selected relative paths before a possible ChatGPT attachment. The default git-worktree selection includes tracked files plus non-ignored untracked files. The action never follows symlinks; excludes Git metadata, dependency/build/cache/runtime trees, credentials and browser/Codex state paths; scans every candidate file for common secret patterns; and omits an entire flagged file rather than copying or partially redacting it. It returns the ZIP and a companion JSON manifest as MCP resources with included-file hashes, exclusion reasons, limits, and archive SHA-256 metadata, but never detected secret values. This action performs no upload, Git commit, push, or network transmission. Pattern-based detection cannot prove that every possible secret was found, so review the manifest and archive before separately attaching or sharing it.",
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
      "Use ChatGPT as a context-isolated worker for deep general research, exploration, brainstorming, comparison, critique, synthesis, planning, generic design, drafting, or a second opinion. ChatGPT receives only the fields in this tool call plus the contents of exact explicitly listed attachments. It cannot see the Codex conversation, active project/repository, unlisted files, code, terminal output, local UI, private workspace state, or other agents' work. The configured ChatGPT project only organizes chats; it does not supply Codex task context. Use this when the assignment is fully self-contained in text or in text plus a small user-authorized attachment set. Each attachment is transmitted to the signed-in ChatGPT account and may be retained under that account/project's data settings; never attach unrelated or secret files. Keep project-aware inspection, implementation, edits, and verification with Codex or a repository-aware subagent. For a requested generated document or other artifact, state its exact format/checks and set expect_response_files=true; the bridge downloads it as a local MCP resource. New-chat jobs run concurrently, but Send actions are globally paced five seconds apart by default. Pro jobs can normally take an hour or longer and may emit small interim cards before the large final answer. Use wait=false for multiple or long jobs, retain every job ID, and collect that same job later. queued, preparing, waiting_to_submit, generating, and collecting_files are healthy nonterminal phases: never submit a duplicate just because a job remains in one. Upload failures are terminal and are not retried automatically. Only consider retrying after the original job reports failed, and inspect its error first.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "Complete standalone assignment containing every fact needed; never rely on 'this project', prior Codex messages, unlisted local files, or unstated context",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Optional small non-secret facts intentionally transmitted in this call; omitted means ChatGPT has no local context beyond any exact explicit attachments, and broad workspace data should not be exported",
        ),
      deliverable: z
        .string()
        .optional()
        .describe(
          "Standalone output shape, depth, audience, or decision criteria that do not depend on the Codex project",
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
      model: z.string().optional().describe("Visible model label or auto"),
      reasoning: z
        .string()
        .optional()
        .describe("Visible label or alias: fast, low, medium, high, xhigh, max, pro, or auto"),
      allow_fallback: z.boolean().default(false),
      wait: z.boolean().default(true),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Response deadline for this ChatGPT job, in seconds (default 7200; maximum 14400). Hour-plus Pro processing is normal; this deadline is not when Codex should retry.",
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
      model: args.model,
      reasoning: args.reasoning,
      newChat: true,
      allowFallback: args.allow_fallback,
      timeoutSeconds: args.timeout_seconds,
      downloadResponseFiles: args.download_response_files,
      expectResponseFiles: args.expect_response_files,
      responseFileOutputDirectory: args.response_file_output_directory,
    });
    if (!args.wait) return job;
    const waited = await jobs.wait(
      job.id,
      (args.timeout_seconds ||
        bridge.config.timeoutSeconds ||
        DEFAULT_CONFIG.timeoutSeconds) + 5,
    );
    if (waited.status === "failed") throw new Error(waited.error);
    return waited;
  },
);

register(
  "ask_chatgpt",
  {
    title: "Ask ChatGPT",
    description:
      "Pass a complete standalone user-authored prompt through the selected signed-in ChatGPT website account with minimal framing. ChatGPT receives this prompt plus the contents of exact explicitly listed attachments; it cannot see the Codex conversation, active project/repository, unlisted files, code, terminal, local UI, private state, or other agents. Each attachment is transmitted to the signed-in ChatGPT account and may be retained under that account/project's data settings, so include files only with the user's authorization and never include secrets. For a Codex-created general research or drafting workstream, prefer delegate_research_to_chatgpt. Never use this for a request that depends on unstated local context. If the prompt asks for a generated file, set expect_response_files=true so the authenticated browser downloads it and returns a local MCP resource. New-chat requests run concurrently in separate tabs, while Send actions are globally paced five seconds apart by default. Pro jobs can normally take an hour or longer and may show small interim cards before their large final response. Use list_chatgpt_jobs and wait_for_chatgpt_response with the original job ID. queued, preparing, waiting_to_submit, generating, and collecting_files mean the job is active; do not create a duplicate or treat a bounded status wait as a failure. Upload failures are not retried automatically.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "Complete self-contained prompt; ChatGPT knows nothing about the Codex task or local project beyond this exact text and any exact explicit attachments",
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
      model: z.string().optional().describe("Visible model label or auto"),
      reasoning: z
        .string()
        .optional()
        .describe("Visible label or alias: fast, low, medium, high, xhigh, max, pro, or auto"),
      new_chat: z.boolean().default(true),
      allow_fallback: z
        .boolean()
        .default(false)
        .describe("Allow a requested unavailable option to fall back to a discovered option"),
      wait: z.boolean().default(true),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional()
        .describe(
          "Response deadline for this ChatGPT job, in seconds (default 7200; maximum 14400). Hour-plus Pro processing is normal; this deadline is not when Codex should retry.",
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
      model: args.model,
      reasoning: args.reasoning,
      newChat: args.new_chat,
      allowFallback: args.allow_fallback,
      timeoutSeconds: args.timeout_seconds,
      downloadResponseFiles: args.download_response_files,
      expectResponseFiles: args.expect_response_files,
      responseFileOutputDirectory: args.response_file_output_directory,
    });
    if (!args.wait) return job;
    const waited = await jobs.wait(
      job.id,
      (args.timeout_seconds ||
        bridge.config.timeoutSeconds ||
        DEFAULT_CONFIG.timeoutSeconds) + 5,
    );
    if (waited.status === "failed") throw new Error(waited.error);
    return waited;
  },
);

register(
  "collect_chatgpt_response_files",
  {
    title: "Collect ChatGPT Response Files",
    description:
      "Reopen or re-scan one existing ChatGPT conversation and download files generated in its final response through the same authenticated browser session. Use the original job_id whenever possible; conversation_url is the recovery path when only the URL is known. This never resubmits the prompt. Do not collect from queued, preparing, waiting_to_submit, generating, or collecting_files jobs because Pro may still be emitting interim progress. Downloaded files are collision-safe local files with size, MIME, SHA-256, manifest, and MCP resource links for direct Codex access. If collection remains partial, failed, or none_found, use inspect_chatgpt_conversation on the same job or URL.",
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
      "Browser fail-safe for an existing or live ChatGPT job. Reconnect to the exact conversation using the signed-in bridge profile and return current Pro activity signals, interim/final evidence, latest assistant text, detected response-file controls, visible page text, UI diagnostics, and an optional screenshot. Use this when completion or file extraction looks uncertain; it never resubmits the prompt. browser_visibility can bring native Chrome on-screen for direct Codex/browser control or return it to the background afterward. The recovered browser closes when the operation becomes idle unless keep_open is explicitly requested.",
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
      "Quickly inspect this Codex worker's ChatGPT jobs without blocking. Returns job IDs, short labels, queue positions, phases (queued, preparing, waiting_to_submit, generating, collecting_files, completed, or failed), conversation URLs, live progress snapshots, response-file metadata, timestamps, errors, result metadata without full response text, and the shared global submission pacer. Pro processing can normally take an hour or longer. queued, preparing, waiting_to_submit, generating, and collecting_files are healthy nonterminal phases, so keep the original job ID and do not resubmit. A progress preview is interim status, not the result. completed requires active signals to disappear, an explicit final-turn action, and a 15-second quiet window for Pro; stable partial text or a small interim card is never enough. Terminal job records remain available for 24 hours.",
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
  "wait_for_chatgpt_response",
  {
    title: "Wait for ChatGPT Response",
    description:
      "Wait for one previously queued ask_chatgpt or delegate_research_to_chatgpt job by ID. The default five-minute wait window is only a bounded status wait: it does not cancel or shorten the underlying job's two-hour default response deadline. If this returns queued, preparing, waiting_to_submit, generating, or collecting_files, the job is healthy and active; keep this same job ID and wait again instead of submitting a duplicate. Pro processing can normally take an hour or longer and may emit small interim cards. The bridge requires active progress to end, an explicit final-turn action, and a 15-second Pro quiet window before completion. Completed generated files include local MCP resource links. Use list_chatgpt_jobs for an immediate overview of many jobs.",
    inputSchema: {
      job_id: z.string().uuid(),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .default(DEFAULT_STATUS_WAIT_SECONDS)
        .describe(
          "How long this status call may wait; reaching it never cancels the ChatGPT job and is not a reason to retry the prompt.",
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
    return job;
  },
);

register(
  "get_chatgpt_bridge_status",
  {
    title: "Get ChatGPT Bridge Status",
    description:
      "Report bridge health, configuration, browser visibility/inspection state, idle-close lifecycle state, response-file roots, global submission-pacer timing, cached ChatGPT options, and an aggregate job/phase summary. Use list_chatgpt_jobs for individual job IDs, progress, files, and phases. Nonterminal jobs remain active even when Pro takes an hour or longer; do not submit duplicates.",
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
  "stop_chatgpt_bridge",
  {
    title: "Stop ChatGPT Bridge Browser",
    description:
      "Explicitly close this Codex worker's background/visible Chrome process. Normal job queues already close automatically when idle. Other Codex workers remain independent, and verified refreshed session state is persisted for the next start.",
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
