import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

import {
  authenticationStatus,
  collectResponseFiles,
  conversationReplyState,
  discoverResponseFileCandidates,
  discoverAvailableOptions,
  inspectConversationState,
  isAllowedChatGptUrl,
  selectPreference,
  submitPrompt,
  waitForAuthenticationStatus,
  waitForAssistantResponse,
  waitForConversationReplyReadiness,
} from "../lib/ui-adapter.mjs";

const chromeExecutable =
  process.env.CHATGPT_CHROME_EXECUTABLE ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const fixtureHtml = `<!doctype html>
<html>
  <body>
    <main>
      <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">GPT-5 Auto</button>
      <div id="model-menu" role="menu" hidden>
        <button role="menuitemradio">GPT-5 Auto</button>
        <button role="menuitemradio">GPT-5 Thinking</button>
        <button role="menuitemradio">GPT-5 Pro</button>
      </div>
      <button data-testid="reasoning-effort" aria-haspopup="menu">Reasoning</button>
      <div id="reasoning-menu" role="menu" hidden>
        <button role="menuitemradio">Low</button>
        <button role="menuitemradio">High</button>
        <button role="menuitemradio">Extra high</button>
      </div>
      <section id="messages"></section>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Message ChatGPT"></div>
        <button data-testid="send-button" type="button">Send</button>
      </form>
    </main>
    <script>
      const modelButton = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      const reasoningButton = document.querySelector('[data-testid="reasoning-effort"]');
      const modelMenu = document.querySelector('#model-menu');
      const reasoningMenu = document.querySelector('#reasoning-menu');
      modelButton.onclick = () => { modelMenu.hidden = false; };
      reasoningButton.onclick = () => { reasoningMenu.hidden = false; };
      for (const item of document.querySelectorAll('[role="menuitemradio"]')) {
        item.onclick = () => {
          document.body.dataset.selected = item.textContent.trim();
          item.closest('[role="menu"]').hidden = true;
        };
      }
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          modelMenu.hidden = true;
          reasoningMenu.hidden = true;
        }
      });
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop';
        document.body.append(stop);
        setTimeout(() => {
          const answer = document.createElement('article');
          answer.dataset.messageAuthorRole = 'assistant';
          answer.textContent = 'Fixture response complete.';
          const turn = document.createElement('section');
          turn.dataset.testid = 'conversation-turn-1';
          turn.dataset.turn = 'assistant';
          const copy = document.createElement('button');
          copy.dataset.testid = 'copy-turn-action-button';
          copy.setAttribute('aria-label', 'Copy response');
          turn.append(answer, copy);
          document.querySelector('#messages').append(turn);
          stop.remove();
        }, 350);
      };
    </script>
  </body>
</html>`;

test("discovers changing model/reasoning labels and waits for a response", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(fixtureHtml);

  const auth = await authenticationStatus(page);
  assert.equal(auth.authenticated, true);
  const options = await discoverAvailableOptions(page);
  assert.deepEqual(options.modelOptions, [
    "GPT-5 Auto",
    "GPT-5 Thinking",
    "GPT-5 Pro",
  ]);
  assert.ok(options.reasoningOptions.includes("Extra high"));

  const selection = await selectPreference(page, "reasoning", "xhigh");
  assert.equal(selection.selected, "Extra high");
  assert.equal(await page.locator("body").getAttribute("data-selected"), "Extra high");

  let gateCalls = 0;
  const baseline = await submitPrompt(page, "Test prompt", {
    sendThrough: async (sendAction) => {
      gateCalls += 1;
      assert.equal(await page.locator('[data-testid="stop-button"]').count(), 0);
      const result = await sendAction();
      return {
        result,
        pacing: { intervalSeconds: 5, submittedAt: "test-time" },
      };
    },
  });
  assert.equal(gateCalls, 1);
  assert.deepEqual(baseline.submission, {
    intervalSeconds: 5,
    submittedAt: "test-time",
  });
  const response = await waitForAssistantResponse(page, baseline, {
    timeoutMs: 8_000,
  });
  assert.equal(response.text, "Fixture response complete.");
  assert.equal(response.completionSignal, "copy-turn-action-button");
});

