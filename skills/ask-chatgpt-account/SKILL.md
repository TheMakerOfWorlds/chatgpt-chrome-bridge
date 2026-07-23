---
name: ask-chatgpt-account
description: "Delegate context-isolated deep reasoning, research, critique, synthesis, planning, complex analysis, explicit file or user-authorized sanitized repository-bundle analysis, and second opinions to signed-in ChatGPT. It receives only the prompt and attachments; it cannot see the Codex conversation, project, repository, unlisted files, terminal, local UI, private state, or other agents. Prefer ChatGPT for thinking/reasoning and Grok for natural writing or rewriting. Use proactively instead of a research subagent needing no computer context. Prepare repository ZIPs with mandatory exclusions and secret scanning, retrieve generated files, and use browser inspection when extraction or completion is uncertain. Also use for option sync, login, or profiles. Pro can take an hour or longer: nonterminal phases are healthy; retain the original job ID and never resubmit unless it fails. Do not use for implicit local inspection or edits or as authoritative verification."
---

# Use ChatGPT as a Codex Worker

Use the `chatgpt-chrome-bridge` MCP tools as an independent, account-backed worker. Keep automated navigation on `https://chatgpt.com` and OpenAI authentication pages.

## Enforce the context boundary

- Treat ChatGPT as a blank external worker that receives only the text deliberately included in the tool call plus the contents of exact files deliberately listed in `attachments`, including a separately reviewed repository ZIP when the user authorizes it. It has no implicit awareness of the current Codex task, conversation history, project, repository, unlisted files, code, terminal output, local applications, private state, or other workers' results.
- Treat the configured **Agents** ChatGPT project as an organizational destination only. Filing a chat there does not transmit the active Codex project or task context.
- Send only standalone prompts. Never refer to “this project,” “the code above,” “our repository,” “the current error,” or similar unstated context.
- Use this worker for deep general investigation or reasoning-heavy standalone output, such as a research brief, market map, conceptual comparison, reusable plan, generic architecture, rigorous critique, or code example that does not depend on the local codebase.
- Keep project-aware work with Codex or a repository-aware subagent. An explicit attachment is bounded context, not permission to infer or export neighboring files. Do not export broad workspace context merely to make an unsuitable task delegable. A repository bundle is allowed only when the user deliberately authorizes that root and scope; Codex must review its manifest before upload and remains responsible for local inspection, adaptation, implementation, and verification.

## Choose the right worker

- Prefer `delegate_research_to_chatgpt` for a separable workstream that can be expressed completely in a prompt: deep background research, hard reasoning, ideation, outlining, comparison, critique, red-teaming, synthesis, generic design, or a second opinion.
- Prefer the `grok-chrome-bridge` writing worker for natural prose, rewriting, voice, tone, correspondence, scripts, posts, UX/marketing copy, and stylistic variants that need no repository or computer context.
- Prefer local tools or a repository-aware subagent when the work requires browsing the repository, discovering which files matter, running commands, editing artifacts, or observing local UI. Use an exact file set or sanitized repository bundle only when the user intentionally authorizes that material for ChatGPT and the benefit justifies external transmission.
- Use direct authoritative sources when citations, current facts, legal/medical/financial accuracy, or source verification matter. Use ChatGPT as a supplementary perspective unless the user requests only its answer.
- Do not delegate merely to repeat work Codex already completed. Delegate when the independent result can improve quality, speed, breadth, or confidence.

## Delegate a workstream

1. Make the task fully self-contained. State every fact required to answer it and remove references that depend on Codex conversation or project context. Include only small, non-secret facts that are intentionally safe to transmit. If exact attachments are authorized, explain in the prompt what ChatGPT should do with them; never assume it can read anything else in the Codex workspace.
2. Call `delegate_research_to_chatgpt`. Use the configured profile and ChatGPT project unless the user names another destination. The generated prompt begins directly with the task; do not add a worker-role preamble.
3. Omit model/reasoning arguments to use the configured defaults. This installation explicitly selects `Extra High` reasoning for every request. Pass another exact label only when the user requests it or the task materially benefits from a different choice.
4. Set `wait: true` only when blocking on the result is appropriate. For parallel work—especially `Pro` or any request that may take an hour or longer—set `wait: false`, retain every job ID, immediately submit other independent jobs or continue local work, inspect the group with `list_chatgpt_jobs`, and call `wait_for_chatgpt_response` for each job before synthesis.
5. When the requested deliverable is a file, name its expected type/structure and review checks in the prompt, set `expect_response_files: true`, and optionally give an exact absolute `response_file_output_directory`. Leave `download_response_files` enabled.
6. Attribute the returned material as ChatGPT's contribution. Reconcile it with local evidence and other sources rather than accepting contradictions silently.

