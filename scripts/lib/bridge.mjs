import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

import { prepareAttachments } from "./attachments.mjs";
import {
  bridgePaths,
  ChromeProfileStore,
  DEFAULT_CONFIG,
  listChromeProfiles,
  loadConfig,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  normalizeProjectUrl,
  readJson,
  resolveChromeProfile,
  saveConfig,
  writeJsonAtomic,
} from "./config.mjs";
import { launchNativeControlledChrome } from "./native-controller.mjs";
import { launchNativeLogin } from "./native-login.mjs";
import { GlobalSubmissionPacer } from "./submission-pacer.mjs";
import {
  authenticationStatus,
  CHATGPT_URL,
  collectResponseFiles,
  discoverAvailableOptions,
  inspectConversationState,
  isAllowedChatGptUrl,
  selectPreference,
  submitPrompt,
  uiDiagnostics,
  waitForAuthenticationStatus,
  waitForAssistantResponse,
  waitForConversationHydration,
} from "./ui-adapter.mjs";

export class ChatGptChromeBridge {
  constructor({
    paths = bridgePaths(),
    workerId = `${process.pid}-${crypto.randomUUID()}`,
  } = {}) {
    this.paths = paths;
    this.profileStore = new ChromeProfileStore(paths);
    this.workerId = workerId;
    this.submissionPacer = new GlobalSubmissionPacer({ paths, workerId });
    this.workerRuntime = null;
    this.config = null;
    this.browserStartPromise = null;
    this.browserConnection = null;
    this.browserProcess = null;
    this.context = null;
    this.page = null;
    this.profile = null;
    this.runtimeHeadless = null;
    this.browserWindowVisible = false;
    this.workerAuthenticated = false;
    this.cache = {};
    this.liveJobPages = new Map();
    this.inspectionPages = new Map();
    this.conversationRecords = new Map();
  }

  async initialize() {
    this.config = await loadConfig(this.paths);
    this.cache = (await readJson(this.paths.cacheFile, {})) || {};
    return this;
  }

  async listProfiles() {
    const profiles = await listChromeProfiles(this.paths);
    return {
      configuredProfile: this.config?.profile || null,
      profiles,
    };
  }

  async configure({
    profile,
    projectUrl,
    headless,
    defaultModel,
    defaultReasoning,
    timeoutSeconds,
    maxConcurrent,
    submissionIntervalSeconds,
  } = {}) {
    if (!this.config) await this.initialize();
    const next = { ...this.config };
    let resolved = null;
    if (profile !== undefined && profile !== null && String(profile).trim()) {
      resolved = await resolveChromeProfile(profile, this.paths, next.profile);
      next.profile = resolved.directory;
    }
    if (typeof headless === "boolean") next.headless = headless;
    if (projectUrl !== undefined) next.projectUrl = normalizeProjectUrl(projectUrl);
    if (defaultModel !== undefined) next.defaultModel = defaultModel || "auto";
    if (defaultReasoning !== undefined) {
      next.defaultReasoning = defaultReasoning || "auto";
    }
    if (timeoutSeconds !== undefined) next.timeoutSeconds = timeoutSeconds;
    if (maxConcurrent !== undefined) next.maxConcurrent = maxConcurrent;
    if (submissionIntervalSeconds !== undefined) {
      next.submissionIntervalSeconds = submissionIntervalSeconds;
    }
    const requiresRestart =
      this.context &&
      ((resolved && resolved.directory !== this.profile?.directory) ||
        (typeof headless === "boolean" && headless !== this.runtimeHeadless));
    this.config = await saveConfig(next, this.paths);
    if (requiresRestart) await this.closeBrowser();
    return {
      config: this.publicConfig(),
      resolvedProfile: resolved,
      restartedBrowser: Boolean(requiresRestart),
    };
  }

  publicConfig() {
    return {
      profile: this.config?.profile || null,
      projectUrl: this.config?.projectUrl || null,
      headless: this.config?.headless ?? true,
      defaultModel: this.config?.defaultModel || "auto",
      defaultReasoning: this.config?.defaultReasoning || "Extra High",
      timeoutSeconds:
        this.config?.timeoutSeconds || DEFAULT_CONFIG.timeoutSeconds,
      maxConcurrent: this.config?.maxConcurrent || DEFAULT_CONFIG.maxConcurrent,
      submissionIntervalSeconds:
        this.config?.submissionIntervalSeconds ||
        DEFAULT_CONFIG.submissionIntervalSeconds,
    };
  }