test("requires a stable completed assistant turn before allowing a conversation reply", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section id="messages">
        <section data-testid="conversation-turn-user-1" data-turn="user">
          <article data-message-author-role="user">Initial question</article>
        </section>
        <section data-testid="conversation-turn-assistant-1" data-turn="assistant">
          <article data-message-author-role="assistant">Completed answer</article>
          <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>
        </section>
      </section>
      <form><div id="prompt-textarea" role="textbox" contenteditable="true"></div></form>
    </main>
  `);

  const ready = await waitForConversationReplyReadiness(page, {
    timeoutMs: 2_000,
    quietMs: 100,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.lastTurn.role, "assistant");
  assert.equal(ready.latestAssistant.terminal, true);

  await page.locator("#messages").evaluate((messages) => {
    const userTurn = document.createElement("section");
    userTurn.dataset.testid = "conversation-turn-user-2";
    userTurn.dataset.turn = "user";
    const message = document.createElement("article");
    message.dataset.messageAuthorRole = "user";
    message.textContent = "An unanswered external follow-up";
    userTurn.append(message);
    messages.append(userTurn);
  });
  let blocked = await conversationReplyState(page);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, "latest-turn-not-assistant");

  await page
    .locator('[data-testid="conversation-turn-user-2"]')
    .evaluate((element) => element.remove());
  await page.locator("main").evaluate((main) => {
    const stop = document.createElement("button");
    stop.dataset.testid = "stop-button";
    stop.textContent = "Stop";
    main.append(stop);
  });
  blocked = await conversationReplyState(page);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, "response-active");
});

test("uploads multiple exact files, waits for preparation, and then sends once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-ui-upload-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "chair-one.jpg");
  const second = path.join(root, "chair-two.jpg");
  await fs.writeFile(first, "first-image");
  await fs.writeFile(second, "second-image");

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
        <input id="attachment-input" type="file" multiple hidden>
        <div id="chips"></div>
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button data-testid="send-button" type="button" disabled>Send</button>
      </form>
    </main>
    <script>
      const input = document.querySelector('#attachment-input');
      const composer = document.querySelector('#prompt-textarea');
      const send = document.querySelector('[data-testid="send-button"]');
      let uploadReady = false;
      const updateSend = () => {
        send.disabled = !(uploadReady && composer.textContent.trim());
      };
      composer.addEventListener('input', updateSend);
      input.addEventListener('change', () => {
        document.body.dataset.changeCount = String(
          Number(document.body.dataset.changeCount || 0) + 1
        );
        const progress = document.createElement('div');
        progress.setAttribute('role', 'progressbar');
        progress.textContent = 'Uploading';
        document.querySelector('form').append(progress);
        setTimeout(() => {
          for (const file of input.files) {
            const chip = document.createElement('div');
            chip.dataset.testid = 'attachment-chip';
            chip.textContent = file.name;
            document.querySelector('#chips').append(chip);
          }
          progress.remove();
          uploadReady = true;
          updateSend();
        }, 450);
      });
      send.addEventListener('click', () => {
        document.body.dataset.sendCount = String(
          Number(document.body.dataset.sendCount || 0) + 1
        );
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop';
        document.body.append(stop);
        setTimeout(() => {
          const turn = document.createElement('section');
          turn.dataset.testid = 'conversation-turn-upload';
          turn.dataset.turn = 'assistant';
          const answer = document.createElement('article');
          answer.dataset.messageAuthorRole = 'assistant';
          answer.textContent = 'I received both chair photos.';
          const copy = document.createElement('button');
          copy.dataset.testid = 'copy-turn-action-button';
          copy.setAttribute('aria-label', 'Copy response');
          turn.append(answer, copy);
          document.querySelector('#messages').append(turn);
          stop.remove();
        }, 250);
      });
    </script>
  `);

  let gateCalls = 0;
  const baseline = await submitPrompt(page, "Confirm the chair is visible.", {
    attachments: [
      {
        uploadPath: first,
        uploadName: "chair-one.jpg",
        category: "image",
      },
      {
        uploadPath: second,
        uploadName: "chair-two.jpg",
        category: "image",
      },
    ],
    sendThrough: async (sendAction) => {
      gateCalls += 1;
      assert.equal(await page.locator('[role="progressbar"]').count(), 0);
      return { result: await sendAction(), pacing: { submittedAt: "now" } };
    },
  });

  assert.equal(gateCalls, 1);
  assert.equal(await page.locator("body").getAttribute("data-change-count"), "1");
  assert.equal(await page.locator("body").getAttribute("data-send-count"), "1");
  assert.equal(baseline.attachmentUpload.requestedCount, 2);
  assert.equal(baseline.attachmentUpload.method, "existing-file-input");
  assert.deepEqual(baseline.attachmentUpload.readyUiEvidence.matchedNames, [
    "chair-one.jpg",
    "chair-two.jpg",
  ]);
  const response = await waitForAssistantResponse(page, baseline, {
    timeoutMs: 5_000,
  });
  assert.equal(response.text, "I received both chair photos.");
  assert.equal(response.completionSignal, "copy-turn-action-button");
});