The bridge runs new-chat jobs in separate tabs, with up to 30 simultaneous jobs per Codex worker by default. To prevent a submission stampede, every actual Send action passes through one shared cross-process gate and is spaced at least five seconds after the preceding attempt. This pacing is global across Codex workers that share the bridge state directory; generation continues in parallel after submission. Additional local jobs remain queued without blocking new tool calls. A ChatGPT `Pro` response taking an hour or longer can be normal. The configured response deadline defaults to two hours and can be raised to four hours. Different Codex tasks/agents use isolated worker copies of the signed-in session, so one task's Chrome process does not lock out another. Keep each returned job ID with the Codex task that created it.

Background workers launch through macOS LaunchServices without taking foreground focus and start with their native window positioned off-screen. When a worker queue becomes idle, the bridge gracefully closes that worker's Chrome process to flush its session databases, promotes verified refreshed session state back into the reusable seed under a cross-process lock, and only then removes the disposable worker directory. Option sync, response-file recovery, and inspection participate in the same activity counter, so one operation cannot close Chrome while another still uses it. Treat a session-persistence warning as actionable even when the ChatGPT response itself completed.

Use `ask_chatgpt` for a direct user-authored prompt that should pass through with minimal framing. Use `delegate_research_to_chatgpt` for a Codex-created subtask; it frames the prompt as a research/analysis assignment and records the requested deliverable.

## Prepare repository context safely

- Call `prepare_repository_bundle` only when the user clearly authorizes an exact repository root and intended scope for later sharing. Creating the bundle is local; passing its returned ZIP in `attachments` is a separate external transmission to ChatGPT and must also be within that authorization.
- Prefer `selection: selected` with the smallest useful relative `include_paths`. Use `git-tracked` for committed source, or `git-worktree` for tracked files plus non-ignored untracked work. Use `directory` only for an exact non-Git directory the user deliberately names.
- Never weaken mandatory exclusions. The action refuses filesystem/home roots, keychain, credential, Chrome/session, Codex-state, and bridge-state directories; does not follow symlinks; excludes Git metadata, dependencies, build products, caches, logs, credential-like filenames, opaque archives/packages/databases, and user-specified paths; and scans candidate contents for common private keys, access tokens, credentialed URLs, JWTs, and secret assignments.
- Treat the scanner as risk reduction, not proof. It excludes each flagged file whole and reports only relative paths, reason categories, and detection types—never detected values. It aborts rather than silently truncating when candidate-count or total-byte limits are exceeded.
- Review both returned MCP resources before upload: the ZIP and companion JSON manifest. Confirm the included paths are necessary, inspect every exclusion/warning, and spot-check the archive. Do not attach it if the scope is surprising or if another secret-scanning method finds a concern.
- The default 80 MB uncompressed cap is designed to remain under the bridge's 100 MB request ceiling. A custom larger bundle may be useful for local/private sharing but can exceed ChatGPT's upload limit.
- Attach only the returned ZIP path, not the manifest unless ChatGPT needs the manifest. Explain the repository snapshot and requested analysis in a standalone prompt. The ZIP is immutable local output with an SHA-256 hash; the source repository is never edited.

## Attach exact files safely

