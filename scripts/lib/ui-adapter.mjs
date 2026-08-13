import crypto from "node:crypto";
import fs from "node:fs/promises";

import {
  filenameFromContentDisposition,
  MAX_RESPONSE_FILES,
  MAX_RESPONSE_FILE_BYTES,
  MAX_RESPONSE_TOTAL_BYTES,
  prepareResponseOutputDirectory,
  safeRemoteUrl,
  savePlaywrightDownload,
  saveResponseBuffer,
  writeResponseFileManifest,
} from "./response-files.mjs";

export const CHATGPT_URL = "https://chatgpt.com/";

export function isAllowedChatGptUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        url.hostname === "openai.com" ||
        url.hostname.endsWith(".openai.com"))
    );
  } catch {
    return false;
  }
}

const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  'textarea[name="prompt-textarea"]',
  'textarea[placeholder*="Message" i]',
  'form [contenteditable="true"][role="textbox"]',
  'main [contenteditable="true"][role="textbox"]',
];

const MODEL_TRIGGER_SELECTORS = [
  '[data-testid="model-switcher-dropdown-button"]',
  '[data-testid*="model-switcher" i]',
  'main form button[aria-haspopup="menu"]',
  'form button[aria-haspopup="menu"]',
  'main button[aria-label*="model" i][aria-haspopup]',
  'main form button[aria-label*="model" i]',
];

const REASONING_TRIGGER_SELECTORS = [
  '[data-testid*="reasoning" i]',
  '[data-testid*="effort" i]',
  '[data-testid*="thinking" i]',
  'main form button[aria-haspopup="menu"]',
  'form button[aria-haspopup="menu"]',
  'main button[aria-label*="reasoning" i]',
  'main button[aria-label*="thinking" i]',
  'main button[aria-label*="effort" i]',
];

const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'form button[type="submit"]',
];

const ATTACHMENT_TRIGGER_SELECTORS = [
  '[data-testid="composer-plus-btn"]',
  '[data-testid*="attach" i]',
  'form button[aria-label*="Add files" i]',
  'form button[aria-label*="Add photos" i]',
  'form button[aria-label*="Attach" i]',
];

const ATTACHMENT_MENU_SELECTORS = [
  '[role="menuitem"]:has-text("Add photos & files")',
  '[role="menuitem"]:has-text("Upload from computer")',
  '[role="menuitem"]:has-text("Upload files")',
  'button:has-text("Add photos & files")',
  'button:has-text("Upload from computer")',
  'button:has-text("Upload files")',
];

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]) [data-message-author-role="assistant"]',
  'article[data-turn="assistant"]',
];

const ACTIVE_RESPONSE_SELECTORS = [
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
  'button[aria-label*="Stop generating" i]',
  'button[aria-label*="Stop" i]',
  'button[aria-label*="Interrupt" i]',
  'button[aria-label*="Cancel" i]',
  '[data-is-streaming="true"]',
  '[data-streaming="true"]',
  '[data-testid*="task" i][data-state="running"]',
  '[data-testid*="task" i][data-status="running"]',
  '[data-testid*="research" i][data-state="running"]',
  '[data-testid*="research" i][data-status="running"]',
  'main [aria-busy="true"]',
  'main [role="progressbar"]',
];

const RESPONSE_FILE_EXTENSION_PATTERN =
  /([^\s<>:"|?*\/\\]+\.(?:csv|docx?|gif|html?|jpe?g|json|md|odp|ods|odt|pdf|png|pptx?|rtf|svg|tsv|txt|webp|xlsx?|xml|zip))\b/i;

export const PRO_FINAL_QUIET_MS = 15_000;
export const STANDARD_FINAL_QUIET_MS = 1_000;

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count(), 12);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible()) return { locator: item, selector };
      }
    } catch {
      // A selector unsupported by an older Chromium build should not stop recovery.
    }
  }
  return null;
}

async function markSemanticTarget(page, kind) {
  const token = `${kind}-${crypto.randomUUID()}`;
  const found = await page.evaluate(
    ({ targetKind, marker }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 4 &&
          rect.height > 4 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
        );
      };
      const words = (element) =>
        [
          element.getAttribute("aria-label"),
          element.getAttribute("data-testid"),
          element.getAttribute("placeholder"),
          element.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], textarea, [contenteditable="true"]',
        ),
      ).filter(visible);
      let best = null;
      let bestScore = -Infinity;
      for (const element of candidates) {
        const text = words(element);
        const rect = element.getBoundingClientRect();
        let score = 0;
        if (targetKind === "composer") {
          if (
            !(
              element.matches("textarea") ||
              element.getAttribute("contenteditable") === "true"
            )
          ) {
            continue;
          }
          if (/prompt|message|ask|chat/.test(text)) score += 80;
          if (element.getAttribute("role") === "textbox") score += 30;
          score += Math.max(0, rect.top / Math.max(innerHeight, 1)) * 20;
          score += Math.min(rect.width / 30, 20);
        } else {
          if (!element.matches('button, [role="button"]')) continue;
          if (element.closest("[data-sidebar-item], aside, nav")) continue;
          const opensPopup = Boolean(element.getAttribute("aria-haspopup"));
          const inComposerForm = Boolean(element.closest("form"));
          if (opensPopup) score += 28;
          if (opensPopup && inComposerForm) score += 70;
          if (targetKind === "model") {
            if (/model|gpt|chatgpt|\bo[134]\b/.test(text)) score += 75;
            if (/sidebar|history|account|profile/.test(text)) score -= 45;
          } else if (targetKind === "reasoning") {
            if (
              /reason|thinking|effort|fast|instant|\blow\b|\bmedium\b|\bhigh\b|\bdeep\b|extended|\bmax(?:imum)?\b|\bpro\b/.test(
                text,
              )
            ) {
              score += 75;
            }
            if (/sidebar|history|account|profile/.test(text)) score -= 45;
          }
          if (rect.top < innerHeight * 0.8) score += 8;
        }
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
      const threshold = targetKind === "composer" ? 35 : 50;
      if (!best || bestScore < threshold) return null;
      best.setAttribute("data-chatgpt-chrome-bridge", marker);
      return { score: bestScore };
    },
    { targetKind: kind, marker: token },
  );
  if (!found) return null;
  return {
    locator: page.locator(`[data-chatgpt-chrome-bridge="${token}"]`),
    selector: `[data-chatgpt-chrome-bridge="${token}"]`,
    semantic: true,
  };
}

async function signatureFor(locator) {
  return locator.evaluate((element) => ({
    testId: element.getAttribute("data-testid") || null,
    ariaLabel: element.getAttribute("aria-label") || null,
    role: element.getAttribute("role") || element.tagName.toLowerCase(),
    text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
  }));
}

async function locateFromSignature(page, signature) {
  if (!signature) return null;
  const selectors = [];
  if (signature.testId) {
    selectors.push(`[data-testid=${JSON.stringify(signature.testId)}]`);
  }
  if (signature.ariaLabel) {
    selectors.push(
      `${signature.role === "button" ? "button" : ""}[aria-label=${JSON.stringify(
        signature.ariaLabel,
      )}]`,
    );
  }
  const found = await firstVisible(page, selectors);
  if (found) return found;
  if (signature.text && signature.role === "button") {
    const buttons = page.getByRole("button", { name: signature.text, exact: true });
    const count = Math.min(await buttons.count(), 4);
    for (let index = 0; index < count; index += 1) {
      if (await buttons.nth(index).isVisible()) {
        return { locator: buttons.nth(index), selector: "accessible-name" };
      }
    }
  }
  return null;
}