test("does not treat a stable partial Pro update as complete", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section id="messages"></section>
      <button data-testid="stop-button">Stop</button>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
      </form>
    </main>
    <script>
      setTimeout(() => {
        document.querySelector('[data-testid="stop-button"]').remove();
        const answer = document.createElement('article');
        answer.dataset.messageAuthorRole = 'assistant';
        answer.append(document.createTextNode('I am still working on the full result.'));
        const copy = document.createElement('button');
        copy.dataset.testid = 'copy-turn-action-button';
        copy.setAttribute('aria-label', 'Copy response');
        answer.append(copy);
        const progress = document.createElement('div');
        progress.setAttribute('role', 'status');
        progress.textContent = 'Still working on this research';
        answer.append(progress);
        document.querySelector('#messages').append(answer);
      }, 100);
      setTimeout(() => {
        const answer = document.querySelector('[data-message-author-role="assistant"]');
        answer.firstChild.textContent = 'The complete final result.';
        answer.querySelector('[role="status"]').remove();
      }, 2800);
    </script>
  `);

  const response = await waitForAssistantResponse(
    page,
    { beforeCount: 0, beforeLast: "" },
    { timeoutMs: 7_000 },
  );

  assert.equal(response.text, "The complete final result.");
  assert.equal(response.completionSignal, "copy-turn-action-button");
  assert.ok(response.elapsedMs >= 2800);
});

test("downloads generated response files and exposes them to conversation inspection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-ui-response-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
    acceptDownloads: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section data-testid="conversation-turn-file" data-turn="assistant">
        <article data-message-author-role="assistant">The requested document is ready.</article>
        <a
          data-testid="artifact-download"
          download="bridge-report.csv"
          href="data:text/csv;charset=utf-8,item%2Cstatus%0Afile_retrieval%2Cpassed%0A"
        >Download bridge-report.csv</a>
        <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>
      </section>
      <form><div id="prompt-textarea" role="textbox" contenteditable="true"></div></form>
    </main>
  `);

  const candidates = await discoverResponseFileCandidates(page);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedName, "bridge-report.csv");

  const collected = await collectResponseFiles(page, {
    stateRoot: root,
    collectionId: "fixture-file-job",
    expected: true,
    scanWaitMs: 500,
    downloadTimeoutMs: 3_000,
  });
  assert.equal(collected.status, "downloaded");
  assert.equal(collected.files.length, 1);
  assert.equal(collected.files[0].name, "bridge-report.csv");
  assert.equal(collected.files[0].mimeType, "text/csv");
  assert.equal(
    await fs.readFile(collected.files[0].path, "utf8"),
    "item,status\nfile_retrieval,passed\n",
  );
  assert.equal(collected.files[0].sha256.length, 64);
  assert.ok(collected.manifestPath.startsWith(collected.outputDirectory));

  const inspection = await inspectConversationState(page);
  assert.equal(inspection.latestAssistant.terminal, true);
  assert.equal(inspection.latestAssistant.looksInterim, false);
  assert.equal(inspection.responseFileCandidates.length, 1);
  assert.match(inspection.visibleMainText, /requested document is ready/i);
});