- Add `attachments` only when the user explicitly asks to send those exact files to ChatGPT or clearly identifies them as inputs for this worker. If Codex merely discovers an unmentioned local file that might help, ask before transmitting it.
- Supply absolute paths to individual regular files. The bridge never expands directories, globs, symlinks, or recursive workspace selections. Keep the set minimal and relevant.
- Never attach credentials, API keys, private keys, `.env` files, browser cookie/login databases, or unrelated personal/workspace data. The local validator rejects common secret and session-file patterns, but Codex remains responsible for judging the content.
- The bridge accepts at most 10 files and 100 MB total per request. Its conservative local per-file limits are 20 MB for directly supported images, 50 MB for spreadsheets/documents/text/HEIC/HEIF inputs, and 100 MB for ZIP archives. ChatGPT account, project, rate, storage, and message limits can be lower and can change.
- Direct image uploads use PNG, JPEG/JPG, or non-animated GIF. For Apple HEIC/HEIF photos, the bridge creates a private temporary JPEG, uploads that copy, reports both names/formats/sizes, deletes the temporary staging data when the job ends, and never modifies the original.
- Prefer common documents, spreadsheets, presentations, text/code, sanitized ZIP archives, PNG/JPEG/GIF, HEIC, or HEIF. Export `.gdoc`, `.gsheet`, and `.gslides` shortcuts to a real file first.
- An upload is an external transmission to the selected signed-in ChatGPT account and may be retained under that account, project, Library, and data-control settings. Do not imply it stayed local.
- Inspect the returned `attachments` and `attachmentUpload` metadata before telling the user what was sent. It records the original representation, the sent representation, conversion status, count, UI method/evidence, and conversation URL.
- The bridge selects all files once, waits until upload/progress controls clear and Send is enabled, then passes the single Send action through the global pacer. It never uses the Enter-key fallback for an attachment request and never automatically retries a failed upload, because failed attempts can consume account upload allowance. Inspect the terminal error and ask before any materially different retry.
- ChatGPT can analyze an attached file and return text, but it still cannot change the local original. Codex must make and verify any requested local edits.

## Collect generated response files

- Generated response files are outputs from ChatGPT, distinct from input `attachments`. For any prompt asking for a document, spreadsheet, presentation, PDF, archive, image, or other downloadable artifact, set `expect_response_files: true`. State the desired filename, type, structure, and verification criteria in the standalone prompt.
- Keep `download_response_files: true` (the default). The completed job's `responseFiles.files` entries provide collision-safe absolute local paths, byte sizes, MIME hints, SHA-256 hashes, and discovery methods. MCP `resource_link` blocks expose each file directly to Codex. A private JSON manifest records the collection without persisting signed query strings.
- Use `response_file_output_directory` only when the output belongs in a particular user/workspace directory; it must be an exact absolute path. Otherwise use the bridge's private response-files directory. Existing files are never overwritten. The bridge accepts at most 20 generated files, 200 MB per file, and 500 MB total per collection.
- Treat downloaded artifacts as untrusted external output. Never execute a returned program, macro, script, or archive merely because ChatGPT generated it. Inspect it with the appropriate local document, PDF, spreadsheet, presentation, image, text, or archive tooling and verify content before delivery.
- `downloaded` means every detected file was saved; `partial`, `failed`, and an expected `none_found` mean automatic extraction needs attention. Call `collect_chatgpt_response_files` once with the same `job_id` (or retained `conversation_url`) to re-scan; this never resubmits the prompt. Set `rescan: false` to retrieve cached file metadata without creating collision copies.
- If collection remains uncertain, call `inspect_chatgpt_conversation` on that same job/URL. It returns the signed-in page's active-state evidence, interim/final classification, latest response text, visible page text, file candidates, UI diagnostics, and a screenshot resource. Inspection defaults to `keep_open: false`, so its standalone browser closes immediately after the snapshot; use `keep_open: true` only when immediate browser control is actually needed, and expect the idle hold to expire after two minutes. Use `browser_visibility: visible` only when live browser control is useful, then call it with `browser_visibility: background` to move Chrome off-screen again. The retained conversation URL is the last-resort recovery handle even after the task tab and browser close.

## Track jobs

