export const GROK_URL = "https://grok.com/";

const COMPOSER_SELECTOR =
  '[role="textbox"][aria-label="Ask Grok anything"], [contenteditable="true"][aria-label="Ask Grok anything"], textarea[aria-label="Ask Grok anything"], textarea[placeholder="What do you want to know?"], textarea';
const MODEL_TRIGGER_SELECTOR =
  'button[aria-label="Model select"], button[data-testid*="model"]';
const SUBMIT_SELECTOR =
  'button[data-testid="chat-submit"], button[aria-label="Submit"], button[type="submit"]';
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid="assistant-message"] .response-content-markdown',
  '[data-testid="assistant-message"]',
  '[data-testid*="assistant"]',
  '[data-testid*="response"]',
  ".response-content-markdown",
  '[class*="response-content"]',
  "main article",
].join(",");

const ACTIVE_SELECTOR = [
  'button[aria-label*="stop" i]',
  'button[aria-label*="cancel" i]',
  'button[aria-label*="interrupt" i]',
  'button[data-testid*="stop" i]',
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-streaming="true"]',
  '[data-state="streaming"]',
  '[data-testid*="thinking" i]',
  '[data-testid*="generating" i]',
  '[data-testid*="searching" i]',
].join(",");

function folded(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function publicModelLabel(value) {
  return String(value || "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

export function isAllowedGrokUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "grok.com" || parsed.hostname.endsWith(".grok.com"))
    );
  } catch {
    return false;
  }
}

async function visibleCount(locator) {
  let count = 0;
  const total = await locator.count();
  for (let index = 0; index < total; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
  }
  return count;
}