test("opens a filename-only generated-file card and downloads from its hydrated preview", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-ui-artifact-card-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section data-testid="conversation-turn-card" data-turn="assistant">
        <article data-message-author-role="assistant">
          <p>Your generated workbook is ready.</p>
          <div class="generated-file-card" role="button" tabindex="0">bridge-workbook.xlsx</div>
        </article>
        <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>
      </section>
      <form><div id="prompt-textarea" role="textbox" contenteditable="true"></div></form>
    </main>
    <script>
      document.querySelector('.generated-file-card').onclick = () => {
        const dialog = document.createElement('section');
        dialog.id = 'artifact-preview';
        const download = document.createElement('button');
        download.setAttribute('aria-label', 'Download');
        download.onclick = () => {
          const blob = new Blob(['fixture workbook bytes'], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          });
          const anchor = document.createElement('a');
          anchor.href = URL.createObjectURL(blob);
          anchor.download = 'bridge-workbook.xlsx';
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        };
        dialog.append(download);
        document.body.append(dialog);
      };
    </script>
  `);

  const candidates = await discoverResponseFileCandidates(page);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedName, "bridge-workbook.xlsx");
  assert.equal(candidates[0].directlyInteractive, true);
  const collected = await collectResponseFiles(page, {
    stateRoot: root,
    collectionId: "file-card-job",
    expected: true,
    scanWaitMs: 500,
    downloadTimeoutMs: 5_000,
  });
  assert.equal(collected.status, "downloaded");
  assert.equal(collected.files[0].name, "bridge-workbook.xlsx");
  assert.equal(
    collected.files[0].discoveryMethod,
    "chatgpt-artifact-preview-download",
  );
  assert.equal(
    await fs.readFile(collected.files[0].path, "utf8"),
    "fixture workbook bytes",
  );
});

test("keeps Pro interim cards nonterminal through progress flicker and returns the large final artifact turn", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section id="messages"></section>
      <button data-testid="stop-button">Stop</button>
      <form><div id="prompt-textarea" role="textbox" contenteditable="true"></div></form>
    </main>
    <script>
      const messages = document.querySelector('#messages');
      setTimeout(() => {
        document.querySelector('[data-testid="stop-button"]').remove();
        const turn = document.createElement('section');
        turn.dataset.testid = 'conversation-turn-pro';
        turn.dataset.turn = 'assistant';
        const answer = document.createElement('article');
        answer.dataset.messageAuthorRole = 'assistant';
        answer.textContent = 'I am still researching the complete result.';
        const copy = document.createElement('button');
        copy.dataset.testid = 'copy-turn-action-button';
        copy.setAttribute('aria-label', 'Copy response');
        turn.append(answer, copy);
        messages.append(turn);
      }, 100);
      setTimeout(() => {
        document.querySelector('[data-message-author-role="assistant"]').textContent =
          'Progress update: I am currently analyzing the remaining sources.';
      }, 650);
      setTimeout(() => {
        const status = document.createElement('div');
        status.id = 'research-status';
        status.setAttribute('role', 'status');
        status.textContent = 'Research in progress';
        document.querySelector('[data-testid="conversation-turn-pro"]').append(status);
      }, 950);
      setTimeout(() => {
        document.querySelector('#research-status').remove();
      }, 1250);
      setTimeout(() => {
        const answer = document.querySelector('[data-message-author-role="assistant"]');
        answer.textContent =
          'Complete final analysis. This deliberately represents the larger final Pro response after the small progress cards.';
        const link = document.createElement('a');
        link.dataset.testid = 'artifact-download';
        link.download = 'pro-final.csv';
        link.href = 'data:text/csv,stage%2Cstatus%0Afinal%2Cpassed%0A';
        link.textContent = 'Download pro-final.csv';
        document.querySelector('[data-testid="conversation-turn-pro"]').append(link);
      }, 1700);
    </script>
  `);

  const progress = [];
  const response = await waitForAssistantResponse(
    page,
    { beforeCount: 0, beforeLast: "" },
    {
      timeoutMs: 6_000,
      longRunning: true,
      finalQuietMs: 700,
      onProgress: (snapshot) => progress.push(snapshot),
    },
  );

  assert.match(response.text, /^Complete final analysis/);
  assert.equal(response.completionSignal, "copy-turn-action-button");
  assert.equal(response.responseFileCandidateCount, 1);
  assert.equal(response.finalQuietMs, 700);
  assert.ok(response.elapsedMs >= 2_400);
  assert.ok(progress.some((snapshot) => snapshot.looksInterim));
  assert.ok(progress.some((snapshot) => snapshot.active));
  assert.ok(
    progress.some((snapshot) =>
      snapshot.responseFileCandidateNames.includes("pro-final.csv"),
    ),
  );
});