  async ensureBrowser({ profile: requestedProfile, visible = false } = {}) {
    if (!this.config) await this.initialize();
    const resolved = await resolveChromeProfile(
      requestedProfile,
      this.paths,
      this.config.profile,
    );
    if (requestedProfile && resolved.directory !== this.config.profile) {
      this.config = await saveConfig(
        { ...this.config, profile: resolved.directory },
        this.paths,
      );
    }
    // ChatGPT's Cloudflare front door challenges true headless Chrome. Keep the
    // configured "headless" setting as the user-facing background preference,
    // but implement it with a real headful window positioned off-screen.
    const headless = visible ? false : Boolean(this.config.headless);
    const reusable =
      this.context &&
      this.profile?.directory === resolved.directory &&
      this.runtimeHeadless === headless;
    if (reusable) {
      if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
      return { context: this.context, page: this.page, profile: resolved };
    }
    if (this.browserStartPromise) {
      await this.browserStartPromise;
      return this.ensureBrowser({ profile: requestedProfile, visible });
    }

    const startup = (async () => {
      await this.closeBrowser();
      try {
        await fs.access(this.paths.chromeExecutable);
      } catch {
        throw new Error(
          `Google Chrome was not found at ${this.paths.chromeExecutable}. ` +
            "Set CHATGPT_CHROME_EXECUTABLE to the Chrome executable path.",
        );
      }
      const runtime = await this.profileStore.prepareWorker(
        resolved,
        this.workerId,
      );
      this.workerRuntime = runtime;
      let launched = null;
      try {
        launched = await launchNativeControlledChrome({
          executable: this.paths.chromeExecutable,
          userDataDir: runtime.userDataDir,
          profileDirectory: resolved.directory,
          background: headless,
          url: CHATGPT_URL,
        });
        this.browserProcess = launched.child;
        await this.profileStore.markWorkerBrowser(runtime, launched.child.pid);
        this.browserConnection = await chromium.connectOverCDP(launched.endpoint, {
          timeout: 15_000,
        });
        this.context = this.browserConnection.contexts()[0];
        if (!this.context) {
          throw new Error("Native Chrome did not expose its persistent browser context.");
        }
      } catch (error) {
        if (launched?.child?.exitCode === null) launched.child.kill("SIGTERM");
        this.browserConnection = null;
        this.browserProcess = null;
        this.context = null;
        await this.profileStore.removeWorker(runtime).catch(() => {});
        this.workerRuntime = null;
        if (
          /singleton|profile.*in use|user data directory.*in use|processsingleton|exited before.*endpoint/i.test(
            error?.message || "",
          )
        ) {
          throw new Error(
            "This bridge worker's private Chrome profile is still open. Close that " +
              "bridge Chrome process and retry the ChatGPT operation.",
          );
        }
        throw error;
      }
      this.profile = resolved;
      this.runtimeHeadless = headless;
      const pages = this.context.pages();
      this.page =
        pages.find((page) => isAllowedChatGptUrl(page.url())) ||
        pages.find((page) => !page.isClosed()) ||
        (await this.context.newPage());
      return runtime;
    })();
    this.browserStartPromise = startup;
    let runtime;
    try {
      runtime = await startup;
    } finally {
      if (this.browserStartPromise === startup) this.browserStartPromise = null;
    }
    return {
      context: this.context,
      page: this.page,
      profile: resolved,
      copiedSession: runtime.copied,
    };
  }