- Call `list_chatgpt_jobs` for a fast, nonblocking overview after launching multiple `wait: false` jobs. It returns short labels, IDs, queue positions, attachment and response-file metadata, conversation URLs, timestamps, errors, and the latest live `progress` snapshot without dumping completed response text. The preview is observational status, never a final result.
- Interpret phases as follows: `queued` is waiting for a local concurrency slot; `preparing` validates/stages inputs, opens the page, selects options, and waits for uploads; `waiting_to_submit` is at the global five-second Send gate; `generating` means ChatGPT is responding and may emit multiple small progress cards; `collecting_files` means the final answer was established and generated artifacts are being downloaded; `completed` and `failed` are terminal.
- Treat `queued`, `preparing`, `waiting_to_submit`, `generating`, and `collecting_files` as healthy active states even when they last an hour or more. Never call `ask_chatgpt` or `delegate_research_to_chatgpt` again for the same assignment while its original job is nonterminal.
- Do not infer completion from elapsed time, temporarily stable response text, an interim card with a Copy control, a missing legacy Stop button, an intermediate “I am researching/working” message, or a status-wait window ending. The bridge keeps Pro interim text nonterminal, requires active progress to disappear, requires an explicit terminal action on the final assistant turn, and then applies a 15-second quiet window for Pro before accepting the large final response. Keep checking the same job ID.
- Call `get_chatgpt_bridge_status` for overall health, aggregate phase counts, and the global pacer's `lastSubmittedAt` and `nextAllowedAt` values.
- Call `wait_for_chatgpt_response` with one job ID to block for or retrieve its full response. Its default five-minute wait window is only a status-call bound; reaching it does not cancel, fail, or shorten the underlying job. If it returns a nonterminal phase, keep the same job ID and call it again later. Only consider a new submission after the original job reports `failed`, and inspect the reported error before deciding whether a retry is appropriate. Terminal job records remain available for 24 hours. Job IDs remain local to the Codex worker that created them.

## Setup and account selection

- Use the configured **Jackson Stone Personal** Chrome profile by default.
- Keep delegated chats in the configured **Agents** ChatGPT project at `https://chatgpt.com/g/g-p-6a5e648cac488191befbdf735bb011fb/project` by default.
- Call `list_chrome_profiles` when the user asks to switch or a requested profile is ambiguous.
- Call `configure_chatgpt_bridge` to remember a different profile, ChatGPT project URL, or default options.
- Use `max_concurrent` to change the per-Codex-worker parallel-tab limit (1–30). This installation defaults to 30. ChatGPT account limits or local memory pressure may still reduce practical throughput; excess work stays queued rather than being discarded.
- Use `submission_interval_seconds` to change the shared cross-worker gap between actual Send actions (1–60 seconds). Keep the configured five-second default unless the user requests otherwise.
- Call `open_chatgpt_for_login` when authentication is missing. It launches ordinary native Chrome without automation flags so Google OAuth works. Ask the user to finish sign-in and then quit that dedicated bridge Chrome instance completely (Command-Q on macOS) before calling `sync_chatgpt_options`; closing only its tab or window can leave the private profile locked. An early-exit error usually means an earlier login process still owns that profile, so do not report that a usable window opened.
- Treat a visible ChatGPT `Log in` control as signed out even when the public guest composer is available. Do not sync options or delegate until the login control is gone.
- Call `refresh_login_from_chrome` only when refreshing the private automation session from regular Chrome is necessary or requested. It restarts the bridge browser.
- Call `sync_chatgpt_options` to refresh the model/reasoning labels visible to that account.
- On a stale-selector failure, call `sync_chatgpt_options` once with `force_rescan: true` to discard cached UI signatures and rediscover controls.
- Call `get_chatgpt_bridge_status` for diagnostics.
- `get_chatgpt_bridge_status.browserLifecycle` reports active browser operations, whether an idle close is scheduled, its due time, and the most recent close error. A browser that remains open while `activeOperations` is nonzero is expected; when the queue and recovery operations are idle it closes automatically.

## Safety and interpretation

- Send no secrets, credentials, or unnecessary personal/workspace data. The prompt, explicit attachment contents, and visible response pass through the user's ChatGPT website account.
- Do not claim a requested option was selected unless the tool reports it.
- Do not silently substitute a paid or more expensive option. Allow fallback only when the user permits it.
- Do not present ChatGPT's response as independent verification. Verify high-stakes claims and requested citations separately.
- Do not ask ChatGPT to perform local edits or pretend it inspected unlisted files. Codex remains responsible for any local action and for the final answer.