test("prefers the composer intelligence menu over attachment and sidebar controls", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <aside>
      <a data-sidebar-item href="/c/example">Tesla Model Y Range</a>
      <button
        data-trailing-button
        data-conversation-options-trigger="example"
        aria-haspopup="menu"
        aria-label="Open conversation options for Tesla Model Y Range"
      >Options</button>
    </aside>
    <main>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button id="attachment-trigger" data-testid="composer-plus-btn" type="button" aria-haspopup="menu" aria-label="Add files and more"></button>
        <button id="intelligence-trigger" type="button" aria-haspopup="menu" aria-expanded="false">Extra High</button>
      </form>
      <div id="attachment-menu" role="menu" hidden>
        <div role="menuitem">Add photos &amp; files</div>
      </div>
      <div id="intelligence-menu" role="menu" hidden>
        <div role="menuitemradio">Instant <span>5.5</span></div>
        <div role="menuitemradio">Medium</div>
        <div role="menuitemradio">High</div>
        <div role="menuitemradio" aria-checked="true">Extra High</div>
        <div role="menuitemradio">Pro</div>
        <div role="menuitem">GPT-5.6 Sol</div>
      </div>
    </main>
    <script>
      const trigger = document.querySelector('#intelligence-trigger');
      const menu = document.querySelector('#intelligence-menu');
      trigger.onclick = () => {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    </script>
  `);

  const options = await discoverAvailableOptions(page);
  assert.deepEqual(options.modelOptions, [
    "Instant 5.5",
    "Medium",
    "High",
    "Extra High",
    "Pro",
    "GPT-5.6 Sol",
  ]);
  assert.deepEqual(options.reasoningOptions, [
    "Instant 5.5",
    "Medium",
    "High",
    "Extra High",
    "Pro",
  ]);
  assert.equal(options.signatures.modelTrigger.text, "Extra High");
});

test("discovers and selects the redesigned thinking-effort Power slider", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button data-testid="composer-plus-btn" type="button" aria-haspopup="menu" aria-label="Add files and more"></button>
        <button id="intelligence-trigger" type="button" aria-haspopup="menu" aria-expanded="false">Extra High</button>
      </form>
      <div id="intelligence-menu" role="menu" hidden>
        <div role="group" data-testid="composer-intelligence-picker-content">
          <div data-testid="composer-model-picker-slider-simple-view" data-active="true">
            <div
              id="power"
              role="menuitem"
              tabindex="0"
              aria-label="Power"
              aria-keyshortcuts="ArrowLeft ArrowRight"
              aria-describedby="power-value power-help"
            ></div>
            <span id="power-value">Extra High, 4 of 5.</span>
            <span id="power-help">Use Left and Right arrow keys to adjust power.</span>
          </div>
          <div
            id="select-model"
            role="menuitem"
            aria-label="Select model"
            aria-expanded="false"
          >Extra High</div>
          <div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div>
          <div role="menuitemradio" aria-checked="false">GPT-5.5</div>
        </div>
      </div>
    </main>
    <script>
      const labels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
      let position = 4;
      const trigger = document.querySelector('#intelligence-trigger');
      const menu = document.querySelector('#intelligence-menu');
      const power = document.querySelector('#power');
      const powerValue = document.querySelector('#power-value');
      const selectModel = document.querySelector('#select-model');
      const update = () => {
        const label = labels[position - 1];
        powerValue.textContent = label + ', ' + position + ' of ' + labels.length + '.';
        trigger.textContent = label;
        selectModel.textContent = label;
        document.body.dataset.selectedEffort = label;
      };
      trigger.onclick = () => {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      };
      power.onkeydown = (event) => {
        if (event.key === 'ArrowLeft') position = Math.max(1, position - 1);
        if (event.key === 'ArrowRight') position = Math.min(labels.length, position + 1);
        update();
      };
      selectModel.onclick = () => {
        document.body.dataset.selectModelClicks = String(
          Number(document.body.dataset.selectModelClicks || 0) + 1
        );
      };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
      update();
    </script>
  `);

  const options = await discoverAvailableOptions(page, {}, {
    includeModels: false,
  });
  assert.deepEqual(options.reasoningOptions, [
    "Instant",
    "Medium",
    "High",
    "Extra High",
    "Pro",
  ]);
  assert.equal(
    await page.locator("body").getAttribute("data-selected-effort"),
    "Extra High",
  );
  assert.equal(
    await page.locator("body").getAttribute("data-select-model-clicks"),
    null,
  );

  const selection = await selectPreference(page, "reasoning", "pro");
  assert.equal(selection.selected, "Pro");
  assert.equal(selection.fallback, false);
  assert.equal(
    await page.locator("body").getAttribute("data-selected-effort"),
    "Pro",
  );
  assert.equal(
    await page.locator("body").getAttribute("data-select-model-clicks"),
    null,
  );
});

