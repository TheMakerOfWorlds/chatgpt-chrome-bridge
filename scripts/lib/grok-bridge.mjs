import crypto from "node:crypto";
import fs from "node:fs/promises";

import { prepareAttachments } from "./attachments.mjs";
import { ChatGptChromeBridge, INSPECTION_KEEP_OPEN_MS } from "./bridge.mjs";
import {
  DEFAULT_JOB_TIMEOUT_SECONDS,
  DEFAULT_SUBMISSION_INTERVAL_SECONDS,
  MAX_JOB_TIMEOUT_SECONDS,
  listChromeProfiles,
  readJson,
  resolveChromeProfile,
  writeJsonAtomic,
} from "./config.mjs";
import {
  DEFAULT_GROK_CONFIG,
  grokBridgePaths,
  loadGrokConfig,
  normalizeGrokProjectUrl,
  saveGrokConfig,
} from "./grok-config.mjs";
import {
  discoverGrokOptions,
  grokAuthenticationStatus,
  GROK_URL,
  grokUiDiagnostics,
  inspectGrokConversationState,
  isAllowedGrokUrl,
  selectGrokModel,
  submitGrokPrompt,
  waitForGrokAuthenticationStatus,
  waitForGrokConversationHydration,
  waitForGrokResponse,
} from "./grok-ui-adapter.mjs";
import { launchNativeLogin } from "./native-login.mjs";

export class GrokChromeBridge extends ChatGptChromeBridge {
  constructor({
    paths = grokBridgePaths(),
    workerId = `${process.pid}-${crypto.randomUUID()}`,
    browserIdleCloseMs,
  } = {}) {
    super({ paths, workerId, browserIdleCloseMs });
    this.serviceName = "Grok";
    this.serviceHomeUrl = GROK_URL;
    this.isAllowedServiceUrl = isAllowedGrokUrl;
    this.authenticationChecker = grokAuthenticationStatus;
    this.waitAuthenticationChecker = waitForGrokAuthenticationStatus;
    this.uiDiagnosticsProvider = grokUiDiagnostics;
    this.chromeExecutableEnv = "GROK_CHROME_EXECUTABLE";
    this.saveConfigProvider = saveGrokConfig;
  }

