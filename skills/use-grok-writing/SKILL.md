---
name: use-grok-writing
description: "Delegate context-isolated natural writing, rewriting, voice, tone, correspondence, scripts, posts, UX or marketing copy, and other standalone prose to the signed-in Grok account. Grok receives only the explicit prompt and attachments; it cannot see the Codex conversation, project, repository, unlisted files, terminal, local UI, private state, or other agents. Prefer Grok over a research subagent when natural writing is the main goal and no computer/project context is needed; prefer ChatGPT for deep reasoning, thinking, research, complex analysis, and verification. Use Jackson Stone Personal (Profile 1) and the configured Grok project. Supports exact file attachments, dynamic model sync, concurrent jobs, durable status, browser inspection, background launch, and idle close."
---

# Use Grok as a Codex Writing Worker

Use the `grok-chrome-bridge` MCP tools for standalone natural-language work through the user's signed-in Grok subscription. Keep automated navigation on `https://grok.com`.

## Route work by strength

- Prefer Grok for natural prose, rewriting, editing for voice, tone and cadence, correspondence, scripts, posts, descriptions, UX text, marketing copy, naming language, and stylistic variants.
- Prefer ChatGPT for deep reasoning, thinking through hard problems, research, complex comparison, factual synthesis, critique that depends on rigorous analysis, and second-opinion verification.
- Prefer local Codex tools or a repository-aware subagent when the assignment requires inspecting the repository, finding relevant files, reading terminal output, editing local artifacts, running commands, or using private project state.
- A writing assignment may include facts or an outline already established by Codex. Put every required fact explicitly in `task` or `context`; Grok cannot infer anything from this conversation.
- Do not delegate merely to repeat finished work. Use Grok when its writing quality or an independent stylistic pass materially improves the result.

## Enforce the context boundary

- Grok receives only the exact text deliberately included in the tool call plus the contents of exact paths deliberately listed in `attachments`.
- Grok cannot see the Codex conversation, active task, project, repository, unlisted files, code, terminal, local applications, private workspace state, or other agents' work.
- The configured Grok project at `https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6` is only an organizational destination. It provides no Codex task or project context.
- Write a complete standalone assignment. Never rely on phrases such as “this project,” “what we discussed,” “the code above,” “the current file,” or “our product” without supplying the missing facts.
- An attachment is bounded external context, not permission to inspect or export neighboring files.
- Do not use Grok output as authoritative factual, medical, legal, financial, or security verification. Check important claims with primary sources and local evidence.

## Delegate natural writing

1. State the writing task directly. Do not add “Act as an independent worker” or another role preamble.
2. Supply only the facts, audience, voice, constraints, and deliverable needed for the writing. Keep private or unnecessary project details out.
3. Call `write_with_grok`. Omit `model` to use the configured `Fast` default. Grok's current model labels are discovered dynamically and can change; explicit options may include `Fast`, `Auto`, `Expert`, or `Heavy`.
4. Use `ask_grok` only when passing through a complete prompt authored by the user with minimal transformation.
5. Set `wait: false` for several independent jobs, retain every returned job ID, continue other work, inspect them with `list_grok_jobs`, and retrieve each original job using `wait_for_grok_response`.
6. Treat the returned prose as Grok's contribution. Adapt it to the user's confirmed facts and constraints before delivery.

The bridge supports up to 30 simultaneous jobs per Codex worker by default. Each job opens in a separate tab, while every actual Submit action passes through a shared cross-process gate spaced at least five seconds from the previous submission. Generation proceeds in parallel after submission. Different Codex tasks use isolated session copies, so long work does not block another worker from launching.

`queued`, `preparing`, `waiting_to_submit`, and `generating` are healthy nonterminal phases. A status wait ending does not cancel the job and is never a reason to submit a duplicate. Keep the original job ID unless that job reports `failed`. The default response deadline is two hours and can be configured up to four hours.

Background Chrome launches as a real off-screen window so account sites continue to work without stealing focus. When its queue and any inspection operations are idle, the worker closes automatically after flushing and preserving verified session changes.

## Attach exact files safely

- Add `attachments` only when the user explicitly asks to send those exact files to Grok or clearly supplies them as inputs for this writing work. If Codex merely discovers an unmentioned local file that could help, ask before transmitting it.
- Supply absolute paths to individual regular files. The bridge does not expand directories, globs, symlinks, or implicit workspace context.
- Never attach credentials, private keys, `.env` files, browser cookies or login databases, or unrelated personal/workspace data.
- The bridge accepts at most 10 files and 100 MB total per request, with conservative type-specific local limits. Grok's account, storage, rate, or message limits can be lower and can change.
- HEIC/HEIF photos are converted to private temporary JPEG copies for upload. The original files are never changed.
- An upload is an external transmission to the user's signed-in Grok account and may be retained or used according to that account's settings and xAI's current terms. Do not describe it as local-only.
- Inspect returned `attachments` and `attachmentUpload` metadata before claiming which files were sent. A failed upload is not automatically retried because retries can consume account allowance.

## Track and recover jobs

- `list_grok_jobs` is the quick nonblocking overview for many jobs. It returns IDs, labels, queue positions, phases, conversation URLs, progress previews, timestamps, errors, and result summaries without dumping completed response text.
- `wait_for_grok_response` waits for or retrieves one original job. Its five-minute default wait window does not shorten the underlying response deadline.
- Never infer completion only from elapsed time, temporarily stable text, or a progress snippet. The bridge requires a new assistant response, no active stop/thinking/progress signals, an available composer, and a final quiet window.
- Use `get_grok_bridge_status` for configured profile/project/model, browser lifecycle, aggregate phases, cached model labels, and the global pacer's next allowed submission time.
- Use `inspect_grok_conversation` when extraction or completion appears uncertain. It reconnects to the exact job or URL, reports active-state evidence and visible response text, and can capture a screenshot without resubmitting.
- Set `browser_visibility: visible` only when direct browser recovery is useful, then return it to `background`. Standalone inspection closes automatically when idle unless `keep_open` is explicitly set; that hold expires after roughly two minutes.

## Setup and exact account selection

- Use **Jackson Stone Personal** (`Profile 1`) on this Mac. The configured profile directory is authoritative even when the user has many Chrome profiles open and another window is focused.
- File chats in `https://grok.com/project/de8fe3b5-f7e9-4294-95fd-ba1452c5cbd6` by default.
- Use `list_grok_chrome_profiles` only to diagnose configuration or deliberately switch accounts.
- Use `configure_grok_bridge` to set the exact profile, project, default model, concurrency, response deadline, or submission pacing.
- Use `refresh_grok_login_from_chrome` to copy current Grok cookies and site storage from Jackson Stone Personal into the isolated bridge profile. Passwords, tabs, history, and bookmarks are not copied.
- Use `open_grok_for_login` only when the isolated profile is still signed out. Finish sign-in in the ordinary dedicated Chrome window, then quit that Chrome instance completely before syncing.
- Use `sync_grok_options` to verify authentication and rediscover the current model labels. Run it once with `force_rescan: true` after a stale-selector failure or Grok UI update.
- Use `stop_grok_bridge` for an explicit close; normal queues close themselves when idle.

## Safety

- Never silently choose a paid or more expensive model. Keep `Fast` unless the user asks for another option or the task clearly justifies it, and report what the tool says was selected.
- Do not send secrets or unnecessary personal/workspace details.
- Do not ask Grok to pretend it inspected unlisted local files or to perform local edits.
- Codex remains responsible for checking facts, applying any local changes, and delivering the final result.