export async function findComposer(page) {
  return (await firstVisible(page, COMPOSER_SELECTORS)) || markSemanticTarget(page, "composer");
}

async function findPickerTrigger(page, kind, cachedSignature = null) {
  const selectors =
    kind === "model" ? MODEL_TRIGGER_SELECTORS : REASONING_TRIGGER_SELECTORS;
  const deadline = Date.now() + 8_000;
  do {
    const cached = await locateFromSignature(page, cachedSignature);
    if (cached) return cached;
    const stable = await firstVisible(page, selectors);
    if (stable) return stable;
    const semantic = await markSemanticTarget(page, kind);
    if (semantic) return semantic;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return null;
}

async function visiblePopupOptions(page, kind) {
  const tokenPrefix = `option-${crypto.randomUUID()}`;
  return page.evaluate(
    ({ prefix, pickerKind }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 4 &&
          rect.height > 4 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0
        );
      };
      const overlayRoots = Array.from(
        document.querySelectorAll(
          '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-menu-content], [data-headlessui-state~="open"]',
        ),
      ).filter(visible);
      const candidates = new Set();
      for (const root of overlayRoots) {
        for (const element of root.querySelectorAll(
          '[role="menuitem"], [role="menuitemradio"], [role="option"], button, [role="button"]',
        )) {
          if (visible(element)) candidates.add(element);
        }
      }
      for (const element of document.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
      )) {
        if (visible(element)) candidates.add(element);
      }

      const results = [];
      const seen = new Set();
      let index = 0;
      for (const element of candidates) {
        const label = [
          element.getAttribute("aria-label"),
          element.innerText || element.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 180);
        const normalized = label.toLowerCase();
        if (!label || seen.has(normalized)) continue;
        if (/log out|settings|delete|archive|share/.test(normalized)) continue;
        if (
          element.getAttribute("aria-haspopup") === "menu" ||
          /^(?:power|advanced)(?:\s|$)|^show (?:advanced|compact) options|^(?:model|effort)(?:\s|$)/.test(
            normalized,
          )
        ) {
          continue;
        }
        if (
          pickerKind === "reasoning" &&
          !/reason|thinking|effort|fast|instant|\blow\b|\bmedium\b|standard|balanced|\bhigh\b|\bdeep\b|extended|\bmax(?:imum)?\b|\bpro\b/.test(
            normalized,
          )
        ) {
          continue;
        }
        const marker = `${prefix}-${index++}`;
        element.setAttribute("data-chatgpt-chrome-option", marker);
        results.push({
          label,
          marker,
          selected:
            element.getAttribute("aria-checked") === "true" ||
            element.getAttribute("aria-selected") === "true" ||
            element.getAttribute("data-state") === "checked",
        });
        seen.add(normalized);
      }
      return results;
    },
    { prefix: tokenPrefix, pickerKind: kind },
  );
}

async function markVisiblePopupControl(page, kind) {
  const token = `popup-control-${crypto.randomUUID()}`;
  const found = await page.evaluate(
    ({ targetKind, marker }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 4 &&
          rect.height > 4 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0
        );
      };
      const roots = Array.from(
        document.querySelectorAll(
          '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-menu-content], [data-headlessui-state~="open"]',
        ),
      ).filter(visible);
      for (const root of roots) {
        const candidates = Array.from(
          root.querySelectorAll(
            '[role="menuitem"], [role="button"], button',
          ),
        ).filter(visible);
        for (const element of candidates) {
          const label = [
            element.getAttribute("aria-label"),
            element.innerText || element.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " ");
          const normalized = label.toLowerCase();
          const opensMenu = element.getAttribute("aria-haspopup") === "menu";
          const matches =
            targetKind === "advanced"
              ? /\badvanced\b/.test(normalized) && !opensMenu
              : opensMenu &&
                (targetKind === "model"
                  ? /(?:^|\s)model(?:\s|$)/.test(normalized)
                  : /(?:^|\s)effort(?:\s|$)/.test(normalized));
          if (!matches) continue;
          element.setAttribute("data-chatgpt-chrome-popup-control", marker);
          return {
            expanded: element.getAttribute("aria-expanded"),
            state: element.getAttribute("data-state"),
            label,
          };
        }
      }
      return null;
    },
    { targetKind: kind, marker: token },
  );
  if (!found) return null;
  return {
    ...found,
    locator: page.locator(
      `[data-chatgpt-chrome-popup-control="${token}"]`,
    ),
  };
}

async function openAdvancedPickerPath(page, kind) {
  const advanced = await markVisiblePopupControl(page, "advanced");
  let expandedAdvanced = false;
  if (advanced) {
    const collapsed =
      advanced.expanded === "false" ||
      /show advanced options/i.test(advanced.label);
    if (collapsed) {
      await advanced.locator.click({ timeout: 5_000 });
      await page.waitForTimeout(180);
      expandedAdvanced = true;
    }
  }

  let submenu = await markVisiblePopupControl(page, kind);
  if (
    !submenu &&
    advanced &&
    !expandedAdvanced &&
    advanced.expanded !== "true" &&
    !/show compact options/i.test(advanced.label)
  ) {
    await advanced.locator.click({ timeout: 5_000 });
    await page.waitForTimeout(180);
    submenu = await markVisiblePopupControl(page, kind);
  }
  if (!submenu) return false;
  if (submenu.expanded !== "true" && submenu.state !== "open") {
    await submenu.locator.click({ timeout: 5_000 });
    await page.waitForTimeout(220);
  }
  return true;
}

async function openPicker(page, kind, cachedSignature = null) {
  const trigger = await findPickerTrigger(page, kind, cachedSignature);
  if (!trigger) return { trigger: null, signature: null, options: [] };
  const signature = await signatureFor(trigger.locator);
  await trigger.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(220);
  await openAdvancedPickerPath(page, kind);
  const options = await visiblePopupOptions(page, kind);
  return { trigger, signature, options };
}

async function closePicker(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const openMenus = await page.evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 4 &&
          rect.height > 4 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0
        );
      };
      return Array.from(
        document.querySelectorAll('[role="menu"], [role="listbox"]'),
      ).filter(visible).length;
    });
    if (!openMenus) break;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(80);
  }
}

function uniqueOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const key = option.label.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const REASONING_WORDS =
  /reason|thinking|effort|fast|instant|\blow\b|\bmedium\b|standard|balanced|\bhigh\b|\bdeep\b|extended|\bmax(?:imum)?\b|\bpro\b/i;

