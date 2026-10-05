import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptChromeBridge } from "../lib/bridge.mjs";

const url = "https://chatgpt.com/c/verified-conversation";
function fixture(states, {redirect = null, signOutOnReload = false} = {}) {
  let currentUrl = "about:blank", reloads = 0, closes = 0, checks = 0;
  const page = {
    url: () => currentUrl,
    goto: async destination => {currentUrl = destination;},
    waitForTimeout: async () => {},
    reload: async () => {reloads += 1;if(redirect) currentUrl = redirect;},
    close: async () => {closes += 1;},
  };
  const bridge = new ChatGptChromeBridge();
  bridge.config = {projectUrl: null};
  bridge.ensureBrowser = async () => ({context:{newPage:async()=>page},page:{},profile:{directory:"Profile 1"}});
  bridge.waitAuthenticationChecker = async () => ({authenticated:!(signOutOnReload && reloads)});
  bridge.conversationReplyReadinessChecker = async () => states[Math.min(checks++,states.length-1)];
  return {bridge,page,counts:()=>({reloads,closes,checks})};
}
const missing = {ready:false,reason:"composer-not-found",assistantMessageCount:1};
const ready = {ready:true,reason:null,assistantMessageCount:1};

test("reopens a missing editor before a same-chat reply and returns the verified page", async () => {
  const f = fixture([missing,ready]);
  const opened = await f.bridge.openTaskPage({conversationUrl:url,newChat:false});
  assert.equal(opened.page,f.page);
  assert.equal(opened.continuationState.ready,true);
  assert.equal(opened.conversationUrl,url);
  assert.deepEqual(f.counts(),{reloads:1,closes:0,checks:2});
});

for (const reason of ["response-active","latest-response-interim","latest-turn-not-assistant"]) {
  test(`does not reload or submit when the conversation reports ${reason}`, async () => {
    const f = fixture([{...missing,reason}]);
    await assert.rejects(f.bridge.openTaskPage({conversationUrl:url,newChat:false}),new RegExp(reason));
    assert.deepEqual(f.counts(),{reloads:0,closes:1,checks:1});
  });
}

test("bounds missing-editor recovery to two reloads without submitting", async () => {
  const f = fixture([missing]);
  await assert.rejects(f.bridge.openTaskPage({conversationUrl:url,newChat:false}),/did not submit/);
  assert.deepEqual(f.counts(),{reloads:2,closes:1,checks:3});
});

test("a recovery redirect or lost login refuses the follow-up", async () => {
  for (const options of [{redirect:"https://chatgpt.com/c/other-conversation"},{signOutOnReload:true}]) {
    const f = fixture([missing,ready],options);
    await assert.rejects(f.bridge.openTaskPage({conversationUrl:url,newChat:false}),/refused to send|did not submit/);
    assert.deepEqual(f.counts(),{reloads:1,closes:1,checks:1});
  }
});