test("expands Advanced and exposes only leaf Effort options when requested", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button id="intelligence-trigger" type="button" aria-haspopup="menu" aria-expanded="false">Extra High</button>
      </form>
      <div id="intelligence-menu" role="menu" hidden>
        <div id="power" role="menuitem" aria-label="Power"></div>
        <div id="advanced" role="menuitem" aria-label="Show advanced options" aria-expanded="false">Advanced</div>
        <div id="advanced-options" hidden>
          <div id="model-trigger" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-state="closed">Model GPT-5.6 Sol</div>
          <div id="effort-trigger" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-state="closed">Effort Extra High</div>
        </div>
      </div>
      <div id="model-menu" role="menu" hidden>
        <div role="menuitemradio" aria-checked="true" data-state="checked">GPT-5.6 Sol</div>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">GPT-5.5</div>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">o3</div>
      </div>
      <div id="effort-menu" role="menu" hidden>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">Instant</div>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">Medium</div>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">High</div>
        <div role="menuitemradio" aria-checked="true" data-state="checked">Extra High</div>
        <div role="menuitemradio" aria-checked="false" data-state="unchecked">Pro</div>
      </div>
    </main>
    <script>
      const intelligence = document.querySelector('#intelligence-trigger');
      const root = document.querySelector('#intelligence-menu');
      const advanced = document.querySelector('#advanced');
      const advancedOptions = document.querySelector('#advanced-options');
      const modelTrigger = document.querySelector('#model-trigger');
      const effortTrigger = document.querySelector('#effort-trigger');
      const modelMenu = document.querySelector('#model-menu');
      const effortMenu = document.querySelector('#effort-menu');
      const closeAll = () => {
        root.hidden = true;
        modelMenu.hidden = true;
        effortMenu.hidden = true;
        advancedOptions.hidden = true;
        advanced.setAttribute('aria-label', 'Show advanced options');
        advanced.setAttribute('aria-expanded', 'false');
        modelTrigger.setAttribute('aria-expanded', 'false');
        modelTrigger.dataset.state = 'closed';
        effortTrigger.setAttribute('aria-expanded', 'false');
        effortTrigger.dataset.state = 'closed';
        intelligence.setAttribute('aria-expanded', 'false');
      };
      intelligence.onclick = () => {
        root.hidden = false;
        intelligence.setAttribute('aria-expanded', 'true');
        if (document.body.dataset.preexpanded === 'true') {
          advancedOptions.hidden = false;
          advanced.setAttribute('aria-label', 'Show compact options');
          advanced.setAttribute('aria-expanded', 'true');
        }
      };
      advanced.onclick = () => {
        document.body.dataset.advancedClicks = String(Number(document.body.dataset.advancedClicks || 0) + 1);
        advancedOptions.hidden = false;
        advanced.setAttribute('aria-label', 'Show compact options');
        advanced.setAttribute('aria-expanded', 'true');
      };
      modelTrigger.onclick = () => {
        modelMenu.hidden = false;
        modelTrigger.setAttribute('aria-expanded', 'true');
        modelTrigger.dataset.state = 'open';
      };
      effortTrigger.onclick = () => {
        effortMenu.hidden = false;
        effortTrigger.setAttribute('aria-expanded', 'true');
        effortTrigger.dataset.state = 'open';
      };
      for (const option of modelMenu.querySelectorAll('[role="menuitemradio"]')) {
        option.onclick = () => {
          document.body.dataset.selectedModel = option.textContent.trim();
          closeAll();
        };
      }
      for (const option of effortMenu.querySelectorAll('[role="menuitemradio"]')) {
        option.onclick = () => {
          document.body.dataset.selectedEffort = option.textContent.trim();
          intelligence.textContent = option.textContent.trim();
          closeAll();
        };
      }
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeAll();
      });
    </script>
  `);

  const options = await discoverAvailableOptions(page, {}, {
    includeModels: false,
  });
  assert.deepEqual(options.modelOptions, []);
  assert.deepEqual(options.reasoningOptions, [
    "Instant",
    "Medium",
    "High",
    "Extra High",
    "Pro",
  ]);
  assert.equal(
    await page.locator("body").getAttribute("data-advanced-clicks"),
    "1",
  );

  await page.locator("body").evaluate((element) => {
    element.dataset.preexpanded = "true";
  });
  const effort = await selectPreference(page, "reasoning", "pro");
  assert.equal(effort.selected, "Pro");
  assert.equal(
    await page.locator("body").getAttribute("data-selected-effort"),
    "Pro",
  );

  assert.equal(
    await page.locator("body").getAttribute("data-advanced-clicks"),
    "1",
  );
});

test("waits for a hydrated intelligence menu instead of choosing disabled Send", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <form onsubmit="return false">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button id="send" type="submit" aria-label="Send prompt" disabled>Send</button>
      </form>
      <div id="menu-root"></div>
    </main>
    <script>
      setTimeout(() => {
        const form = document.querySelector('form');
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.textContent = 'Instant 5.5';
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        for (const label of ['Instant 5.5', 'Extra High']) {
          const option = document.createElement('button');
          option.type = 'button';
          option.setAttribute('role', 'menuitemradio');
          option.textContent = label;
          option.onclick = () => {
            document.body.dataset.selected = label;
            menu.hidden = true;
          };
          menu.append(option);
        }
        trigger.onclick = () => { menu.hidden = false; };
        form.prepend(trigger);
        document.querySelector('#menu-root').append(menu);
      }, 650);
    </script>
  `);

  const selection = await selectPreference(page, "reasoning", "xhigh");
  assert.equal(selection.selected, "Extra High");
  assert.equal(await page.locator("body").getAttribute("data-selected"), "Extra High");
});