export async function discoverAvailableOptions(
  page,
  cache = {},
  { includeModels = true } = {},
) {
  const model = includeModels
    ? await openPicker(page, "model", cache.modelTrigger)
    : { signature: null, options: [] };
  const modelOptions = uniqueOptions(model.options);
  if (includeModels) await closePicker(page);

  const reasoning = await openPicker(
    page,
    "reasoning",
    cache.reasoningTrigger,
  );
  const reasoningOptions = uniqueOptions([
    ...reasoning.options,
    ...modelOptions.filter((option) => REASONING_WORDS.test(option.label)),
  ]);
  await closePicker(page);

  return {
    modelOptions: modelOptions.map((option) => option.label),
    reasoningOptions: reasoningOptions.map((option) => option.label),
    signatures: {
      modelTrigger: includeModels ? model.signature : null,
      reasoningTrigger: reasoning.signature,
    },
  };
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/[–—_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PREFERENCE_ALIASES = {
  fast: ["fast", "instant", "quick"],
  low: ["low", "light", "fast", "instant"],
  medium: ["medium", "standard", "balanced"],
  high: ["high", "thinking", "deep"],
  xhigh: ["extra high", "x high", "xhigh", "extended", "pro"],
  "extra high": ["extra high", "x high", "xhigh", "extended", "pro"],
  max: ["max", "maximum", "pro", "extended", "deep"],
  pro: ["pro", "maximum", "max"],
};

function chooseOption(options, preference, allowFallback) {
  const wanted = normalize(preference);
  if (!wanted || wanted === "auto") return { option: null, fallback: false };
  const exact = options.find((option) => normalize(option.label) === wanted);
  if (exact) return { option: exact, fallback: false };

  const contained = options.find((option) => {
    const label = normalize(option.label);
    return label.includes(wanted);
  });
  if (contained) return { option: contained, fallback: false };

  const aliases = PREFERENCE_ALIASES[wanted] || [wanted];
  for (const alias of aliases) {
    const match = options.find((option) => normalize(option.label).includes(alias));
    if (match) return { option: match, fallback: alias !== wanted };
  }
  if (allowFallback && options.length) {
    return { option: options[0], fallback: true };
  }
  return { option: null, fallback: false };
}

export async function selectPreference(
  page,
  kind,
  preference,
  { allowFallback = false, cachedSignature = null } = {},
) {
  const wanted = normalize(preference);
  if (!wanted || wanted === "auto") {
    return { requested: preference || "auto", selected: null, changed: false };
  }
  const opened = await openPicker(page, kind, cachedSignature);
  const available = opened.options.map((option) => option.label);
  const choice = chooseOption(opened.options, preference, allowFallback);
  if (!choice.option) {
    await closePicker(page);
    throw new Error(
      `Requested ${kind} option “${preference}” is not visible. Available ${kind} options: ${
        available.join(", ") || "none discovered"
      }`,
    );
  }
  const locator = page.locator(
    `[data-chatgpt-chrome-option="${choice.option.marker}"]`,
  );
  await locator.click({ timeout: 5_000 });
  await page.waitForTimeout(250);
  await closePicker(page);
  return {
    requested: preference,
    selected: choice.option.label,
    changed: true,
    fallback: choice.fallback,
    available,
    signature: opened.signature,
  };
}

export async function setComposerText(page, prompt) {
  const composer = await findComposer(page);
  if (!composer) {
    throw new Error(
      "ChatGPT's message composer was not found. The account may be signed out or the UI changed.",
    );
  }
  try {
    await composer.locator.fill(prompt);
  } catch {
    await composer.locator.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(prompt);
  }
  return composer;
}

export async function assistantMessages(page) {
  for (const selector of ASSISTANT_SELECTORS) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (!count) continue;
      const messages = [];
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!(await item.isVisible())) continue;
        const completion = await item.evaluate((element) => {
          const visible = (candidate) => {
            if (!candidate || typeof candidate.getBoundingClientRect !== "function") {
              return false;
            }
            const rect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return (
              rect.width > 2 &&
              rect.height > 2 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const turn =
            element.closest(
              '[data-testid^="conversation-turn-"], article[data-turn], section[data-turn]',
            ) || element;
          const controls = Array.from(
            turn.querySelectorAll('button, [role="button"]'),
          ).filter(visible);
          for (const control of controls) {
            const testId = control.getAttribute("data-testid") || "";
            const label = (
              control.getAttribute("aria-label") ||
              control.textContent ||
              ""
            )
              .trim()
              .replace(/\s+/g, " ");
            if (
              /(?:copy|share|good|bad|regenerate).*turn-action|turn-action.*(?:copy|share|good|bad|regenerate)/i.test(
                testId,
              ) ||
              /^(?:copy response|share|good response|bad response|read aloud|switch model|regenerate(?: response)?|more actions)$/i.test(
                label,
              )
            ) {
              return {
                terminal: true,
                signal: testId || `aria-label:${label}`,
              };
            }
          }
          return { terminal: false, signal: null };
        });
        messages.push({
          text: (await item.innerText()).trim(),
          index,
          ...completion,
        });
      }
      if (messages.length) return messages;
    } catch {
      // Keep scanning alternate message structures.
    }
  }
  return [];
}

function looksLikeProInterim(text) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (!value) return false;
  return (
    /^(?:progress update[:—-]?\s*)?(?:i(?:'|’)m|i am|we(?:'|’)re|we are) (?:still |currently )?(?:working|researching|searching|analyzing|gathering|reviewing|preparing|building|creating|processing)\b/i.test(
      value,
    ) ||
    /\b(?:i(?:'|’)ll|i will|we(?:'|’)ll|we will) (?:return|come back|follow up|provide the full|share the full|continue working)\b/i.test(
      value,
    ) ||
    /\b(?:still working|work in progress|research in progress|analysis in progress|continuing (?:the |this )?(?:work|research|analysis))\b/i.test(
      value,
    )
  );
}

