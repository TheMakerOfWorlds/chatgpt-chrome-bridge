import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptChromeBridge } from "../lib/bridge.mjs";

const projectUrl = "https://chatgpt.com/g/g-p-project/project";
const conversationUrl = "https://chatgpt.com/c/verified-conversation";
const signedIn = { authenticated: true, reason: "composer-visible-without-login" };
const missingEditor = { authenticated: false, reason: "composer-not-found" };
const signedOut = { authenticated: false, reason: "login-control-visible" };

function fixture({ navigationErrors = [], authentication = [signedIn], reloadDestination = null } = {}) {
  let currentUrl = "https://chatgpt.com/";
  let navigations = 0, reloads = 0, closes = 0, loadWaits = 0, authChecks = 0;
  const page = {
    url: () => currentUrl,
    goto: async destination => {
      const error = navigationErrors[navigations++];
      if (error) throw new Error(error);
      currentUrl = destination;
    },
    waitForLoadState: async () => { loadWaits += 1; },
    waitForTimeout: async () => {},
    reload: async () => {
      reloads += 1;
      if (reloadDestination) currentUrl = reloadDestination;
    },
    close: async () => { closes += 1; },
  };
  const bridge = new ChatGptChromeBridge();
  bridge.config = { projectUrl };
  bridge.ensureBrowser = async () => ({
    context: { newPage: async () => page },
    page,
    profile: { directory: "Profile 1" },
  });
  bridge.waitAuthenticationChecker = async () => authentication[Math.min(authChecks++, authentication.length - 1)];
  bridge.conversationReplyReadinessChecker = async () => ({ ready: true, assistantMessageCount: 1 });
  return {
    bridge, page,
    useOwnedPage() {
      bridge.ensureBrowser = async () => ({
        context: { newPage: async () => page }, page: {}, profile: { directory: "Profile 1" },
      });
    },
    counts: () => ({ navigations, reloads, closes, loadWaits, authChecks }),
  };
}

test("sync navigation recovers when Chrome's initial home navigation interrupts the project", async () => {
  const f = fixture({ navigationErrors: ['page.goto: Navigation to project is interrupted by another navigation to "https://chatgpt.com/"'] });
  const opened = await f.bridge.openChatGpt({ targetUrl: projectUrl });
  assert.equal(opened.url, projectUrl);
  assert.equal(opened.authenticated, true);
  assert.deepEqual(f.counts(), { navigations: 2, reloads: 0, closes: 0, loadWaits: 1, authChecks: 1 });
});

test("repeated navigation interruptions stop after three attempts and close the owned tab", async () => {
  const f = fixture({ navigationErrors: Array(3).fill("Navigation interrupted by another navigation") });
  f.useOwnedPage();
  await assert.rejects(f.bridge.openTaskPage(), /interrupted by another navigation/);
  assert.deepEqual(f.counts(), { navigations: 3, reloads: 0, closes: 1, loadWaits: 2, authChecks: 0 });
});

test("an unrelated navigation error is preserved and its owned tab is closed", async () => {
  const f = fixture({ navigationErrors: ["net::ERR_INTERNET_DISCONNECTED"] });
  f.useOwnedPage();
  await assert.rejects(f.bridge.openTaskPage(), /ERR_INTERNET_DISCONNECTED/);
  assert.deepEqual(f.counts(), { navigations: 1, reloads: 0, closes: 1, loadWaits: 0, authChecks: 0 });
});

test("a missing editor at the initial auth gate reloads before an exact-chat reply", async () => {
  const f = fixture({ authentication: [missingEditor, signedIn] });
  f.useOwnedPage();
  const opened = await f.bridge.openTaskPage({ conversationUrl, newChat: false });
  assert.equal(opened.continuationState.ready, true);
  assert.equal(opened.page.url(), conversationUrl);
  assert.deepEqual(f.counts(), { navigations: 1, reloads: 1, closes: 0, loadWaits: 0, authChecks: 2 });
});

test("sync also recovers an initially missing editor without requiring login", async () => {
  const f = fixture({ authentication: [missingEditor, signedIn] });
  const opened = await f.bridge.openChatGpt({ targetUrl: projectUrl });
  assert.equal(opened.authenticated, true);
  assert.equal(f.counts().reloads, 1);
});

test("a persistently missing editor fails with a loading error after two reloads", async () => {
  const f = fixture({ authentication: [missingEditor] });
  f.useOwnedPage();
  await assert.rejects(f.bridge.openTaskPage({ conversationUrl }), error => {
    assert.match(error.message, /editor did not finish loading/);
    assert.doesNotMatch(error.message, /not signed in/);
    return true;
  });
  assert.equal(f.counts().reloads, 2);
  assert.equal(f.counts().closes, 1);
});

test("initial authentication recovery refuses redirects and an actual sign-out", async () => {
  for (const options of [
    { authentication: [missingEditor, signedIn], reloadDestination: "https://chatgpt.com/c/another-conversation" },
    { authentication: [missingEditor, signedIn], reloadDestination: "https://chatgpt.com/" },
    { authentication: [missingEditor, signedOut] },
  ]) {
    const f = fixture(options);
    f.useOwnedPage();
    await assert.rejects(f.bridge.openTaskPage({ conversationUrl }), /refused to send|not signed in/);
    assert.equal(f.counts().reloads, 1);
    assert.equal(f.counts().closes, 1);
  }
});

test("a persistent login control does not trigger missing-editor recovery", async () => {
  const f = fixture({ authentication: [signedOut] });
  f.useOwnedPage();
  await assert.rejects(f.bridge.openTaskPage({ conversationUrl }), /not signed in/);
  assert.equal(f.counts().reloads, 0);
  assert.equal(f.counts().closes, 1);
});