  async initialize() {
    this.config = await loadGrokConfig(this.paths);
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
    if (projectUrl !== undefined) {
      next.projectUrl = normalizeGrokProjectUrl(projectUrl);
    }
    if (defaultModel !== undefined) next.defaultModel = defaultModel || "Fast";
    if (timeoutSeconds !== undefined) next.timeoutSeconds = timeoutSeconds;
    if (maxConcurrent !== undefined) next.maxConcurrent = maxConcurrent;
    if (submissionIntervalSeconds !== undefined) {
      next.submissionIntervalSeconds = submissionIntervalSeconds;
    }
    const requiresRestart =
      this.context &&
      ((resolved && resolved.directory !== this.profile?.directory) ||
        (typeof headless === "boolean" && headless !== this.runtimeHeadless));
    this.config = await saveGrokConfig(next, this.paths);
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
      defaultModel: this.config?.defaultModel || "Fast",
      timeoutSeconds:
        this.config?.timeoutSeconds || DEFAULT_GROK_CONFIG.timeoutSeconds,
      maxConcurrent:
        this.config?.maxConcurrent || DEFAULT_GROK_CONFIG.maxConcurrent,
      submissionIntervalSeconds:
        this.config?.submissionIntervalSeconds ||
        DEFAULT_GROK_CONFIG.submissionIntervalSeconds,
    };
  }

  destination(projectUrl) {
    return projectUrl === undefined
      ? this.config.projectUrl || GROK_URL
      : normalizeGrokProjectUrl(projectUrl) || GROK_URL;
  }

  async openGrok({
    profile,
    visible = false,
    forceNavigation = false,
    targetUrl = undefined,
  } = {}) {
    const browser = await this.ensureBrowser({ profile, visible });
    const destination =
      targetUrl === undefined
        ? this.destination(undefined)
        : normalizeGrokProjectUrl(targetUrl) || GROK_URL;
    const atDestination =
      destination === GROK_URL
        ? isAllowedGrokUrl(browser.page.url())
        : browser.page.url().startsWith(destination);
    if (forceNavigation || !atDestination) {
      await browser.page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await browser.page.waitForTimeout(500);
    const authentication = await waitForGrokAuthenticationStatus(browser.page);
    if (authentication.authenticated) this.workerAuthenticated = true;
    if (authentication.reason === "login-control-visible") {
      this.workerAuthenticated = false;
    }
    return {
      profile: browser.profile,
      visible: !this.runtimeHeadless,
      url: browser.page.url(),
      projectUrl: destination === GROK_URL ? null : destination,
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
    this.config = await saveGrokConfig(
      { ...this.config, profile: resolved.directory },
      this.paths,
    );
    await this.closeBrowser();
    try {
      await fs.access(this.paths.chromeExecutable);
    } catch {
      throw new Error(
        `Google Chrome was not found at ${this.paths.chromeExecutable}. ` +
          "Set GROK_CHROME_EXECUTABLE to the Chrome executable path.",
      );
    }
    const runtime = await this.profileStore.prepare(resolved);
    const launched = await launchNativeLogin({
      executable: this.paths.chromeExecutable,
      userDataDir: runtime.userDataDir,
      profileDirectory: resolved.directory,
      url: this.destination(undefined),
    });
    return {
      profile: resolved,
      visible: true,
      nativeChrome: true,
      automationControlled: false,
      url: this.destination(undefined),
      authenticated: null,
      processId: launched.pid,
      instructions:
        "Complete Grok sign-in in this ordinary Chrome window, then quit this dedicated " +
        "bridge Chrome instance completely (Command-Q on macOS) before running " +
        "sync_grok_options. Closing only its tab or window can leave Chrome running.",
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
    this.config = await saveGrokConfig(
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

  async requireGrokPage({ profile, projectUrl } = {}) {
    const destination = this.destination(projectUrl);
    const opened = await this.openGrok({
      profile,
      visible: false,
      targetUrl: destination,
    });
    if (!isAllowedGrokUrl(this.page.url())) {
      throw new Error(
        `The browser left grok.com (${this.page.url()}). Use open_grok_for_login if authentication is required.`,
      );
    }
    if (!opened.authenticated) {
      throw new Error(
        "The configured automation profile is not signed in to Grok. Refresh login from the Jackson Stone Personal Chrome profile or use open_grok_for_login.",
      );
    }
    return opened;
  }

  async syncOptions(options = {}) {
    const result = await this.withBrowserActivity(() =>
      this.performSyncOptions(options),
    );
    try {
      await this.closeBrowserIfIdle();
    } catch (error) {
      result.warnings = [
        ...(result.warnings || []),
        `Grok options synced, but the refreshed session could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
    return result;
  }

  async performSyncOptions({ profile, projectUrl, forceRescan = false } = {}) {
    const opened = await this.requireGrokPage({ profile, projectUrl });
    const options = await discoverGrokOptions(this.page);
    this.cache = {
      version: 1,
      profile: this.profile.directory,
      syncedAt: new Date().toISOString(),
      signatures: options.signatures,
      modelOptions: options.modelOptions,
      models: options.models,
    };
    await writeJsonAtomic(this.paths.cacheFile, this.cache);
    return {
      profile: this.profile,
      projectUrl: opened.projectUrl,
      authenticated: opened.authenticated,
      syncedAt: this.cache.syncedAt,
      modelOptions: options.modelOptions,
      models: options.models,
      forceRescan,
    };
  }

  async openTaskPage({ profile, projectUrl, newChat = true } = {}) {
    const browser = await this.ensureBrowser({ profile, visible: false });
    const destination = this.destination(projectUrl);
    const page = newChat ? await browser.context.newPage() : browser.page;
    const ownedPage = page !== browser.page;
    const atDestination =
      destination === GROK_URL
        ? isAllowedGrokUrl(page.url())
        : page.url().startsWith(destination);
    if (newChat || !atDestination) {
      await page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await page.waitForTimeout(500);
    const authentication = await waitForGrokAuthenticationStatus(page);
    if (!authentication.authenticated) {
      if (ownedPage) await page.close().catch(() => {});
      throw new Error(
        "The configured automation profile is not signed in to Grok. Refresh it from Jackson Stone Personal Chrome or use open_grok_for_login.",
      );
    }
    this.workerAuthenticated = true;
    return {
      page,
      ownedPage,
      profile: browser.profile,
      projectUrl: destination === GROK_URL ? null : destination,
    };
  }

  async selectModelWithRepair(page, preference, allowFallback) {
    try {
      return await selectGrokModel(page, preference, { allowFallback });
    } catch (firstError) {
      this.cache.signatures = {
        ...(this.cache.signatures || {}),
        modelTrigger: null,
      };
      try {
        return await selectGrokModel(page, preference, { allowFallback });
      } catch (secondError) {
        throw new Error(
          `${secondError.message} Recovery retry: ${firstError.message}`,
        );
      }
    }
  }

  async ask(options = {}) {
    return this.withBrowserActivity(() => this.performAsk(options));
  }

  async performAsk({
    jobId = null,
    prompt,
    attachments = [],
    profile,
    projectUrl,
    model,
    newChat = true,
    allowFallback = false,
    timeoutSeconds,
    onPhase = null,
  }) {
    if (!prompt || !String(prompt).trim()) {
      throw new Error("A non-empty writing prompt is required.");
    }
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
    const requestedModel = model || this.config.defaultModel || "Fast";
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
      const modelSelection = await this.selectModelWithRepair(
        taskPage,
        requestedModel,
        allowFallback,
      );
      const longRunning = !/^fast$/i.test(
        modelSelection.selected || requestedModel,
      );
      const baseline = await submitGrokPrompt(taskPage, String(prompt), {
        attachments: prepared.attachments,
        sendThrough: async (sendAction) => {
          if (typeof onPhase === "function") onPhase("waiting_to_submit");
          return this.submissionPacer.run(sendAction, {
            intervalSeconds:
              this.config.submissionIntervalSeconds ||
              DEFAULT_SUBMISSION_INTERVAL_SECONDS,
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
      const response = await waitForGrokResponse(taskPage, baseline, {
        timeoutMs:
          1000 *
          Math.max(
            10,
            Math.min(
              MAX_JOB_TIMEOUT_SECONDS,
              timeoutSeconds ||
                this.config.timeoutSeconds ||
                DEFAULT_JOB_TIMEOUT_SECONDS,
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
      const warnings = prepared.publicAttachments
        .filter((attachment) => attachment.converted)
        .map(
          (attachment) =>
            `${attachment.originalName} was uploaded as ${attachment.sentName} after temporary local HEIC/HEIF-to-JPEG conversion; the original was not changed.`,
        );
      conversationUrl = taskPage.url();
      if (jobId) {
        this.rememberConversation(jobId, {
          conversationUrl,
          status: "completed",
          completionSignal: response.completionSignal,
        });
      }
      return {
        response: response.text,
        profile: opened.profile,
        projectUrl: opened.projectUrl,
        model: modelSelection,
        conversationUrl,
        elapsedMs: response.elapsedMs,
        completionSignal: response.completionSignal,
        responseCompletion: {
          quietWindowMs: response.quietWindowMs,
          longRunning,
          activeSignals: response.activeSignals,
        },
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

  resolveConversationUrl({ jobId, conversationUrl } = {}) {
    const record = this.getConversationRecord(jobId);
    const resolved = String(
      conversationUrl || record?.conversationUrl || "",
    ).trim();
    if (!resolved) {
      throw new Error(
        "No Grok conversation URL is available. Supply conversation_url or a job_id whose prompt reached Grok.",
      );
    }
    if (!isAllowedGrokUrl(resolved)) {
      throw new Error(`Conversation inspection is limited to grok.com: ${resolved}`);
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
      const authentication = await waitForGrokAuthenticationStatus(page);
      if (!authentication.authenticated) {
        throw new Error(
          "The configured automation profile is not signed in to Grok. Refresh or complete login before inspecting this conversation.",
        );
      }
      const hydration = await waitForGrokConversationHydration(page);
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

  async performInspectConversation({
    jobId,
    conversationUrl,
    profile,
    browserVisibility = "unchanged",
    captureScreenshot = true,
    keepOpen = false,
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
      const snapshot = await inspectGrokConversationState(resolved.page);
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

  async inspectConversation(options = {}) {
    const keepOpen = Boolean(options.keepOpen);
    const result = await this.withBrowserActivity(
      () => this.performInspectConversation(options),
      {
        idleDelayMs: keepOpen
          ? INSPECTION_KEEP_OPEN_MS
          : this.browserIdleCloseMs,
      },
    );
    if (!keepOpen) await this.closeBrowserIfIdle();
    return result;
  }

  async status() {
    const result = await super.status();
    result.cachedModelOptions = this.cache?.modelOptions || [];
    delete result.cachedReasoningOptions;
    delete result.responseFileRoot;
    return result;
  }
}