  async openChatGpt({
    profile,
    visible = false,
    forceNavigation = false,
    targetUrl = null,
  } = {}) {
    const browser = await this.ensureBrowser({ profile, visible });
    const destination = normalizeProjectUrl(targetUrl) || CHATGPT_URL;
    const currentAllowed = isAllowedChatGptUrl(browser.page.url());
    const atDestination =
      destination === CHATGPT_URL
        ? currentAllowed
        : browser.page.url().startsWith(destination);
    if (forceNavigation || !atDestination) {
      await browser.page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await browser.page.waitForTimeout(500);
    const authentication = await waitForAuthenticationStatus(browser.page);
    if (authentication.authenticated) this.workerAuthenticated = true;
    if (authentication.reason === "login-control-visible") {
      this.workerAuthenticated = false;
    }
    return {
      profile: browser.profile,
      visible: !this.runtimeHeadless,
      url: browser.page.url(),
      projectUrl: destination === CHATGPT_URL ? null : destination,
      ...authentication,
    };
  }

  async openForLogin({ profile } = {}) {
    if (!this.config) await this.initialize();
    const resolved = await resolveChromeProfile(
      profile,
      this.paths,
      this.config.profile,
    );
    this.config = await saveConfig(
      { ...this.config, profile: resolved.directory },
      this.paths,
    );
    await this.closeBrowser();
    try {
      await fs.access(this.paths.chromeExecutable);
    } catch {
      throw new Error(
        `Google Chrome was not found at ${this.paths.chromeExecutable}. ` +
          "Set CHATGPT_CHROME_EXECUTABLE to the Chrome executable path.",
      );
    }
    const runtime = await this.profileStore.prepare(resolved);
    const launched = await launchNativeLogin({
      executable: this.paths.chromeExecutable,
      userDataDir: runtime.userDataDir,
      profileDirectory: resolved.directory,
      url: CHATGPT_URL,
    });
    return {
      profile: resolved,
      visible: true,
      nativeChrome: true,
      automationControlled: false,
      url: CHATGPT_URL,
      authenticated: null,
      processId: launched.pid,
      instructions:
        "Complete sign-in in this ordinary Chrome window, then quit this dedicated " +
        "bridge Chrome instance completely (Command-Q on macOS) before running " +
        "sync_chatgpt_options. Closing only its tab or window can leave Chrome running. " +
        "The login window has no " +
        "Playwright, automation, or remote-debugging flags, so Google OAuth can treat it as normal Chrome.",
    };
  }

  async refreshLoginFromChrome({ profile } = {}) {
    if (!this.config) await this.initialize();
    const resolved = await resolveChromeProfile(
      profile,
      this.paths,
      this.config.profile,
    );
    await this.closeBrowser();
    const runtime = await this.profileStore.prepare(resolved, { force: true });
    this.config = await saveConfig(
      { ...this.config, profile: resolved.directory },
      this.paths,
    );
    return {
      profile: resolved,
      copiedAt: runtime.marker.copiedAt,
      copiedSessionItems: runtime.marker.copied,
      note:
        "Copied session state only. Saved passwords, history, bookmarks, and tabs were not copied.",
    };
  }

  async requireChatPage({ profile, newChat = false, projectUrl } = {}) {
    const destination =
      projectUrl === undefined
        ? this.config.projectUrl || CHATGPT_URL
        : normalizeProjectUrl(projectUrl) || CHATGPT_URL;
    const opened = await this.openChatGpt({
      profile,
      visible: false,
      forceNavigation: newChat,
      targetUrl: destination,
    });
    if (!isAllowedChatGptUrl(this.page.url())) {
      throw new Error(
        `The browser left an allowed ChatGPT/OpenAI page (${this.page.url()}). ` +
          "Use open_chatgpt_for_login if authentication is required.",
      );
    }
    if (!opened.authenticated) {
      throw new Error(
        "The selected automation profile is not signed in to ChatGPT. " +
          "Run open_chatgpt_for_login, complete sign-in, then sync options.",
      );
    }
    return opened;
  }

  async syncOptions({ profile, projectUrl, forceRescan = false } = {}) {
    const opened = await this.requireChatPage({ profile, projectUrl });
    const cacheForProfile =
      !forceRescan && this.cache.profile === this.profile.directory
        ? this.cache.signatures || {}
        : {};
    const options = await discoverAvailableOptions(this.page, cacheForProfile);
    this.cache = {
      version: 1,
      profile: this.profile.directory,
      syncedAt: new Date().toISOString(),
      signatures: options.signatures,
      modelOptions: options.modelOptions,
      reasoningOptions: options.reasoningOptions,
    };
    await writeJsonAtomic(this.paths.cacheFile, this.cache);
    const result = {
      profile: this.profile,
      projectUrl: opened.projectUrl,
      authenticated: opened.authenticated,
      syncedAt: this.cache.syncedAt,
      modelOptions: options.modelOptions,
      reasoningOptions: options.reasoningOptions,
      forceRescan,
    };
    if (!this.liveJobPages.size && !this.inspectionPages.size) {
      try {
        await this.closeBrowser();
      } catch (error) {
        result.warnings = [
          `ChatGPT options synced, but the refreshed session could not be persisted: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ];
      }
    }
    return result;
  }

  async openTaskPage({ profile, projectUrl, newChat = true } = {}) {
    const browser = await this.ensureBrowser({ profile, visible: false });
    const destination =
      projectUrl === undefined
        ? this.config.projectUrl || CHATGPT_URL
        : normalizeProjectUrl(projectUrl) || CHATGPT_URL;
    const page = newChat ? await browser.context.newPage() : browser.page;
    const ownedPage = page !== browser.page;
    const atDestination =
      destination === CHATGPT_URL
        ? isAllowedChatGptUrl(page.url())
        : page.url().startsWith(destination);
    if (newChat || !atDestination) {
      await page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await page.waitForTimeout(500);
    const authentication = await waitForAuthenticationStatus(page);
    if (!authentication.authenticated) {
      if (ownedPage) await page.close().catch(() => {});
      throw new Error(
        "The selected automation profile is not signed in to ChatGPT. " +
          "Run open_chatgpt_for_login, complete sign-in, then sync options.",
      );
    }
    this.workerAuthenticated = true;
    return {
      page,
      ownedPage,
      profile: browser.profile,
      projectUrl: destination === CHATGPT_URL ? null : destination,
    };
  }

  async selectWithRepair(page, kind, preference, allowFallback) {
    if (!preference || String(preference).toLowerCase() === "auto") {
      return {
        requested: preference || "auto",
        selected: null,
        changed: false,
      };
    }
    const signature = this.cache?.signatures?.[`${kind}Trigger`] || null;
    try {
      return await selectPreference(page, kind, preference, {
        allowFallback,
        cachedSignature: signature,
      });
    } catch (firstError) {
      // A clean semantic retry repairs stale cached selectors. An unavailable
      // option remains an error after the retry and retains the discovered list.
      this.cache.signatures = {
        ...(this.cache.signatures || {}),
        [`${kind}Trigger`]: null,
      };
      try {
        return await selectPreference(page, kind, preference, {
          allowFallback,
          cachedSignature: null,
        });
      } catch (secondError) {
        throw new Error(`${secondError.message} Recovery retry: ${firstError.message}`);
      }
    }
  }

  async ask({
    jobId = null,
    prompt,
    attachments = [],
    profile,
    projectUrl,
    model,
    reasoning,
    newChat = true,
    allowFallback = false,
    timeoutSeconds,
    downloadResponseFiles = true,
    expectResponseFiles = false,
    responseFileOutputDirectory,
    onPhase = null,
  }) {
    if (!prompt || !String(prompt).trim()) throw new Error("A non-empty prompt is required.");
    if (typeof onPhase === "function") {
      onPhase("preparing", {
        attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      });
    }
    const prepared = await prepareAttachments(attachments, {
      stateRoot: this.paths.stateRoot,
      workerId: this.workerId,
    });
    let opened = null;
    let taskPage = null;
    let conversationUrl = null;
    const requestedModel = model || this.config.defaultModel || "auto";
    const requestedReasoning =
      reasoning || this.config.defaultReasoning || "auto";
    try {
      opened = await this.openTaskPage({ profile, newChat, projectUrl });
      taskPage = opened.page;
      conversationUrl = taskPage.url();
      if (jobId) {
        this.liveJobPages.set(jobId, taskPage);
        this.rememberConversation(jobId, {
          jobId,
          conversationUrl,
          profile: opened.profile,
          projectUrl: opened.projectUrl,
          status: "preparing",
        });
      }
      const modelSelection = await this.selectWithRepair(
        taskPage,
        "model",
        requestedModel,
        allowFallback,
      );
      const reasoningSelection = await this.selectWithRepair(
        taskPage,
        "reasoning",
        requestedReasoning,
        allowFallback,
      );
      const longRunning = [
        requestedModel,
        requestedReasoning,
        modelSelection.selected,
        reasoningSelection.selected,
      ].some((value) =>
        /(?:^|\b)(?:pro|deep research|extended research)(?:\b|$)/i.test(
          String(value || ""),
        ),
      );
      const baseline = await submitPrompt(taskPage, String(prompt), {
        attachments: prepared.attachments,
        sendThrough: async (sendAction) => {
          if (typeof onPhase === "function") onPhase("waiting_to_submit");
          return this.submissionPacer.run(sendAction, {
            intervalSeconds:
              this.config.submissionIntervalSeconds ||
              DEFAULT_CONFIG.submissionIntervalSeconds,
            onWaiting: (pacing) => {
              if (typeof onPhase === "function") {
                onPhase("waiting_to_submit", { pacing });
              }
            },
          });
        },
      });
      conversationUrl = taskPage.url();
      if (jobId) {
        this.rememberConversation(jobId, {
          conversationUrl,
          status: "generating",
          model: modelSelection,
          reasoning: reasoningSelection,
          longRunning,
        });
      }
      if (typeof onPhase === "function") {
        onPhase("generating", {
          conversationUrl,
          submission: baseline.submission,
          attachmentUpload: baseline.attachmentUpload,
          longRunning,
        });
      }
      const response = await waitForAssistantResponse(taskPage, baseline, {
        timeoutMs:
          1000 *
          Math.max(
            10,
            Math.min(
              MAX_JOB_TIMEOUT_SECONDS,
              timeoutSeconds ||
                this.config.timeoutSeconds ||
                DEFAULT_CONFIG.timeoutSeconds,
            ),
          ),
        longRunning,
        onProgress: (progress) => {
          conversationUrl = taskPage.url();
          if (jobId) {
            this.rememberConversation(jobId, {
              conversationUrl,
              status: "generating",
              progress,
            });
          }
          if (typeof onPhase === "function") {
            onPhase("generating", { conversationUrl, progress, longRunning });
          }
        },
      });
      const warnings = [];
      if (modelSelection.fallback) {
        warnings.push(
          `Requested model “${requestedModel}” was mapped to “${modelSelection.selected}”.`,
        );
      }
      if (reasoningSelection.fallback) {
        warnings.push(
          `Requested reasoning “${requestedReasoning}” was mapped to “${reasoningSelection.selected}”.`,
        );
      }
      for (const attachment of prepared.publicAttachments) {
        if (attachment.converted) {
          warnings.push(
            `${attachment.originalName} was uploaded as ${attachment.sentName} after temporary local HEIC/HEIF-to-JPEG conversion; the original file was not changed.`,
          );
        }
      }
      conversationUrl = taskPage.url();
      let responseFiles = {
        status: "disabled",
        expected: Boolean(expectResponseFiles),
        detectedCount: response.responseFileCandidateCount || 0,
        outputDirectory: null,
        manifestPath: null,
        totalBytes: 0,
        files: [],
        errors: [],
        candidates: [],
        inspectionRecommended: Boolean(expectResponseFiles),
      };
      if (downloadResponseFiles !== false || expectResponseFiles) {
        if (typeof onPhase === "function") {
          onPhase("collecting_files", {
            conversationUrl,
            progress: {
              assistantMessageCount: response.assistantMessageCount,
              terminalCandidate: true,
              completionSignal: response.completionSignal,
              looksInterim: false,
              responseFileCandidateCount:
                response.responseFileCandidateCount || 0,
              requiredFinalQuietMs: response.finalQuietMs,
              elapsedMs: response.elapsedMs,
            },
          });
        }
        try {
          responseFiles = await collectResponseFiles(taskPage, {
            stateRoot: this.paths.stateRoot,
            collectionId: jobId || crypto.randomUUID(),
            outputDirectory: responseFileOutputDirectory,
            expected: expectResponseFiles,
          });
        } catch (error) {
          responseFiles = {
            status: "failed",
            expected: Boolean(expectResponseFiles),
            detectedCount: response.responseFileCandidateCount || 0,
            outputDirectory: responseFileOutputDirectory || null,
            manifestPath: null,
            totalBytes: 0,
            files: [],
            errors: [
              {
                candidate: null,
                error: error instanceof Error ? error.message : String(error),
              },
            ],
            candidates: [],
            inspectionRecommended: true,
          };
        }
        if (["partial", "failed", "none_found"].includes(responseFiles.status)) {
          try {
            responseFiles.inspection = await inspectConversationState(taskPage);
          } catch (error) {
            responseFiles.inspectionError =
              error instanceof Error ? error.message : String(error);
          }
          const screenshot = await this.captureInspectionScreenshot(
            taskPage,
            jobId || crypto.randomUUID(),
          );
          responseFiles.inspectionScreenshotPath = screenshot.screenshotPath;
          responseFiles.inspectionScreenshotError = screenshot.screenshotError;
          warnings.push(
            responseFiles.status === "none_found"
              ? "ChatGPT was asked to return a file, but no downloadable response file was detected. Re-scan the same conversation or use browser inspection; do not resubmit the prompt."
              : "One or more ChatGPT response files could not be collected automatically. Re-scan the same conversation or use browser inspection; do not resubmit the prompt.",
          );
        }
      }
      if (jobId) {
        this.rememberConversation(jobId, {
          conversationUrl,
          status: "completed",
          responseFiles,
          completionSignal: response.completionSignal,
        });
      }
      return {
        response: response.text,
        profile: opened.profile,
        projectUrl: opened.projectUrl,
        model: modelSelection,
        reasoning: reasoningSelection,
        conversationUrl,
        elapsedMs: response.elapsedMs,
        completionSignal: response.completionSignal,
        responseCompletion: {
          assistantMessageCount: response.assistantMessageCount,
          finalQuietMs: response.finalQuietMs,
          sawGenerating: response.sawGenerating,
          responseFileCandidateCount: response.responseFileCandidateCount,
          longRunning,
        },
        responseFiles,
        submission: baseline.submission,
        attachments: prepared.publicAttachments,
        attachmentUpload: baseline.attachmentUpload,
        warnings,
      };
    } finally {
      if (taskPage && !taskPage.isClosed()) conversationUrl = taskPage.url();
      if (jobId) {
        this.liveJobPages.delete(jobId);
        this.rememberConversation(jobId, { conversationUrl });
      }
      if (opened?.ownedPage && taskPage) await taskPage.close().catch(() => {});
      await prepared.cleanup().catch(() => {});
    }
  }

  rememberConversation(jobId, patch = {}) {
    if (!jobId) return null;
    const existing = this.conversationRecords.get(jobId) || {
      jobId,
      createdAt: new Date().toISOString(),
    };
    const record = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.conversationRecords.set(jobId, record);
    if (this.conversationRecords.size > 200) {
      const oldest = Array.from(this.conversationRecords.entries())
        .sort(
          (left, right) =>
            Date.parse(left[1].updatedAt || left[1].createdAt || 0) -
            Date.parse(right[1].updatedAt || right[1].createdAt || 0),
        )
        .slice(0, this.conversationRecords.size - 200);
      for (const [oldJobId] of oldest) this.conversationRecords.delete(oldJobId);
    }
    return record;
  }

  getConversationRecord(jobId) {
    return jobId ? this.conversationRecords.get(jobId) || null : null;
  }

  async captureInspectionScreenshot(page, tokenValue) {
    const inspectionDirectory = path.join(this.paths.stateRoot, "inspections");
    await fs.mkdir(inspectionDirectory, { recursive: true, mode: 0o700 });
    const token = String(tokenValue || crypto.randomUUID())
      .replace(/[^a-z0-9_.-]+/gi, "-")
      .slice(0, 120);
    const target = path.join(inspectionDirectory, `${token}-${Date.now()}.png`);
    try {
      await page.screenshot({ path: target, fullPage: false });
      await fs.chmod(target, 0o600);
      return { screenshotPath: target, screenshotError: null };
    } catch (error) {
      return {
        screenshotPath: null,
        screenshotError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resolveConversationUrl({ jobId, conversationUrl } = {}) {
    const record = this.getConversationRecord(jobId);
    const resolved = String(conversationUrl || record?.conversationUrl || "").trim();
    if (!resolved) {
      throw new Error(
        "No ChatGPT conversation URL is available. Supply conversation_url or a job_id whose submission reached ChatGPT.",
      );
    }
    if (!isAllowedChatGptUrl(resolved)) {
      throw new Error(`Conversation inspection is limited to ChatGPT/OpenAI URLs: ${resolved}`);
    }
    return { conversationUrl: resolved, record };
  }

  async resolveConversationPage({
    jobId,
    conversationUrl,
    profile,
    keepOpen = false,
  } = {}) {
    const livePage = jobId ? this.liveJobPages.get(jobId) : null;
    if (livePage && !livePage.isClosed()) {
      return {
        page: livePage,
        ownedPage: false,
        live: true,
        conversationUrl: livePage.url(),
      };
    }
    const resolved = this.resolveConversationUrl({ jobId, conversationUrl });
    const cached = this.inspectionPages.get(resolved.conversationUrl);
    if (cached && !cached.isClosed()) {
      return {
        page: cached,
        ownedPage: false,
        live: false,
        conversationUrl: cached.url(),
      };
    }
    if (cached?.isClosed()) this.inspectionPages.delete(resolved.conversationUrl);
    const browser = await this.ensureBrowser({
      profile: profile || resolved.record?.profile?.directory,
      visible: false,
    });
    const page = await browser.context.newPage();
    try {
      await page.goto(resolved.conversationUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(750);
      const authentication = await waitForAuthenticationStatus(page);
      if (!authentication.authenticated) {
        throw new Error(
          "The selected automation profile is not signed in to ChatGPT. Refresh or complete login before inspecting this conversation.",
        );
      }
      const hydration = await waitForConversationHydration(page);
      if (keepOpen) {
        this.inspectionPages.set(resolved.conversationUrl, page);
        if (page.url() !== resolved.conversationUrl) {
          this.inspectionPages.set(page.url(), page);
        }
      }
      return {
        page,
        ownedPage: !keepOpen,
        live: false,
        conversationUrl: page.url(),
        hydration,
      };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async setBrowserWindowVisibility(page, visibility = "unchanged") {
    if (visibility === "unchanged") {
      return { visibility, changed: false, visible: this.browserWindowVisible };
    }
    if (!["visible", "background"].includes(visibility)) {
      throw new Error(`Unknown browser visibility mode: ${visibility}`);
    }
    const session = await page.context().newCDPSession(page);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      const bounds =
        visibility === "visible"
          ? { left: 80, top: 80, width: 1440, height: 1000, windowState: "normal" }
          : {
              left: -32_000,
              top: -32_000,
              width: 1440,
              height: 1000,
              windowState: "normal",
            };
      await session.send("Browser.setWindowBounds", { windowId, bounds });
      if (visibility === "visible") await page.bringToFront();
      this.browserWindowVisible = visibility === "visible";
      return {
        visibility,
        changed: true,
        visible: this.browserWindowVisible,
        windowId,
      };
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async inspectConversation({
    jobId,
    conversationUrl,
    profile,
    browserVisibility = "unchanged",
    captureScreenshot = true,
    keepOpen = true,
  } = {}) {
    const resolved = await this.resolveConversationPage({
      jobId,
      conversationUrl,
      profile,
      keepOpen,
    });
    try {
      const window = await this.setBrowserWindowVisibility(
        resolved.page,
        browserVisibility,
      );
      const snapshot = await inspectConversationState(resolved.page);
      const screenshot = captureScreenshot
        ? await this.captureInspectionScreenshot(
            resolved.page,
            jobId || crypto.randomUUID(),
          )
        : { screenshotPath: null, screenshotError: null };
      if (jobId) {
        this.rememberConversation(jobId, {
          conversationUrl: snapshot.url,
          lastInspectionAt: new Date().toISOString(),
        });
      }
      return {
        jobId: jobId || null,
        conversationUrl: snapshot.url,
        liveJobPage: resolved.live,
        hydration: resolved.hydration || null,
        keptOpen: Boolean(keepOpen && !resolved.ownedPage),
        browserWindow: window,
        screenshotPath: screenshot.screenshotPath,
        screenshotError: screenshot.screenshotError,
        snapshot,
      };
    } finally {
      if (resolved.ownedPage) await resolved.page.close().catch(() => {});
    }
  }

  async collectConversationFiles({
    jobId,
    conversationUrl,
    profile,
    outputDirectory,
    expected = true,
    rescan = true,
    keepOpen = false,
  } = {}) {
    const record = this.getConversationRecord(jobId);
    if (!rescan && record?.responseFiles) return record.responseFiles;
    const resolved = await this.resolveConversationPage({
      jobId,
      conversationUrl,
      profile,
      keepOpen,
    });
    try {
      const responseFiles = await collectResponseFiles(resolved.page, {
        stateRoot: this.paths.stateRoot,
        collectionId: jobId || crypto.randomUUID(),
        outputDirectory,
        expected,
      });
      if (jobId) {
        this.rememberConversation(jobId, {
          conversationUrl: resolved.page.url(),
          responseFiles,
          lastFileCollectionAt: new Date().toISOString(),
        });
      }
      return responseFiles;
    } finally {
      if (resolved.ownedPage) await resolved.page.close().catch(() => {});
    }
  }

  async status() {
    if (!this.config) await this.initialize();
    const result = {
      config: this.publicConfig(),
      workerId: this.workerId,
      browserRunning: Boolean(this.context),
      openPages: this.context
        ? this.context.pages().filter((page) => !page.isClosed()).length
        : 0,
      activeProfile: this.profile,
      background: this.context ? this.runtimeHeadless : null,
      browserWindowVisible: this.context ? this.browserWindowVisible : null,
      liveJobPages: Array.from(this.liveJobPages.values()).filter(
        (page) => !page.isClosed(),
      ).length,
      inspectionPages: new Set(
        Array.from(this.inspectionPages.values()).filter((page) => !page.isClosed()),
      ).size,
      responseFileRoot: path.join(this.paths.stateRoot, "response-files"),
      inspectionRoot: path.join(this.paths.stateRoot, "inspections"),
      lastOptionSync: this.cache?.syncedAt || null,
      cachedModelOptions: this.cache?.modelOptions || [],
      cachedReasoningOptions: this.cache?.reasoningOptions || [],
      globalSubmissionPacer: await this.submissionPacer.status(
        this.config.submissionIntervalSeconds,
      ),
    };
    if (this.page && !this.page.isClosed()) {
      result.authentication = await authenticationStatus(this.page);
      result.ui = await uiDiagnostics(this.page);
    }
    return result;
  }

  async closeBrowser() {
    const browser = this.browserConnection;
    const browserProcess = this.browserProcess;
    const context = this.context;
    const workerRuntime = this.workerRuntime;
    const workerProfile = this.profile;
    const page = this.page;
    let persistSession = Boolean(
      workerRuntime && workerProfile && this.workerAuthenticated,
    );
    if (persistSession && page && !page.isClosed()) {
      const currentAuthentication = await authenticationStatus(page).catch(
        () => null,
      );
      if (currentAuthentication?.authenticated) persistSession = true;
      if (currentAuthentication?.reason === "login-control-visible") {
        persistSession = false;
      }
    }
    this.browserConnection = null;
    this.browserProcess = null;
    this.context = null;
    this.workerRuntime = null;
    this.page = null;
    this.profile = null;
    this.runtimeHeadless = null;
    this.browserWindowVisible = false;
    this.workerAuthenticated = false;
    this.liveJobPages.clear();
    this.inspectionPages.clear();
    if (browser) await browser.close().catch(() => {});
    else if (context) await context.close().catch(() => {});
    if (browserProcess?.exitCode === null) {
      browserProcess.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        browserProcess.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (browserProcess.exitCode === null) {
        browserProcess.kill("SIGKILL");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          browserProcess.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    let persistenceError = null;
    if (persistSession) {
      try {
        await this.profileStore.persistWorker(workerProfile, workerRuntime);
      } catch (error) {
        persistenceError = error;
      }
    }
    if (!persistenceError) {
      await this.profileStore.removeWorker(workerRuntime).catch(() => {});
    }
    if (persistenceError) {
      throw new Error(
        `The refreshed ChatGPT session could not be persisted; the recoverable worker copy was retained. ${
          persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError)
        }`,
        { cause: persistenceError },
      );
    }
  }
}

export class AskJobQueue {
  constructor(bridge) {
    this.bridge = bridge;
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.closing = false;
  }

  create(params) {
    this.prune();
    const id = crypto.randomUUID();
    const { jobLabel, ...askParams } = params;
    const label = String(jobLabel || askParams.prompt || "ChatGPT job")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const createdAt = new Date().toISOString();
    const job = {
      id,
      label,
      status: "queued",
      phase: "queued",
      phaseChangedAt: createdAt,
      createdAt,
      startedAt: null,
      completedAt: null,
      pacing: null,
      submission: null,
      attachmentCount: Array.isArray(askParams.attachments)
        ? askParams.attachments.length
        : 0,
      attachmentUpload: null,
      conversationUrl: null,
      progress: null,
      responseFiles: null,
      expectResponseFiles: Boolean(askParams.expectResponseFiles),
      result: null,
      error: null,
      promise: null,
      resolve: null,
    };
    job.promise = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.jobs.set(id, job);
    this.pending.push({ job, params: askParams });
    queueMicrotask(() => this.pump());
    return this.publicJob(job);
  }

  concurrencyLimit() {
    return Math.max(
      1,
      Math.min(
        MAX_CONCURRENT_JOBS,
        Number(
          this.bridge.config?.maxConcurrent || DEFAULT_CONFIG.maxConcurrent,
        ),
      ),
    );
  }

  pump() {
    if (this.closing) return;
    const limit = this.concurrencyLimit();
    while (this.running < limit && this.pending.length) {
      const { job, params } = this.pending.shift();
      this.running += 1;
      this.run(job, params).finally(() => this.finish(job));
    }
  }

  async finish(job) {
    this.running -= 1;
    if (this.running === 0 && this.pending.length === 0) {
      this.closing = true;
      try {
        await this.bridge.closeBrowser?.();
      } catch (error) {
        if (job.result) {
          job.result.warnings = [
            ...(job.result.warnings || []),
            `The ChatGPT response completed, but its refreshed login session could not be persisted: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ];
        }
      } finally {
        this.closing = false;
      }
    }
    job.resolve();
    this.pump();
  }

  async run(job, params) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.setPhase(job, "preparing");
    try {
      job.result = await this.bridge.ask({
        ...params,
        jobId: job.id,
        onPhase: (phase, details = {}) => {
          this.setPhase(job, phase, details);
        },
      });
      job.status = "completed";
      this.setPhase(job, "completed", {
        submission: job.result?.submission || job.submission,
        conversationUrl: job.result?.conversationUrl || job.conversationUrl,
        responseFiles: job.result?.responseFiles || job.responseFiles,
      });
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      const record = this.bridge.getConversationRecord(job.id);
      if (record?.conversationUrl) job.conversationUrl = record.conversationUrl;
      if (record?.progress) job.progress = record.progress;
      if (record?.responseFiles) job.responseFiles = record.responseFiles;
      job.status = "failed";
      this.setPhase(job, "failed");
    } finally {
      job.completedAt = new Date().toISOString();
    }
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown ChatGPT job ID: ${id}`);
    return job;
  }

  updateResponseFiles(id, responseFiles) {
    const job = this.get(id);
    job.responseFiles = responseFiles;
    if (job.result) job.result.responseFiles = responseFiles;
    return this.publicJob(job);
  }

  setPhase(job, phase, details = {}) {
    job.phase = phase;
    job.phaseChangedAt = new Date().toISOString();
    if (details.pacing) job.pacing = details.pacing;
    if (details.submission) job.submission = details.submission;
    if (details.attachmentUpload) job.attachmentUpload = details.attachmentUpload;
    if (details.conversationUrl) job.conversationUrl = details.conversationUrl;
    if (details.progress) job.progress = details.progress;
    if (details.responseFiles) job.responseFiles = details.responseFiles;
  }

  async wait(id, timeoutSeconds = 300) {
    const job = this.get(id);
    if (job.status === "queued" || job.status === "running") {
      // The grace period lets a wait:true call observe and return a job that
      // reaches its configured response deadline without making status-only
      // waits responsible for the lifetime of the underlying ChatGPT job.
      const waitMs =
        Math.max(
          1,
          Math.min(MAX_JOB_TIMEOUT_SECONDS + 60, timeoutSeconds),
        ) * 1000;
      await Promise.race([
        job.promise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }
    return this.publicJob(job);
  }

  publicJob(job, { includeResult = true } = {}) {
    const queueIndex = this.pending.findIndex((entry) => entry.job.id === job.id);
    return {
      id: job.id,
      label: job.label,
      status: job.status,
      phase: job.phase,
      phaseChangedAt: job.phaseChangedAt,
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      pacing: job.pacing,
      submission: job.submission,
      attachmentCount: job.attachmentCount,
      attachmentUpload: job.attachmentUpload,
      conversationUrl: job.conversationUrl,
      progress: job.progress,
      expectResponseFiles: job.expectResponseFiles,
      responseFiles: job.responseFiles,
      result: includeResult ? job.result : this.resultSummary(job.result),
      error: job.error,
    };
  }

  resultSummary(result) {
    if (!result) return null;
    return {
      conversationUrl: result.conversationUrl || null,
      elapsedMs: result.elapsedMs ?? null,
      model: result.model || null,
      reasoning: result.reasoning || null,
      completionSignal: result.completionSignal || null,
      responseCompletion: result.responseCompletion || null,
      submission: result.submission || null,
      attachments: Array.isArray(result.attachments)
        ? result.attachments.map((attachment) => ({
            originalName: attachment.originalName,
            sentName: attachment.sentName,
            sentFormat: attachment.sentFormat,
            sentSizeBytes: attachment.sentSizeBytes,
            converted: attachment.converted,
          }))
        : [],
      attachmentUpload: result.attachmentUpload || null,
      responseFiles: result.responseFiles
        ? {
            status: result.responseFiles.status,
            expected: result.responseFiles.expected,
            detectedCount: result.responseFiles.detectedCount,
            outputDirectory: result.responseFiles.outputDirectory,
            manifestPath: result.responseFiles.manifestPath,
            inspectionScreenshotPath:
              result.responseFiles.inspectionScreenshotPath || null,
            totalBytes: result.responseFiles.totalBytes,
            files: Array.isArray(result.responseFiles.files)
              ? result.responseFiles.files.map((file) => ({
                  name: file.name,
                  path: file.path,
                  sizeBytes: file.sizeBytes,
                  sha256: file.sha256,
                  mimeType: file.mimeType,
                  discoveryMethod: file.discoveryMethod,
                }))
              : [],
            errorCount: Array.isArray(result.responseFiles.errors)
              ? result.responseFiles.errors.length
              : 0,
            inspectionRecommended:
              result.responseFiles.inspectionRecommended || false,
          }
        : null,
    };
  }

  list({ status = "all", limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return Array.from(this.jobs.values())
      .filter((job) => status === "all" || job.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, boundedLimit)
      .map((job) => this.publicJob(job, { includeResult: false }));
  }

  summary() {
    const jobs = Array.from(this.jobs.values());
    const phases = {};
    for (const job of jobs) phases[job.phase] = (phases[job.phase] || 0) + 1;
    return {
      maxConcurrent: this.concurrencyLimit(),
      running: jobs.filter((job) => job.status === "running").length,
      queued: jobs.filter((job) => job.status === "queued").length,
      completed: jobs.filter((job) => job.status === "completed").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      phases,
    };
  }

  prune() {
    const oldest = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (
        job.completedAt &&
        Date.parse(job.completedAt) < oldest &&
        ["completed", "failed"].includes(job.status)
      ) {
        this.jobs.delete(id);
      }
    }
  }
}