async function firstVisible(locator) {
  const total = await locator.count();
  for (let index = 0; index < total; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

export async function grokAuthenticationStatus(page) {
  if (!isAllowedGrokUrl(page.url()) && page.url() !== "about:blank") {
    return {
      authenticated: false,
      reason: "unexpected-origin",
      url: page.url(),
    };
  }
  const loginControl = page.getByText(/^(?:Sign in|Sign up)$/i, { exact: true });
  if ((await visibleCount(loginControl)) > 0) {
    return {
      authenticated: false,
      reason: "login-control-visible",
      url: page.url(),
    };
  }
  const composer = await firstVisible(page.locator(COMPOSER_SELECTOR));
  if (composer) {
    return {
      authenticated: true,
      reason: "signed-in-composer-visible",
      url: page.url(),
    };
  }
  return {
    authenticated: false,
    reason: "composer-not-visible",
    url: page.url(),
  };
}

export async function waitForGrokAuthenticationStatus(
  page,
  { timeoutMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = await grokAuthenticationStatus(page);
  while (Date.now() < deadline) {
    if (
      last.authenticated ||
      ["login-control-visible", "unexpected-origin"].includes(last.reason)
    ) {
      return last;
    }
    await page.waitForTimeout(350);
    last = await grokAuthenticationStatus(page);
  }
  return last;
}

async function readVisibleModelMenu(page) {
  return page.locator('[role="menuitem"], [role="menuitemradio"]').evaluateAll(
    (elements) => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      return elements
        .filter(visible)
        .map((element, index) => {
          const emphasized = Array.from(
            element.querySelectorAll(
              '.font-semibold, [class*="font-semibold"], strong, b',
            ),
          )
            .map((node) => node.textContent?.replace(/\s+/g, " ").trim())
            .find(Boolean);
          const lines = (element.innerText || element.textContent || "")
            .split(/\n+/)
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const label = emphasized || lines[0] || "";
          return {
            index,
            label,
            description: lines.filter((line) => line !== label).join(" — "),
            disabled:
              element.matches(":disabled") ||
              element.getAttribute("aria-disabled") === "true",
          };
        })
        .filter(
          (item) =>
            item.label &&
            !/^unlock\b/i.test(item.label) &&
            !/upgrade|subscribe|custom instructions/i.test(item.label),
        );
    },
  );
}

export async function discoverGrokOptions(page) {
  const trigger = await firstVisible(page.locator(MODEL_TRIGGER_SELECTOR));
  if (!trigger) {
    throw new Error(
      "Could not find Grok's model selector. The UI may have changed; use conversation inspection before retrying a submitted job.",
    );
  }
  await trigger.click();
  await page.waitForTimeout(250);
  const models = await readVisibleModelMenu(page);
  await page.keyboard.press("Escape").catch(() => {});
  if (!models.length) {
    throw new Error(
      "Grok's model menu opened, but no selectable model labels were discovered.",
    );
  }
  return {
    modelOptions: models.map((model) => model.label),
    models,
    signatures: {
      modelTrigger: MODEL_TRIGGER_SELECTOR,
    },
  };
}

function findRequestedModel(models, requested) {
  const wanted = folded(requested);
  if (!wanted || wanted === "current" || wanted === "default") return null;
  const aliases = new Map([
    ["quick", "fast"],
    ["automatic", "auto"],
    ["thinking", "expert"],
    ["pro", "heavy"],
    ["max", "heavy"],
  ]);
  const normalizedWanted = aliases.get(wanted) || wanted;
  return (
    models.find((model) => folded(model.label) === normalizedWanted) ||
    models.find(
      (model) =>
        folded(model.label).includes(normalizedWanted) ||
        normalizedWanted.includes(folded(model.label)),
    ) ||
    null
  );
}

export async function selectGrokModel(
  page,
  preference,
  { allowFallback = false } = {},
) {
  const requested = String(preference || "Fast").trim() || "Fast";
  if (/^(?:current|default)$/i.test(requested)) {
    return { requested, selected: null, changed: false };
  }
  const trigger = await firstVisible(page.locator(MODEL_TRIGGER_SELECTOR));
  if (!trigger) throw new Error("Could not find Grok's model selector.");
  await trigger.click();
  await page.waitForTimeout(200);
  const models = await readVisibleModelMenu(page);
  let chosen = findRequestedModel(models, requested);
  if (!chosen && allowFallback) {
    chosen =
      models.find((model) => folded(model.label) === "fast" && !model.disabled) ||
      models.find((model) => !model.disabled) ||
      null;
  }
  if (!chosen || chosen.disabled) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `Grok model “${requested}” is not available. Discovered choices: ${
        models.map((model) => model.label).join(", ") || "none"
      }.`,
    );
  }
  const items = page.locator('[role="menuitem"], [role="menuitemradio"]');
  const target = items.nth(chosen.index);
  if (!(await target.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error("Grok's model menu changed while selecting an option.");
  }
  await target.click();
  return {
    requested,
    selected: chosen.label,
    description: chosen.description || null,
    changed: true,
    available: models.map((model) => model.label),
  };
}

async function assistantMessages(page) {
  return page.locator(ASSISTANT_SELECTORS).evaluateAll((elements) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const ordered = [...elements].sort((left, right) => {
      const priority = (element) => {
        if (
          element.matches(".response-content-markdown") &&
          element.closest(
            '[data-testid="assistant-message"], [data-message-author-role="assistant"]',
          )
        ) {
          return 0;
        }
        if (element.matches('[data-message-author-role="assistant"]')) return 1;
        if (element.matches('[data-testid="assistant-message"]')) return 2;
        return 3;
      };
      return priority(left) - priority(right);
    });
    const records = [];
    for (const element of ordered) {
      if (!visible(element)) continue;
      if (element.closest("nav, aside, [role=menu], form")) continue;
      if (
        element.closest(
          '[data-testid="user-message"], [data-message-author-role="user"]',
        )
      ) {
        continue;
      }
      const text = (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      if (
        records.some(
          (record) =>
            record.element.contains(element) ||
            element.contains(record.element) ||
            record.text === text,
        )
      ) {
        continue;
      }
      records.push({ element, text });
    }
    return records.map((record, index) => ({
      index,
      text: record.text,
    }));
  });
}

async function terminalActionSignal(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const assistantTurns = Array.from(
      document.querySelectorAll(
        '[data-testid="assistant-message"], [data-message-author-role="assistant"]',
      ),
    ).filter(visible);
    const latest = assistantTurns.at(-1);
    if (!latest) return null;
    let container = latest;
    for (let level = 0; level < 4 && container; level += 1) {
      const finalActions = container.querySelector?.(
        ".action-buttons.last-response",
      );
      if (visible(finalActions)) return "last-response-actions";
      const regenerate = Array.from(
        container.querySelectorAll?.('button[aria-label="Regenerate"]') || [],
      ).find(visible);
      if (regenerate) return "regenerate-action";
      const copy = Array.from(
        container.querySelectorAll?.('button[aria-label="Copy"]') || [],
      ).find(visible);
      if (copy) return "copy-action";
      container = container.parentElement;
    }
    return null;
  });
}