export async function discoverResponseFileCandidates(page) {
  const prefix = `response-file-${crypto.randomUUID()}`;
  const raw = await page.evaluate(
    ({ markerPrefix, extensionPattern }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 2 &&
          rect.height > 2 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
        );
      };
      const assistants = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="assistant"], article[data-turn="assistant"]',
        ),
      ).filter(visible);
      const assistant = assistants.at(-1);
      if (!assistant) return [];
      const turn =
        assistant.closest(
          '[data-testid^="conversation-turn-"], article[data-turn], section[data-turn]',
        ) || assistant;
      const extensionRegex = new RegExp(extensionPattern, "i");
      const elements = Array.from(
        turn.querySelectorAll(
          'a, button, [role="button"], [data-testid*="file" i], [data-testid*="artifact" i], [data-testid*="attachment" i], [class*="file" i], [class*="artifact" i]',
        ),
      )
        .filter(visible)
        .map((element) => {
          const href = element.getAttribute("href") || "";
          const text = (element.innerText || element.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 500);
          const signal = [
            element.getAttribute("download"),
            element.getAttribute("data-testid"),
            element.getAttribute("aria-label"),
            element.getAttribute("class"),
            text,
            href,
          ]
            .filter(Boolean)
            .join(" ");
          let score = 0;
          if (element.hasAttribute("download")) score += 120;
          if (/sandbox:|\/backend-api\/(?:files|attachments)|\/files\/|\/attachments\//i.test(href)) {
            score += 100;
          }
          if (element instanceof HTMLAnchorElement) score += 50;
          if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
            score += 45;
          }
          if (/(?:file|artifact|attachment|download)/i.test(signal)) score += 25;
          if (new RegExp(extensionPattern, "i").test(signal)) score += 30;
          return { element, score };
        })
        .sort((left, right) => right.score - left.score)
        .map(({ element }) => element);
      const candidates = [];
      const seen = new Set();
      for (const element of elements) {
        const hrefAttribute = element.getAttribute("href") || "";
        const href = element instanceof HTMLAnchorElement
          ? element.href || hrefAttribute
          : hrefAttribute;
        const downloadName = element.getAttribute("download") || "";
        const testId = element.getAttribute("data-testid") || "";
        const ariaLabel = element.getAttribute("aria-label") || "";
        const title = element.getAttribute("title") || "";
        const text = (element.innerText || element.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 500);
        const combined = [downloadName, ariaLabel, title, text, href]
          .filter(Boolean)
          .join(" ");
        const fileMatch = combined.match(extensionRegex)?.[1] || "";
        const explicitDownload =
          Boolean(downloadName) ||
          /(?:^|[-_ ])download(?:[-_ ]|$)/i.test(`${testId} ${ariaLabel} ${text}`);
        const internalFileHref =
          /(?:sandbox:|\/backend-api\/(?:files|attachments)|\/files\/|\/attachments\/|oaiusercontent\.com|openaiusercontent\.com)/i.test(
            href,
          );
        const fileLikeTestId = /(?:file|artifact|attachment|download)/i.test(testId);
        const fileCard = Boolean(
          element.closest(
            '[data-testid*="file" i], [data-testid*="artifact" i], [data-testid*="attachment" i], [class*="file" i], [class*="artifact" i]',
          ),
        );
        const directlyInteractive =
          element instanceof HTMLAnchorElement ||
          element instanceof HTMLButtonElement ||
          element.getAttribute("role") === "button" ||
          getComputedStyle(element).cursor === "pointer";
        if (
          !(
            Boolean(downloadName) ||
            (explicitDownload && (fileMatch || internalFileHref || fileLikeTestId)) ||
            (internalFileHref && (fileMatch || fileLikeTestId || fileCard)) ||
            (fileMatch && (directlyInteractive || fileLikeTestId || fileCard))
          )
        ) {
          continue;
        }
        if (/copy-turn-action|share-turn-action|regenerate/i.test(testId)) continue;
        const suggestedName = downloadName || fileMatch ||
          ariaLabel.match(extensionRegex)?.[1] ||
          text.match(extensionRegex)?.[1] ||
          `chatgpt-file-${candidates.length + 1}`;
        const dedupeKey = `${href}\u0000${String(suggestedName).toLowerCase()}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const marker = `${markerPrefix}-${candidates.length}`;
        element.setAttribute("data-chatgpt-response-file", marker);
        candidates.push({
          marker,
          suggestedName,
          label: ariaLabel || title || text || suggestedName,
          href: href || null,
          testId: testId || null,
          kind: element.tagName.toLowerCase(),
          explicitDownload,
          fileCard,
          directlyInteractive,
        });
      }
      return candidates;
    },
    {
      markerPrefix: prefix,
      extensionPattern: RESPONSE_FILE_EXTENSION_PATTERN.source,
    },
  );
  return raw.slice(0, MAX_RESPONSE_FILES);
}

function publicResponseFileCandidate(candidate) {
  return {
    suggestedName: candidate.suggestedName,
    label: candidate.label,
    sourceUrl: safeRemoteUrl(candidate.href),
    testId: candidate.testId,
    kind: candidate.kind,
    explicitDownload: candidate.explicitDownload,
    fileCard: candidate.fileCard,
    directlyInteractive: candidate.directlyInteractive,
  };
}

async function responseFileUiHints(page) {
  const hints = await page.evaluate(({ extensionPattern }) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const assistants = Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"], article[data-turn="assistant"]',
      ),
    ).filter(visible);
    const assistant = assistants.at(-1);
    if (!assistant) return [];
    const turn =
      assistant.closest(
        '[data-testid^="conversation-turn-"], article[data-turn], section[data-turn]',
      ) || assistant;
    const extensionRegex = new RegExp(extensionPattern, "i");
    return Array.from(turn.querySelectorAll("*"))
      .filter(visible)
      .map((element) => {
        const text = (element.innerText || element.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 300);
        const testId = element.getAttribute("data-testid") || "";
        const ariaLabel = element.getAttribute("aria-label") || "";
        const className =
          typeof element.className === "string" ? element.className.slice(0, 500) : "";
        const href = element.getAttribute("href") || "";
        const signal = [text, testId, ariaLabel, className, href]
          .filter(Boolean)
          .join(" ");
        if (
          !extensionRegex.test(signal) &&
          !/(?:file|artifact|attachment|download)/i.test(
            `${testId} ${ariaLabel} ${className}`,
          )
        ) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || null,
          testId: testId || null,
          ariaLabel: ariaLabel || null,
          download: element.getAttribute("download") || null,
          href: href || null,
          text,
          className: className || null,
          tabindex: element.getAttribute("tabindex"),
          cursor: getComputedStyle(element).cursor,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height)
      .slice(0, 30);
  }, { extensionPattern: RESPONSE_FILE_EXTENSION_PATTERN.source });
  return hints.map((hint) => ({
    ...hint,
    href: safeRemoteUrl(hint.href),
  }));
}

async function interactiveUiHints(page) {
  const hints = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0
      );
    };
    return Array.from(
      document.querySelectorAll('button, a, [role="button"], [tabindex="0"]'),
    )
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const svg = element.querySelector("svg");
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || null,
          testId: element.getAttribute("data-testid") || null,
          ariaLabel: element.getAttribute("aria-label") || null,
          title: element.getAttribute("title") || null,
          download: element.getAttribute("download") || null,
          href: element.getAttribute("href") || null,
          text: (element.innerText || element.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 200),
          className:
            typeof element.className === "string"
              ? element.className.slice(0, 300)
              : null,
          svg: svg
            ? {
                ariaLabel: svg.getAttribute("aria-label") || null,
                dataTestId: svg.getAttribute("data-testid") || null,
                className:
                  typeof svg.getAttribute("class") === "string"
                    ? svg.getAttribute("class").slice(0, 200)
                    : null,
                viewBox: svg.getAttribute("viewBox") || null,
                pathCount: svg.querySelectorAll("path").length,
                pathD: Array.from(svg.querySelectorAll("path"))
                  .map((item) => item.getAttribute("d") || "")
                  .join(" ")
                  .slice(0, 500),
              }
            : null,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)
      .slice(0, 80);
  });
  return hints.map((hint) => ({ ...hint, href: safeRemoteUrl(hint.href) }));
}

async function activeResponseState(page) {
  const control = await firstVisible(page, ACTIVE_RESPONSE_SELECTORS);
  if (control) {
    const signature = await signatureFor(control.locator);
    return {
      active: true,
      signal:
        signature.testId ||
        signature.ariaLabel ||
        signature.text ||
        control.selector,
    };
  }

  const semantic = await page.evaluate(() => {
    const visible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const candidates = Array.from(
      document.querySelectorAll(
        'main button, main [role="status"], main [aria-live], main [data-status], main [data-state], main [data-testid]',
      ),
    ).filter(visible);
    for (const element of candidates) {
      const testId = element.getAttribute("data-testid") || "";
      const label = [
        element.getAttribute("aria-label"),
        testId,
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 300);
      const state = [
        element.getAttribute("data-state"),
        element.getAttribute("data-status"),
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      const shortStatus =
        !/^conversation-turn-/i.test(testId) &&
        label.length <= 240 &&
        /(?:^|\b)(?:still working|work in progress|research in progress|analysis in progress|in progress|working|researching|thinking|searching|analyzing|browsing|reading sources|gathering sources|creating files?|generating|processing|running|queued|finishing up|finalizing|taking longer than expected|will notify you|you(?:'|’)ll be notified|continue working|continuing (?:the |this )?(?:work|research|analysis)|you can leave this page)(?:\b|…|\.\.\.)/i.test(
          label,
        );
      const activeState =
        /^(?:loading|queued|running|streaming|generating|thinking|working|pending|in[ -]?progress)$/i.test(
          state,
        );
      if (shortStatus || activeState) {
        return {
          active: true,
          signal: label || `state:${state}`,
        };
      }
    }
    return null;
  });
  return semantic || { active: false, signal: null };
}

async function visibleError(page) {
  const alerts = page.locator('[role="alert"]');
  const count = Math.min(await alerts.count(), 5);
  for (let index = 0; index < count; index += 1) {
    const alert = alerts.nth(index);
    if (!(await alert.isVisible())) continue;
    const text = (await alert.innerText()).trim();
    if (text) return text.slice(0, 500);
  }
  return null;
}

async function bestFileInput(page, attachments) {
  const inputs = page.locator('input[type="file"]');
  const count = Math.min(await inputs.count(), 20);
  const imagesOnly = attachments.every((item) => item.category === "image");
  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const locator = inputs.nth(index);
    let metadata;
    try {
      metadata = await locator.evaluate((element) => ({
        disabled: Boolean(element.disabled),
        multiple: Boolean(element.multiple),
        accept: String(element.accept || "").toLowerCase(),
        inForm: Boolean(element.closest("form")),
        testId: element.getAttribute("data-testid") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
      }));
    } catch {
      continue;
    }
    if (metadata.disabled) continue;
    if (attachments.length > 1 && !metadata.multiple) continue;
    const imageOnlyInput =
      metadata.accept.includes("image/") &&
      !/(?:application|text|\.pdf|\.doc|\.csv|\.xls|\*\/\*)/.test(metadata.accept);
    if (!imagesOnly && imageOnlyInput) continue;
    let score = 0;
    if (metadata.multiple) score += 30;
    if (metadata.inForm) score += 25;
    if (/attach|upload|file/.test(`${metadata.testId} ${metadata.ariaLabel}`)) {
      score += 25;
    }
    if (!metadata.accept || metadata.accept.includes("*/*")) score += 10;
    if (imagesOnly && metadata.accept.includes("image/")) score += 15;
    if (score > bestScore) {
      best = { locator, metadata };
      bestScore = score;
    }
  }
  return best;
}

async function waitForFileInput(page, attachments, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = await bestFileInput(page, attachments);
    if (found) return found;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return null;
}

async function markSemanticAttachmentAction(page, { menuOnly = false } = {}) {
  const token = `attachment-${crypto.randomUUID()}`;
  const found = await page.evaluate(({ marker, requireMenu }) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 4 &&
        rect.height > 4 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="menuitem"]'),
    ).filter(
      (element) =>
        visible(element) &&
        (!requireMenu ||
          element.getAttribute("role") === "menuitem" ||
          Boolean(element.closest('[role="menu"], [role="dialog"]'))),
    );
    for (const element of candidates) {
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("data-testid"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (
        /(?:add|attach|upload).*(?:photo|image|file)|(?:photo|image|file).*(?:add|attach|upload)/i.test(
          label,
        )
      ) {
        element.setAttribute("data-chatgpt-chrome-attachment", marker);
        return true;
      }
    }
    return false;
  }, { marker: token, requireMenu: menuOnly });
  return found
    ? page.locator(`[data-chatgpt-chrome-attachment="${token}"]`)
    : null;
}

async function setAttachmentFiles(page, attachments) {
  const paths = attachments.map((item) => item.uploadPath);
  const direct = await bestFileInput(page, attachments);
  if (direct) {
    await direct.locator.setInputFiles(paths);
    return "existing-file-input";
  }

  const trigger =
    (await firstVisible(page, ATTACHMENT_TRIGGER_SELECTORS)) ||
    (await markSemanticAttachmentAction(page)
      .then((locator) => (locator ? { locator } : null)));
  if (!trigger) {
    throw new Error(
      "ChatGPT's attachment control was not found. Run sync_chatgpt_options with force_rescan=true after a website UI change.",
    );
  }

  const triggerChooser = page
    .waitForEvent("filechooser", { timeout: 1_000 })
    .catch(() => null);
  await trigger.locator.click({ timeout: 5_000 });
  const immediateChooser = await triggerChooser;
  if (immediateChooser) {
    await immediateChooser.setFiles(paths);
    return "attachment-trigger-file-chooser";
  }

  const revealedInput = await waitForFileInput(page, attachments, 750);
  if (revealedInput) {
    await revealedInput.locator.setInputFiles(paths);
    return "revealed-file-input";
  }

  const menuAction =
    (await firstVisible(page, ATTACHMENT_MENU_SELECTORS)) ||
    (await markSemanticAttachmentAction(page, { menuOnly: true })
      .then((locator) => (locator ? { locator } : null)));
  if (!menuAction) {
    throw new Error(
      "ChatGPT opened its attachment menu, but the local file upload action was not found. No files were sent.",
    );
  }

  const menuChooser = page
    .waitForEvent("filechooser", { timeout: 5_000 })
    .catch(() => null);
  await menuAction.locator.click({ timeout: 5_000 });
  const chooser = await menuChooser;
  if (chooser) {
    await chooser.setFiles(paths);
    return "attachment-menu-file-chooser";
  }
  const lateInput = await waitForFileInput(page, attachments, 1_500);
  if (lateInput) {
    await lateInput.locator.setInputFiles(paths);
    return "attachment-menu-file-input";
  }
  throw new Error(
    "ChatGPT did not expose a usable file chooser after the attachment action. No files were sent.",
  );
}

async function attachmentUiState(page, attachments) {
  return page.evaluate(({ names, expectedCount }) => {
    const visible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const composer = document.querySelector(
      '#prompt-textarea, [data-testid="prompt-textarea"], textarea[name="prompt-textarea"], form [contenteditable="true"][role="textbox"]',
    );
    const root = composer?.closest("form") || composer?.parentElement || document.querySelector("main");
    const scoped = root || document;
    const candidateElements = Array.from(
      scoped.querySelectorAll(
        '[data-testid*="attachment" i], [data-testid*="upload" i], [data-testid*="file" i], [aria-label*="attachment" i], [aria-label*="file" i], img[alt]',
      ),
    ).filter(visible);
    const labels = candidateElements.map((element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("data-testid"),
        element.getAttribute("alt"),
        element.getAttribute("title"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 300),
    );
    const normalizedLabels = labels.join("\n").toLowerCase();
    const matchedNames = names.filter((name) => {
      const lowered = name.toLowerCase();
      const stem = lowered.replace(/\.[^.]+$/, "");
      return normalizedLabels.includes(lowered) || normalizedLabels.includes(stem);
    });
    const selectedInputFiles = Array.from(
      scoped.querySelectorAll('input[type="file"]'),
    ).reduce((sum, input) => sum + Number(input.files?.length || 0), 0);
    const activeElements = Array.from(
      scoped.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], [data-state="loading"], [data-state="uploading"], [data-status="uploading"], [data-testid*="upload-progress" i]',
      ),
    ).filter(visible);
    const activeText = Array.from(
      scoped.querySelectorAll('[role="status"], [aria-live], [data-status]'),
    )
      .filter(visible)
      .map((element) => element.textContent || "")
      .find((value) => /uploading|processing (?:file|image)|attaching/i.test(value));
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(visible)
      .map((element) => (element.textContent || "").trim())
      .filter(Boolean);
    const error = alerts.find((value) =>
      /upload|attachment|unsupported|file (?:is )?too (?:large|big)|could not (?:read|process)|failed/i.test(
        value,
      ),
    );
    return {
      expectedCount,
      selectedInputFiles,
      matchedNames,
      evidenceCount: candidateElements.length,
      active: activeElements.length > 0 || Boolean(activeText),
      activeSignal:
        activeText?.trim().replace(/\s+/g, " ").slice(0, 200) ||
        (activeElements.length ? "upload-progress-control" : null),
      error: error?.slice(0, 500) || null,
    };
  }, {
    names: attachments.map((item) => item.uploadName),
    expectedCount: attachments.length,
  });
}

async function waitForEnabledSend(page, attachments, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  do {
    const genericError = await visibleError(page);
    if (genericError) throw new Error(`ChatGPT reported an error: ${genericError}`);
    lastState = await attachmentUiState(page, attachments);
    if (lastState.error) {
      throw new Error(`ChatGPT rejected an attachment: ${lastState.error}`);
    }
    const send = await firstVisible(page, SEND_SELECTORS);
    if (send && (await send.locator.isEnabled()) && !lastState.active) {
      return { send, state: lastState };
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(
    `ChatGPT did not finish preparing ${attachments.length} attachment(s) for submission within ${Math.round(
      timeoutMs / 1000,
    )} seconds${lastState?.activeSignal ? ` (last signal: ${lastState.activeSignal})` : ""}. The bridge did not press Send and will not retry automatically.`,
  );
}

async function uploadAttachments(page, attachments) {
  if (!attachments.length) return null;
  const method = await setAttachmentFiles(page, attachments);
  await page.waitForTimeout(250);
  const state = await attachmentUiState(page, attachments);
  if (state.error) throw new Error(`ChatGPT rejected an attachment: ${state.error}`);
  return {
    requestedCount: attachments.length,
    uploadNames: attachments.map((item) => item.uploadName),
    method,
    initialUiEvidence: {
      selectedInputFiles: state.selectedInputFiles,
      matchedNames: state.matchedNames,
      evidenceCount: state.evidenceCount,
      uploadActive: state.active,
    },
  };
}

async function requestCandidateFile(page, candidate, outputDirectory) {
  if (!candidate.href || !/^https?:/i.test(candidate.href)) return null;
  const response = await page.context().request.get(candidate.href, {
    headers: { referer: page.url() },
    timeout: 45_000,
  });
  try {
    if (!response.ok()) {
      throw new Error(`authenticated download returned HTTP ${response.status()}`);
    }
    const headers = response.headers();
    const contentDisposition = headers["content-disposition"] || "";
    const contentType = headers["content-type"] || null;
    const contentLength = Number(headers["content-length"] || 0);
    if (contentLength > MAX_RESPONSE_FILE_BYTES) {
      throw new Error(
        `response file is ${contentLength} bytes, above the bridge's ${MAX_RESPONSE_FILE_BYTES}-byte limit`,
      );
    }
    const dispositionName = filenameFromContentDisposition(contentDisposition);
    const suggestedName = dispositionName || candidate.suggestedName;
    if (
      /^text\/html\b/i.test(contentType || "") &&
      !/\.html?$/i.test(suggestedName || "") &&
      !/\battachment\b/i.test(contentDisposition)
    ) {
      throw new Error("authenticated download returned an HTML page instead of the file");
    }
    const body = await response.body();
    return saveResponseBuffer(body, {
      outputDirectory,
      requestedName: suggestedName,
      mimeType: contentType,
      sourceUrl: candidate.href,
      discoveryMethod: "authenticated-browser-request",
    });
  } finally {
    await response.dispose().catch(() => {});
  }
}

