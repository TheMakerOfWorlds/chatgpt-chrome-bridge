import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

import {
  discoverGrokOptions,
  grokAuthenticationStatus,
  inspectGrokConversationState,
  isAllowedGrokUrl,
  selectGrokModel,
  submitGrokPrompt,
  waitForGrokResponse,
} from "../lib/grok-ui-adapter.mjs";

const chromeExecutable =
  process.env.GROK_CHROME_EXECUTABLE ||
  process.env.CHATGPT_CHROME_EXECUTABLE ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const fixtureHtml = `<!doctype html>
<html>
  <body>
    <main>
      <button aria-label="Model select">Fast</button>
      <div id="model-menu" role="menu" hidden>
        <button role="menuitem"><span class="font-semibold">Fast</span><span>Quick responses</span></button>
        <button role="menuitem"><span class="font-semibold">Auto</span><span>Chooses Fast or Expert</span></button>
        <button role="menuitem"><span class="font-semibold">Expert</span><span>Thinks hard</span></button>
        <button role="menuitem"><span class="font-semibold">Heavy</span><span>Team of Experts</span></button>
        <button role="menuitem"><span class="font-semibold">Unlock more</span></button>
      </div>
      <section id="messages">
        <div data-testid="user-message">
          <div class="response-content-markdown">Existing user text is not an assistant response.</div>
        </div>
      </section>
      <form onsubmit="return false">
        <div role="textbox" contenteditable="true" aria-label="Ask Grok anything"></div>
        <button data-testid="chat-submit" aria-label="Submit" type="button">Submit</button>
      </form>
    </main>
    <script>
      const menu = document.querySelector('#model-menu');
      const modelButton = document.querySelector('[aria-label="Model select"]');
      modelButton.onclick = () => { menu.hidden = false; };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') menu.hidden = true;
      });
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        item.onclick = () => {
          document.body.dataset.selected = item.querySelector('.font-semibold').textContent;
          menu.hidden = true;
        };
      }
      const submit = document.querySelector('[data-testid="chat-submit"]');
      submit.onclick = () => {
        submit.disabled = true;
        const stop = document.createElement('button');
        stop.setAttribute('aria-label', 'Stop generating');
        stop.textContent = 'Stop';
        document.body.append(stop);
        const response = document.createElement('article');
        response.dataset.messageAuthorRole = 'assistant';
        response.dataset.testid = 'assistant-message';
        response.textContent = 'I am writing this now…';
        document.querySelector('#messages').append(response);
        setTimeout(() => {
          response.textContent = 'Natural final fixture response.';
          const actions = document.createElement('div');
          actions.className = 'action-buttons last-response';
          const copy = document.createElement('button');
          copy.setAttribute('aria-label', 'Copy');
          actions.append(copy);
          response.append(actions);
          stop.remove();
          submit.disabled = false;
        }, 350);
      };
    </script>
  </body>
</html>`;

test("discovers Grok models, selects Expert, and rejects other origins", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(fixtureHtml);

  assert.equal(isAllowedGrokUrl("https://grok.com/project/example"), true);
  assert.equal(isAllowedGrokUrl("https://not-grok.example/"), false);
  assert.equal((await grokAuthenticationStatus(page)).authenticated, true);
  const options = await discoverGrokOptions(page);
  assert.deepEqual(options.modelOptions, ["Fast", "Auto", "Expert", "Heavy"]);
  const selected = await selectGrokModel(page, "Expert");
  assert.equal(selected.selected, "Expert");
  assert.equal(await page.locator("body").getAttribute("data-selected"), "Expert");
});

test("does not accept a partial Grok response while active signals remain", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(fixtureHtml);
  const baseline = await submitGrokPrompt(page, "Rewrite this naturally.");
  assert.equal(baseline.baselineCount, 0);
  const response = await waitForGrokResponse(page, baseline, {
    timeoutMs: 8_000,
  });
  assert.equal(response.text, "Natural final fixture response.");
  assert.equal(response.completionSignal, "last-response-actions");
  assert.ok(response.elapsedMs >= 2_000);
  const inspection = await inspectGrokConversationState(page);
  assert.equal(inspection.active, false);
  assert.equal(inspection.latestAssistantText, "Natural final fixture response.");
  assert.equal(inspection.terminalActionSignal, "last-response-actions");
});

test("uploads exact files before the single globally paced Grok submit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-upload-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "one.txt");
  const second = path.join(root, "two.txt");
  await fs.writeFile(first, "one");
  await fs.writeFile(second, "two");

  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section id="messages"></section>
      <form onsubmit="return false">
        <input type="file" multiple hidden>
        <div id="chips"></div>
        <textarea aria-label="Ask Grok anything"></textarea>
        <button data-testid="chat-submit" type="button" disabled>Submit</button>
      </form>
    </main>
    <script>
      const input = document.querySelector('input[type=file]');
      const composer = document.querySelector('textarea');
      const submit = document.querySelector('[data-testid="chat-submit"]');
      let uploaded = false;
      const update = () => { submit.disabled = !(uploaded && composer.value.trim()); };
      composer.addEventListener('input', update);
      input.addEventListener('change', () => {
        const progress = document.createElement('div');
        progress.setAttribute('role', 'progressbar');
        document.body.append(progress);
        setTimeout(() => {
          for (const file of input.files) {
            const chip = document.createElement('div');
            chip.textContent = file.name;
            document.querySelector('#chips').append(chip);
          }
          progress.remove();
          uploaded = true;
          update();
        }, 250);
      });
      submit.addEventListener('click', () => {
        document.body.dataset.sendCount = String(Number(document.body.dataset.sendCount || 0) + 1);
      });
    </script>
  `);
  let gateCalls = 0;
  const baseline = await submitGrokPrompt(page, "Use both files.", {
    attachments: [
      { uploadPath: first, uploadName: "one.txt" },
      { uploadPath: second, uploadName: "two.txt" },
    ],
    sendThrough: async (sendAction) => {
      gateCalls += 1;
      assert.equal(await page.locator('[role="progressbar"]').count(), 0);
      return {
        result: await sendAction(),
        pacing: { intervalSeconds: 5, submittedAt: "fixture" },
      };
    },
  });
  assert.equal(gateCalls, 1);
  assert.equal(await page.locator("body").getAttribute("data-send-count"), "1");
  assert.deepEqual(baseline.attachmentUpload.readyUiEvidence.matchedNames, [
    "one.txt",
    "two.txt",
  ]);
  assert.equal(baseline.submission.intervalSeconds, 5);
});