async function activeSignals(page) {
  const activeControls = await visibleCount(page.locator(ACTIVE_SELECTOR));
  const statusTexts = await page
    .getByText(/^(?:Thinking|Searching|Generating|Working|Writing)(?:…|\.\.\.)?$/i)
    .allTextContents()
    .catch(() => []);
  return {
    active: activeControls > 0 || statusTexts.length > 0,
    activeControlCount: activeControls,
    statusTexts: statusTexts.map((text) => text.trim()).filter(Boolean),
  };
}

async function waitForAttachmentReadiness(page, attachments, timeoutMs = 120_000) {
  const expectedNames = attachments.map((attachment) => attachment.uploadName);
  const deadline = Date.now() + timeoutMs;
  let matchedNames = [];
  while (Date.now() < deadline) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    matchedNames = expectedNames.filter((name) => bodyText.includes(name));
    const progress = await visibleCount(
      page.locator(
        '[role="progressbar"], [aria-busy="true"], [data-testid*="upload" i][data-state="loading"]',
      ),
    );
    const submit = await firstVisible(page.locator(SUBMIT_SELECTOR));
    const enabled = submit
      ? await submit.isEnabled().catch(() => false)
      : false;
    if (progress === 0 && enabled && matchedNames.length === expectedNames.length) {
      return { matchedNames, progressControls: 0 };
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Grok did not finish preparing all attachments before the upload deadline. Ready filenames: ${
      matchedNames.join(", ") || "none"
    }. The prompt was not submitted and the bridge will not retry the upload automatically.`,
  );
}

export async function submitGrokPrompt(
  page,
  prompt,
  { attachments = [], sendThrough } = {},
) {
  const composer = await firstVisible(page.locator(COMPOSER_SELECTOR));
  if (!composer) throw new Error("Could not find Grok's prompt composer.");
  const baselineMessages = await assistantMessages(page);
  let attachmentUpload = {
    requestedCount: attachments.length,
    method: null,
    readyUiEvidence: null,
  };
  if (attachments.length) {
    const input = page.locator(FILE_INPUT_SELECTOR).first();
    if ((await input.count()) === 0) {
      throw new Error(
        "Could not find Grok's attachment input. No prompt was submitted.",
      );
    }
    await input.setInputFiles(
      attachments.map((attachment) => attachment.uploadPath),
    );
    attachmentUpload = {
      requestedCount: attachments.length,
      method: "existing-file-input",
      readyUiEvidence: null,
    };
  }
  await composer.fill(String(prompt));
  await composer.dispatchEvent("input").catch(() => {});
  if (attachments.length) {
    attachmentUpload.readyUiEvidence = await waitForAttachmentReadiness(
      page,
      attachments,
    );
  }
  const sendAction = async () => {
    const submit = await firstVisible(page.locator(SUBMIT_SELECTOR));
    if (!submit || !(await submit.isEnabled().catch(() => false))) {
      throw new Error(
        "Grok's Submit button was not available after prompt preparation. The bridge did not use an Enter-key fallback.",
      );
    }
    await submit.click();
    return { clicked: true, at: new Date().toISOString() };
  };
  const submitted =
    typeof sendThrough === "function"
      ? await sendThrough(sendAction)
      : { result: await sendAction(), pacing: null };
  return {
    baselineMessages,
    baselineCount: baselineMessages.length,
    submittedAt: new Date().toISOString(),
    submission: submitted?.pacing || null,
    attachmentUpload,
  };
}

export async function waitForGrokResponse(
  page,
  baseline,
  {
    timeoutMs = 2 * 60 * 60 * 1000,
    longRunning = false,
    onProgress = null,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const quietWindowMs = longRunning ? 8_000 : 2_000;
  const baselineTexts = new Set(
    (baseline?.baselineMessages || []).map((message) => message.text),
  );
  let candidate = null;
  let candidateChangedAt = null;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    const messages = await assistantMessages(page);
    const newMessages = messages.filter(
      (message, index) =>
        index >= Number(baseline?.baselineCount || 0) ||
        !baselineTexts.has(message.text),
    );
    const latest = newMessages.at(-1) || null;
    const signals = await activeSignals(page);
    const finalAction = await terminalActionSignal(page);
    if (latest?.text) {
      if (!candidate || candidate.text !== latest.text) {
        candidate = latest;
        candidateChangedAt = Date.now();
      }
    }
    if (
      typeof onProgress === "function" &&
      Date.now() - lastProgressAt >= 1_000
    ) {
      lastProgressAt = Date.now();
      onProgress({
        latestTextPreview: candidate?.text?.slice(0, 500) || null,
        assistantMessageCount: messages.length,
        activeSignals: signals,
        finalAction,
        quietForMs: candidateChangedAt ? Date.now() - candidateChangedAt : 0,
      });
    }
    if (
      candidate?.text &&
      !signals.active &&
      finalAction &&
      Date.now() - candidateChangedAt >= quietWindowMs
    ) {
      return {
        text: candidate.text,
        elapsedMs: Date.now() - Date.parse(baseline.submittedAt),
        completionSignal: finalAction,
        quietWindowMs,
        activeSignals: signals,
      };
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Grok did not reach a verified final response within ${Math.round(
      timeoutMs / 1000,
    )} seconds. Keep the original job ID and inspect its conversation; do not resubmit merely because this deadline elapsed.`,
  );
}