async function clickCandidateFile(
  page,
  candidate,
  outputDirectory,
  { downloadTimeoutMs = 15_000 } = {},
) {
  const locator = page.locator(
    `[data-chatgpt-response-file="${candidate.marker}"]`,
  );
  if (!(await locator.count())) {
    throw new Error("the response file control disappeared before it could be downloaded");
  }
  const beforeUrl = page.url();
  const downloadPromise = page
    .waitForEvent("download", { timeout: Math.min(3_000, downloadTimeoutMs) })
    .catch(() => null);
  const popupPromise = page
    .waitForEvent("popup", { timeout: downloadTimeoutMs })
    .catch(() => null);
  await locator.click({ timeout: 8_000, noWaitAfter: true });
  const download = await downloadPromise;
  const popup = await Promise.race([
    popupPromise,
    page.waitForTimeout(50).then(() => null),
  ]);
  if (popup) await popup.close().catch(() => {});
  if (download) {
    return savePlaywrightDownload(download, {
      outputDirectory,
      requestedName: candidate.suggestedName,
      sourceUrl: candidate.href,
      discoveryMethod: "chatgpt-download-control",
    });
  }
  let previewDownloadControl = null;
  const previewSelectors = [
    'button[aria-label="Download" i]',
    'button[aria-label^="Download " i]',
    '[role="dialog"] [data-testid*="download" i]',
    '[role="dialog"] button[aria-label*="Download" i]',
    '[data-testid*="artifact" i] [data-testid*="download" i]',
    'main button[aria-label^="Download" i]',
    'main a[download]',
    'main button:has-text("Download")',
    'main [role="button"]:has-text("Download")',
  ];
  const previewStarted = Date.now();
  while (!previewDownloadControl && Date.now() - previewStarted < 5_000) {
    for (const selector of previewSelectors) {
      let controls;
      try {
        controls = page.locator(selector);
        const count = Math.min(await controls.count(), 10);
        for (let index = 0; index < count; index += 1) {
          const control = controls.nth(index);
          if (!(await control.isVisible())) continue;
          if (
            (await control.getAttribute("data-chatgpt-response-file")) ===
            candidate.marker
          ) {
            continue;
          }
          previewDownloadControl = control;
          break;
        }
      } catch {
        // Keep scanning semantic alternatives while an artifact preview hydrates.
      }
      if (previewDownloadControl) break;
    }
    if (!previewDownloadControl) await page.waitForTimeout(200);
  }
  if (previewDownloadControl) {
    const previewDownloadPromise = page
      .waitForEvent("download", { timeout: downloadTimeoutMs })
      .catch(() => null);
    await previewDownloadControl.click({ timeout: 8_000, noWaitAfter: true });
    const previewDownload = await previewDownloadPromise;
    if (previewDownload) {
      return savePlaywrightDownload(previewDownload, {
        outputDirectory,
        requestedName: candidate.suggestedName,
        sourceUrl: candidate.href,
        discoveryMethod: "chatgpt-artifact-preview-download",
      });
    }
  }
  if (page.url() !== beforeUrl) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(
      () => {},
    );
  }
  return null;
}

