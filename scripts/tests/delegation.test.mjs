import assert from "node:assert/strict";
import test from "node:test";

import { buildDelegationPrompt } from "../lib/delegation.mjs";

test("frames a self-contained Codex research workstream", () => {
  const prompt = buildDelegationPrompt({
    task: "Compare three customer-retention strategies.",
    context: "The product is a paid creator tool.",
    deliverable: "A concise decision matrix and recommendation.",
  });
  assert.ok(prompt.startsWith("Compare three customer-retention strategies."));
  assert.equal(prompt.split("\n", 1)[0], "Compare three customer-retention strategies.");
  assert.match(prompt, /Compare three customer-retention strategies/);
  assert.match(prompt, /paid creator tool/);
  assert.match(prompt, /decision matrix/);
  assert.match(prompt, /no access to the Codex conversation/);
  assert.match(prompt, /active project, repository, files, code, terminal output/);
  assert.match(prompt, /organizational only and provides no Codex task context/);
});

test("omits empty optional delegation sections", () => {
  const prompt = buildDelegationPrompt({ task: "Generate five product names." });
  assert.doesNotMatch(prompt, /Relevant context/);
  assert.doesNotMatch(prompt, /Requested deliverable/);
});

test("limits delegated context to the exact explicitly attached files", () => {
  const prompt = buildDelegationPrompt({
    task: "Compare the two photos.",
    attachments: ["/tmp/one.jpg", "/tmp/two.jpg"],
  });
  assert.ok(prompt.startsWith("Compare the two photos."));
  assert.match(prompt, /except the exact files attached to this message/);
  assert.match(prompt, /those explicit attachments/);
  assert.doesNotMatch(prompt, /Act as an independent research/);
});