export async function waitForGrokConversationHydration(
  page,
  { timeoutMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let messages = [];
  while (Date.now() < deadline) {
    messages = await assistantMessages(page);
    if (messages.length) break;
    await page.waitForTimeout(300);
  }
  return {
    hydrated: messages.length > 0,
    assistantMessageCount: messages.length,
  };
}

export async function inspectGrokConversationState(page) {
  const messages = await assistantMessages(page);
  const signals = await activeSignals(page);
  const finalAction = await terminalActionSignal(page);
  const submit = await firstVisible(page.locator(SUBMIT_SELECTOR));
  const composer = await firstVisible(page.locator(COMPOSER_SELECTOR));
  return {
    url: page.url(),
    active: signals.active,
    activeSignals: signals,
    assistantMessageCount: messages.length,
    latestAssistantText: messages.at(-1)?.text || null,
    responseState:
      messages.length && !signals.active && finalAction
        ? "apparently-idle"
        : signals.active
          ? "generating"
          : "no-assistant-response",
    composerVisible: Boolean(composer),
    terminalActionSignal: finalAction,
    submitAvailable: Boolean(
      submit && (await submit.isEnabled().catch(() => false)),
    ),
    visibleText: (await page.locator("body").innerText().catch(() => "")).slice(
      0,
      20_000,
    ),
  };
}

export async function grokUiDiagnostics(page) {
  return {
    url: page.url(),
    allowedOrigin: isAllowedGrokUrl(page.url()),
    composerCount: await visibleCount(page.locator(COMPOSER_SELECTOR)),
    modelTriggerCount: await visibleCount(page.locator(MODEL_TRIGGER_SELECTOR)),
    submitCount: await visibleCount(page.locator(SUBMIT_SELECTOR)),
    attachmentInputCount: await page.locator(FILE_INPUT_SELECTOR).count(),
    assistantCandidateCount: (await assistantMessages(page)).length,
    activeSignals: await activeSignals(page),
  };
}

export const grokSelectors = Object.freeze({
  composer: COMPOSER_SELECTOR,
  modelTrigger: MODEL_TRIGGER_SELECTOR,
  submit: SUBMIT_SELECTOR,
  fileInput: FILE_INPUT_SELECTOR,
  assistant: ASSISTANT_SELECTORS,
});