async function downloadResponseFileCandidate(
  page,
  candidate,
  outputDirectory,
  options,
) {
  const requestFirst =
    Boolean(candidate.href) &&
    /^https?:/i.test(candidate.href) &&
    candidate.kind === "a" &&
    !candidate.explicitDownload;
  const errors = [];
  if (requestFirst) {
    try {
      const requested = await requestCandidateFile(page, candidate, outputDirectory);
      if (requested) return requested;
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    const clicked = await clickCandidateFile(
      page,
      candidate,
      outputDirectory,
      options,
    );
    if (clicked) return clicked;
  } catch (error) {
    errors.push(error.message);
  }
  if (!requestFirst && candidate.href && /^https?:/i.test(candidate.href)) {
    try {
      const requested = await requestCandidateFile(page, candidate, outputDirectory);
      if (requested) return requested;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(
    errors.filter(Boolean).join("; ") ||
      "the response file control did not produce a downloadable file",
  );
}

export async function collectResponseFiles(
  page,
  {
    stateRoot,
    collectionId,
    outputDirectory,
    expected = false,
    scanWaitMs = expected ? 15_000 : 3_000,
    downloadTimeoutMs = 15_000,
  } = {},
) {
  const started = Date.now();
  let candidates = [];
  do {
    candidates = await discoverResponseFileCandidates(page);
    if (candidates.length || Date.now() - started >= scanWaitMs) break;
    await page.waitForTimeout(250);
  } while (true);

  if (!candidates.length && !expected) {
    return {
      status: "none",
      expected: false,
      detectedCount: 0,
      outputDirectory: null,
      manifestPath: null,
      files: [],
      errors: [],
      candidates: [],
      inspectionRecommended: false,
    };
  }

  const destination = await prepareResponseOutputDirectory({
    stateRoot,
    collectionId,
    outputDirectory,
  });
  const files = [];
  const errors = [];
  let totalBytes = 0;
  for (const candidate of candidates.slice(0, MAX_RESPONSE_FILES)) {
    try {
      const downloaded = await downloadResponseFileCandidate(
        page,
        candidate,
        destination,
        { downloadTimeoutMs },
      );
      if (totalBytes + downloaded.sizeBytes > MAX_RESPONSE_TOTAL_BYTES) {
        await fs.rm(downloaded.path, { force: true }).catch(() => {});
        throw new Error(
          `response files exceeded the bridge's ${MAX_RESPONSE_TOTAL_BYTES}-byte total limit`,
        );
      }
      totalBytes += downloaded.sizeBytes;
      files.push({
        ...downloaded,
        candidate: publicResponseFileCandidate(candidate),
      });
    } catch (error) {
      errors.push({
        candidate: publicResponseFileCandidate(candidate),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let status;
  if (files.length && !errors.length && files.length === candidates.length) {
    status = "downloaded";
  } else if (files.length) {
    status = "partial";
  } else if (candidates.length) {
    status = "failed";
  } else {
    status = "none_found";
  }
  let manifestPath = null;
  try {
    manifestPath = await writeResponseFileManifest(destination, {
      collectionId,
      conversationUrl: page.url(),
      files,
      errors,
      detectedCount: candidates.length,
      expected,
    });
  } catch (error) {
    errors.push({
      candidate: null,
      error: `Could not write response-file manifest: ${error.message}`,
    });
    if (status === "downloaded") status = "partial";
  }
  return {
    status,
    expected: Boolean(expected),
    detectedCount: candidates.length,
    outputDirectory: destination,
    manifestPath,
    totalBytes,
    files,
    errors,
    candidates: candidates.map(publicResponseFileCandidate),
    inspectionRecommended: ["partial", "failed", "none_found"].includes(status),
  };
}

export async function inspectConversationState(page) {
  const [
    messages,
    active,
    candidates,
    hints,
    interactiveHints,
    diagnostics,
    mainText,
  ] = await Promise.all([
    assistantMessages(page),
    activeResponseState(page),
    discoverResponseFileCandidates(page),
    responseFileUiHints(page),
    interactiveUiHints(page),
    uiDiagnostics(page),
    page.locator("main").innerText().catch(() => ""),
  ]);
  const latest = messages.at(-1) || null;
  return {
    url: page.url(),
    diagnostics,
    active,
    assistantMessageCount: messages.length,
    latestAssistant: latest
      ? {
          text: latest.text.slice(0, 40_000),
          terminal: latest.terminal,
          completionSignal: latest.signal,
          looksInterim: looksLikeProInterim(latest.text),
        }
      : null,
    responseFileCandidates: candidates.map(publicResponseFileCandidate),
    responseFileUiHints: hints,
    interactiveUiHints: interactiveHints,
    visibleMainText: mainText.trim().slice(0, 50_000),
  };
}

async function lastAuthoredConversationTurn(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const conversationRoot = document.querySelector("main") || document;
    const authored = Array.from(
      conversationRoot.querySelectorAll(
        '[data-message-author-role="user"], [data-message-author-role="assistant"], article[data-turn="user"], article[data-turn="assistant"]',
      ),
    ).filter(visible);
    const turns = [];
    const seen = new Set();
    for (const element of authored) {
      const turn =
        element.closest(
          '[data-testid^="conversation-turn-"], article[data-turn], section[data-turn]',
        ) || element;
      if (seen.has(turn)) continue;
      seen.add(turn);
      const role =
        element.getAttribute("data-message-author-role") ||
        turn.getAttribute("data-turn") ||
        null;
      if (!/^(?:user|assistant)$/.test(role || "")) continue;
      turns.push({
        role,
        text: (turn.innerText || turn.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 1_000),
      });
    }
    return turns.at(-1) || null;
  });
}

export async function conversationReplyState(page) {
  const [messages, active, lastTurn, composer] = await Promise.all([
    assistantMessages(page),
    activeResponseState(page),
    lastAuthoredConversationTurn(page),
    findComposer(page),
  ]);
  const latestAssistant = messages.at(-1) || null;
  const looksInterim = looksLikeProInterim(latestAssistant?.text || "");
  let reason = null;
  if (!composer) reason = "composer-not-found";
  else if (!latestAssistant) reason = "assistant-response-not-hydrated";
  else if (active.active) reason = "response-active";
  else if (looksInterim) reason = "latest-response-interim";
  else if (!latestAssistant.terminal) reason = "latest-response-not-terminal";
  else if (lastTurn?.role !== "assistant") reason = "latest-turn-not-assistant";
  return {
    ready: reason === null,
    reason,
    active,
    composerFound: Boolean(composer),
    assistantMessageCount: messages.length,
    latestAssistant: latestAssistant
      ? {
          text: latestAssistant.text.slice(0, 2_000),
          terminal: latestAssistant.terminal,
          completionSignal: latestAssistant.signal,
          looksInterim,
        }
      : null,
    lastTurn,
  };
}

export async function waitForConversationReplyReadiness(
  page,
  { timeoutMs = 20_000, quietMs = 1_000 } = {},
) {
  const startedAt = Date.now();
  let lastSignature = null;
  let lastChangedAt = startedAt;
  let state = null;
  while (Date.now() - startedAt < timeoutMs) {
    state = await conversationReplyState(page);
    const signature = JSON.stringify({
      reason: state.reason,
      active: state.active,
      assistantMessageCount: state.assistantMessageCount,
      latestAssistant: state.latestAssistant,
      lastTurn: state.lastTurn,
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChangedAt = Date.now();
    }
    const stableForMs = Date.now() - lastChangedAt;
    if (state.ready && stableForMs >= quietMs) {
      return {
        ...state,
        stableForMs,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await page.waitForTimeout(250);
  }
  return {
    ...(state || {
      ready: false,
      reason: "conversation-not-ready",
      active: { active: false, signal: null },
      composerFound: false,
      assistantMessageCount: 0,
      latestAssistant: null,
      lastTurn: null,
    }),
    stableForMs: Date.now() - lastChangedAt,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForConversationHydration(
  page,
  { timeoutMs = 15_000 } = {},
) {
  const started = Date.now();
  let assistantMessageCount = 0;
  let visibleMainText = "";
  while (Date.now() - started < timeoutMs) {
    const messages = await assistantMessages(page);
    assistantMessageCount = messages.length;
    visibleMainText = await page.locator("main").innerText().catch(() => "");
    if (
      assistantMessageCount ||
      /(?:you do not have access|conversation.*not found|unable to load)/i.test(
        visibleMainText,
      )
    ) {
      break;
    }
    await page.waitForTimeout(250);
  }
  return {
    hydrated: assistantMessageCount > 0,
    assistantMessageCount,
    elapsedMs: Date.now() - started,
    visibleMainText: visibleMainText.trim().slice(0, 2_000),
  };
}

export async function submitPrompt(
  page,
  prompt,
  { sendThrough = null, attachments = [] } = {},
) {
  const before = await assistantMessages(page);
  const beforeLast = before.at(-1)?.text || "";
  const attachmentUpload = await uploadAttachments(page, attachments);
  const composer = await setComposerText(page, prompt);
  let ready = null;
  if (attachments.length) {
    ready = await waitForEnabledSend(page, attachments);
    attachmentUpload.readyUiEvidence = ready.state;
  }
  const sendAction = async () => {
    if (attachments.length) {
      const current = await waitForEnabledSend(page, attachments, {
        timeoutMs: 30_000,
      });
      await current.send.locator.click();
      return "button";
    }
    const send = await firstVisible(page, SEND_SELECTORS);
    if (send && (await send.locator.isEnabled())) {
      await send.locator.click();
      return "button";
    }
    await composer.locator.press("Enter");
    return "keyboard";
  };
  let submission = null;
  if (typeof sendThrough === "function") {
    const sent = await sendThrough(sendAction);
    submission = sent?.pacing || null;
  } else {
    await sendAction();
  }
  return {
    beforeCount: before.length,
    beforeLast,
    submission,
    attachmentUpload,
  };
}

export async function waitForAssistantResponse(
  page,
  baseline,
  {
    timeoutMs = 300_000,
    longRunning = false,
    finalQuietMs = longRunning
      ? PRO_FINAL_QUIET_MS
      : STANDARD_FINAL_QUIET_MS,
    onProgress = null,
  } = {},
) {
  const started = Date.now();
  let sawGenerating = false;
  let previousObservation = null;
  let lastChangedAt = started;
  let previousProgress = null;
  let lastSnapshot = null;
  while (Date.now() - started < timeoutMs) {
    const error = await visibleError(page);
    if (error) throw new Error(`ChatGPT reported an error: ${error}`);

    const active = await activeResponseState(page);
    sawGenerating ||= active.active;
    const messages = await assistantMessages(page);
    const lastMessage = messages.at(-1) || null;
    const last = lastMessage?.text || "";
    const candidates = await discoverResponseFileCandidates(page);
    const isNew =
      messages.length > baseline.beforeCount ||
      (last && last !== baseline.beforeLast);
    const interim = looksLikeProInterim(last);
    const observation = JSON.stringify({
      messageCount: messages.length,
      last,
      terminal: Boolean(lastMessage?.terminal),
      completionSignal: lastMessage?.signal || null,
      active: active.active,
      activeSignal: active.signal,
      candidates: candidates.map((candidate) => candidate.suggestedName),
    });
    if (observation !== previousObservation) {
      previousObservation = observation;
      lastChangedAt = Date.now();
    }
    const stableForMs = Math.max(0, Date.now() - lastChangedAt);
    lastSnapshot = {
      assistantMessageCount: messages.length,
      preview: last.slice(0, 1_000),
      active: active.active,
      activeSignal: active.signal,
      terminalCandidate: Boolean(lastMessage?.terminal),
      completionSignal: lastMessage?.signal || null,
      looksInterim: interim,
      responseFileCandidateCount: candidates.length,
      responseFileCandidateNames: candidates.map(
        (candidate) => candidate.suggestedName,
      ),
      stableForMs,
      requiredFinalQuietMs: finalQuietMs,
      elapsedMs: Date.now() - started,
    };
    const progressSignature = JSON.stringify({
      assistantMessageCount: lastSnapshot.assistantMessageCount,
      preview: lastSnapshot.preview,
      active: lastSnapshot.active,
      activeSignal: lastSnapshot.activeSignal,
      terminalCandidate: lastSnapshot.terminalCandidate,
      completionSignal: lastSnapshot.completionSignal,
      looksInterim: lastSnapshot.looksInterim,
      responseFileCandidateNames: lastSnapshot.responseFileCandidateNames,
    });
    if (
      typeof onProgress === "function" &&
      progressSignature !== previousProgress
    ) {
      previousProgress = progressSignature;
      await onProgress(lastSnapshot);
    }
    if (isNew && last) {
      const quietEnough = stableForMs >= finalQuietMs;
      const interimBlocksCompletion = longRunning && interim;
      if (
        !active.active &&
        lastMessage.terminal &&
        quietEnough &&
        !interimBlocksCompletion
      ) {
        return {
          text: last,
          elapsedMs: Date.now() - started,
          completionSignal: lastMessage.signal,
          assistantMessageCount: messages.length,
          finalQuietMs,
          sawGenerating,
          responseFileCandidateCount: candidates.length,
        };
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for ChatGPT's response.${
      lastSnapshot?.activeSignal
        ? ` Last active signal: ${lastSnapshot.activeSignal}.`
        : ""
    }${
      lastSnapshot?.looksInterim
        ? " The latest assistant text still looked like an interim Pro update."
        : ""
    }`,
  );
}

export async function authenticationStatus(page) {
  const login = await firstVisible(page, [
    'a[href*="auth/login"]',
    'button:has-text("Log in")',
    'a:has-text("Log in")',
  ]);
  if (login) return { authenticated: false, reason: "login-control-visible" };
  const composer = await findComposer(page);
  if (composer) return { authenticated: true, reason: "composer-visible-without-login" };
  return {
    authenticated: false,
    reason: "composer-not-found",
  };
}

export async function waitForAuthenticationStatus(
  page,
  { timeoutMs = 15_000 } = {},
) {
  const started = Date.now();
  let status = await authenticationStatus(page);
  while (
    !status.authenticated &&
    status.reason === "composer-not-found" &&
    Date.now() - started < timeoutMs
  ) {
    await page.waitForTimeout(250);
    status = await authenticationStatus(page);
  }
  return status;
}

export async function uiDiagnostics(page) {
  const composer = await findComposer(page);
  const buttons = await page.locator("button:visible").allInnerTexts().catch(() => []);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    composerFound: Boolean(composer),
    visibleButtonLabels: buttons
      .map((value) => value.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .slice(0, 25),
  };
}