test("allows only ChatGPT and OpenAI top-level destinations", () => {
  assert.equal(isAllowedChatGptUrl("https://chatgpt.com/c/123"), true);
  assert.equal(isAllowedChatGptUrl("https://auth.openai.com/login"), true);
  assert.equal(isAllowedChatGptUrl("https://example.com/"), false);
  assert.equal(isAllowedChatGptUrl("javascript:alert(1)"), false);
});

test("does not mistake ChatGPT's logged-out guest composer for authentication", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <a href="/auth/login">Log in</a>
      <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
    </main>
  `);
  const auth = await authenticationStatus(page);
  assert.deepEqual(auth, {
    authenticated: false,
    reason: "login-control-visible",
  });
});

test("waits for a slowly hydrated signed-in composer", async (t) => {
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main id="app"><button>Pinned</button></main>
    <script>
      setTimeout(() => {
        const composer = document.createElement('div');
        composer.id = 'prompt-textarea';
        composer.setAttribute('role', 'textbox');
        composer.setAttribute('contenteditable', 'true');
        document.querySelector('#app').append(composer);
      }, 650);
    </script>
  `);
  const auth = await waitForAuthenticationStatus(page, { timeoutMs: 3_000 });
  assert.deepEqual(auth, {
    authenticated: true,
    reason: "composer-visible-without-login",
  });
});
