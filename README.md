# ChatGPT Chrome Bridge

This Codex plugin gives Codex a persistent, context-isolated account-backed ChatGPT worker for deep reasoning, research, exploration, critique, synthesis, complex comparison, planning, explicit file analysis, deliberately authorized sanitized repository snapshots, generated artifacts, second opinions, and exact-thread follow-ups.

ChatGPT receives only the submitted prompt plus the exact files intentionally listed as attachments. It cannot see the Codex conversation, active project or repository, unlisted files, code, terminal output, local UI, private workspace state, or other agents. The configured website project is an organizational destination for new conversations, not a connection to the active Codex project. Every delegated assignment must stand on its own.

The bridge uses your own Chrome profile and ChatGPT account in an isolated background browser. **macOS only** (Apple Silicon and Intel), with Google Chrome, Node.js 20+, and Codex. No OpenAI API key is needed.

## Install and connect

**Easiest: ask Codex to set it up.** Paste this into a Codex task:

> Install the ChatGPT Chrome Bridge from https://github.com/TheMakerOfWorlds/chatgpt-chrome-bridge. Read its AGENTS.md and docs/INSTALL.md, help me connect my own ChatGPT account, and ask whether I want new chats in no project or in a project I choose.

Codex will help with prerequisites, account selection, login, and the project preference. This is an unofficial community project; it uses your own ChatGPT website session.

For manual setup, download this repository with **Code → Download ZIP**, extract it, and open **Setup.command**. The installer checks prerequisites, downloads the latest stable release, asks which Chrome profile to use, and verifies ChatGPT login. If sign-in is needed, finish it in the dedicated Chrome window, quit that instance with Command-Q, and press Return in the installer. It then asks where new chats should go: **no project**, or a ChatGPT project URL from your account. Start a new Codex task when setup finishes.

Or use Terminal:

```sh
git clone https://github.com/TheMakerOfWorlds/chatgpt-chrome-bridge.git
cd chatgpt-chrome-bridge
sh install.sh
```

[Complete setup and troubleshooting](docs/INSTALL.md) · [Publishing updates](docs/RELEASING.md)

Automatic stable-release updates are enabled by default. The bridge checks GitHub at startup and every six hours while running, verifies the download, prepares dependencies separately, and installs the update for new Codex tasks. Active jobs continue on their current version. You can ask Codex to check or install updates; manual mode and rollback are available. Login data survives updates. Install with `--manual-updates` to opt out.

New users choose their own Chrome profile and project preference; **no project** is the default. Existing settings are preserved unless you choose a change. You can later ask Codex to change or clear the default project. Prompts begin directly with the task itself, without a generic worker-role preamble.

The ChatGPT bridge uses the website's current/default model, including **GPT-6** through the website's **Latest** selection. It does not pin GPT-5.6 or expose model switching to Codex. It only controls thinking effort. The default effort is **Extra High**; omit the per-request `reasoning` argument to select it automatically, or pass another currently visible effort for a one-off override. The adapter discovers the compact **Power** slider dynamically, including composer labels with a model badge such as **6 Pro**, and retains compatibility with **Advanced → Effort** menus. Syncing or changing effort preserves the selected model.

## Compact status and diagnostics

Routine bridge status and job listings return compact output by default. `get_chatgpt_bridge_status` reports configuration, browser state, job counts, updates and actionable errors. `list_chatgpt_jobs` reports IDs, phases, recovery URLs, bounded previews and file counts without full answers. Use its `status` and `limit` filters for a narrower list.

Pass `details: true` to either tool for full diagnostic metadata. The same option is available on ask, delegate, reply and wait calls. A completed compact wait still returns the **complete answer, warnings and generated-file links**; only job metadata is reduced. Existing direct consumers of the old detailed status shape should request `details: true`.

Codex loads a short core skill for ordinary use. Attachment and browser-recovery procedures are separate references, read only when needed. These changes reduce context payloads; exact token/credit savings depend on the Codex host and workload.

## ChatGPT conversation follow-ups

`reply_to_chatgpt_conversation` continues an exact completed website conversation. It accepts either a completed `job_id` from the current Codex worker or the exact `conversation_url` returned by an earlier job. The URL is the durable continuation handle across Codex tasks, MCP restarts, and local retention pruning. The action never reuses whichever browser tab happens to be focused; it opens the exact conversation in an owned background tab, verifies the final URL, waits for the complete conversation to hydrate and remain stable, requires the latest authored turn to be a terminal assistant response, and refuses to submit while Stop/progress/research signals or interim Pro text remain.

Every follow-up receives a new bridge job ID with `parentJobId`, `rootJobId`, and `replyDepth` metadata when the parent is available locally. Status checks and later follow-ups use that new ID. The reply can rely on the selected ChatGPT conversation's own history, but it still receives no new Codex conversation, repository, terminal, local UI, file, or other-agent context unless Codex explicitly includes that information in the follow-up prompt or exact authorized attachments.

The normal effort selector, attachment upload, generated-file retrieval, two-to-four-hour response deadline, five-second global Send gate, Pro finality detector, browser inspection fallback, and idle-close behavior all apply to replies. Same-conversation replies remain FIFO inside one MCP worker. A filesystem-backed lease keyed by the ChatGPT conversation ID serializes the same chat across separate Codex workers; its heartbeat prevents a live hour-plus Pro reply from being mistaken for an abandoned lock. Unrelated conversations still use the full parallel queue.

## Sanitized repository bundles

`prepare_repository_bundle` creates a local ZIP plus a companion JSON manifest from an exact user-authorized repository root. It never uploads, commits, pushes, or otherwise transmits the archive. A later `ask_chatgpt` or `delegate_research_to_chatgpt` call may attach the returned ZIP only when the user has authorized that external upload.

The default `git-worktree` mode asks Git for tracked files plus non-ignored untracked files, so `.gitignore` remains the first scope boundary. `git-tracked` includes only tracked files. `selected` recursively expands only explicitly named relative files or directories, while `directory` walks a deliberately named non-Git root. The bridge rejects filesystem roots, the entire home directory, keychain/credential/Chrome/Codex/bridge-state roots, path traversal, and symlinks. It also excludes Git metadata, dependencies, common build/cache/runtime trees, logs, credential-like filenames, opaque archives/packages/databases that cannot be inspected safely, and optional caller-specified path prefixes.

Every remaining regular file is read once, checked against per-file and total limits, scanned for common private-key headers, provider tokens, API keys, JWTs, credentialed URLs, and secret-like assignments, then copied from the already-scanned bytes into a private staging tree. A flagged file is omitted whole; the bridge never tries to rewrite a configuration file by removing only a suspected value. The manifest records relative included paths, byte sizes and SHA-256 hashes, excluded paths and reason categories, detection type names, limits, warnings, and the final ZIP hash—but never detected values or repository remote credentials. Temporary staging is deleted after the archive is produced, source files are never modified, output files use private permissions, and existing outputs are never overwritten.

The default cap is 5,000 candidate paths, 25 MB per file, and 80 MB of included uncompressed data. It aborts instead of silently truncating when the candidate-count or total-byte limit is exceeded. Larger explicit limits are available for local/private sharing, up to 20,000 paths, 100 MB per file, and 500 MB total, but ChatGPT uploads remain capped by the bridge at 100 MB per request.

Pattern-based scanning reduces risk but cannot prove that a repository contains no secrets. Review the manifest and ZIP before sharing, prefer `selected` over a whole-worktree bundle when possible, and use an additional specialized scanner for high-sensitivity repositories.

## Exact file attachments

`delegate_research_to_chatgpt`, `ask_chatgpt`, and `reply_to_chatgpt_conversation` accept an optional `attachments` array of absolute local file paths. This is an explicit external upload through the selected signed-in ChatGPT account, not implicit repository access. Codex should use it only when the user authorizes those exact files, tell ChatGPT what to do with them in the standalone prompt or follow-up, and keep all unlisted files private.

The bridge applies deliberately conservative guardrails:

- Up to 10 individual regular files and 100 MB total per request.
- No directories, globs, recursive workspace collection, symlinks, `.env` files, key/credential patterns, or Chrome cookie/login databases.
- Direct support for common documents, presentations, spreadsheets, text/code, ZIP archives, PNG, JPEG/JPG, and non-animated GIF. Google shortcut files must be exported first.
- Directly supported images are capped at 20 MB; spreadsheets, documents, text, and HEIC/HEIF inputs are capped at 50 MB each; ZIP archives are capped at 100 MB. ChatGPT's account/project limits can be lower and can change.
- Apple HEIC/HEIF photos are privately converted to temporary JPEG copies with `sips` because ChatGPT's documented image-input list names PNG, JPEG, and non-animated GIF. The result reports the original and sent names, formats, sizes, and conversion status. Originals are untouched and staging files are removed when the job ends.
- All files are selected in one operation. The bridge waits for upload/progress UI to settle and for Send to become enabled, submits exactly once through the global pacer, never falls back to pressing Enter for an attachment request, and never automatically retries an upload failure.

Job/status results expose `attachmentCount`, `attachmentUpload`, and compact sent-file metadata. A completed result includes the full `attachments` record and conversation URL, so Codex can state exactly which representation reached ChatGPT. Uploaded content can be retained by the ChatGPT account, project, Library, and data-control settings; this plugin does not claim that uploaded files stay local.

## Generated response files

Generated response files are handled separately from input attachments. When a prompt requests a document, spreadsheet, presentation, PDF, archive, image, or other downloadable artifact, Codex sets `expect_response_files: true` and describes the expected filename, type, structure, and checks. Automatic collection is enabled by default and uses the signed-in browser session, so account-protected downloads remain accessible.

Every saved artifact gets a collision-safe absolute path, size, MIME hint, SHA-256 hash, download method, and a private JSON manifest. Signed query strings and private blob/data identifiers are not persisted. The MCP result also includes a `resource_link` for each file, allowing Codex to open it with the appropriate local document, spreadsheet, PDF, presentation, image, text, or archive tooling. Existing files are never overwritten. The collection limits are 20 files, 200 MB per file, and 500 MB total; files and directories are created with private permissions. Generated artifacts are untrusted external output and are never automatically executed.

By default files go under the bridge state directory. `response_file_output_directory` can target an exact absolute user/workspace directory. `collect_chatgpt_response_files` reopens and re-scans the same completed conversation without sending another prompt; it can also return cached metadata without creating a duplicate. `partial`, `failed`, or an expected `none_found` recommends the fail-safe `inspect_chatgpt_conversation` tool, which returns current activity/finality evidence, latest assistant and visible page text, detected file controls, diagnostics, and a screenshot resource. It can bring the native Chrome window on-screen for browser control and move it back into the background afterward. Standalone collection and inspection close Chrome when finished by default; an explicit `keep_open: true` retains an inspection window for up to two idle minutes for immediate browser follow-up. The conversation URL remains the durable recovery handle after the browser closes.

This follows [OpenAI's guidance for working with generated files](https://learn.chatgpt.com/docs/artifacts-viewer): specify source data, expected format/structure, and review criteria, then open or download and verify the result.

New-chat jobs run concurrently in separate tabs (up to 30 at once per Codex worker by default, configurable from 1–30). Exact-thread reply jobs run concurrently only when they target different conversations. Their actual Send actions pass through a shared filesystem-backed gate and are spaced at least five seconds apart globally across Codex workers using the same bridge state directory. This prevents a burst of tabs from submitting at once while allowing already-submitted ChatGPT responses to generate concurrently. Use `wait: false` to receive a job ID immediately, launch more work while a long `Pro` response continues, inspect progress with `list_chatgpt_jobs`, and collect each result with `wait_for_chatgpt_response`. A Pro response taking an hour or longer can be normal. Nonterminal phases are not a reason to submit the work again: keep the original job ID until it completes or explicitly fails. Separate Codex tasks and agents receive isolated worker copies of the signed-in session, avoiding Chrome profile locks while keeping all new chats in the configured project.

Each job reports a phase: `queued`, `waiting_for_conversation`, `preparing`, `waiting_to_submit`, `generating`, `collecting_files`, `completed`, or `failed`. The first six are healthy active states; only the last two are terminal. `waiting_for_conversation` means a reply is respecting another Codex worker's lease for that exact chat. `list_chatgpt_jobs` includes reply lineage, the live conversation URL, and a compact progress snapshot so Codex can see what a long Pro task is doing without mistaking the preview for its result. The completion detector does not accept elapsed time, stable partial text, a tiny interim card with Copy controls, or a temporarily missing Stop button as proof. It recognizes interim “still working/researching” language, requires active Stop/progress/busy/research signals to disappear, requires an explicit terminal action on the final assistant turn, and applies a 15-second final quiet window to Pro before accepting the large final response. `get_chatgpt_bridge_status` includes aggregate phase counts plus the shared pacer's last and next allowed submission times. The default `wait_for_chatgpt_response` call waits up to five minutes but never cancels the underlying job.

Terminal job and paired conversation metadata are retained for at most 24 hours and capped at the 200 newest terminal records per MCP worker. Active jobs and the ancestors of active replies are never evicted. Pruning runs on queue operations, after completion, and hourly while a worker remains alive, so an idle long-lived process does not accumulate an unbounded list. The job map and conversation index are local process metadata; the website `conversation_url` remains the cross-task recovery and reply handle.

Automatic disk cleanup is deliberately narrower. Stale internal inspection PNGs are age/count bounded, while screenshots still referenced by retained records are protected. The bridge never automatically deletes ChatGPT account conversations, downloaded response files, caller-selected output directories, completed repository ZIPs/manifests, or source attachments. Those are user-visible artifacts rather than disposable queue bookkeeping.

The ChatGPT skill allows implicit invocation, so a new Codex task can choose the worker without an explicit skill mention. Repository browsing, local discovery, commands, and edits remain with Codex or a suitable repository-aware subagent.

Because ChatGPT's Cloudflare front door challenges true headless Chrome, background work uses a real native Chrome instance. On macOS the bridge launches it through LaunchServices with the official background/no-foreground option and also places its window off-screen before ChatGPT loads, so starting a job does not pop Chrome in front of the user's active application. Codex attaches afterward through a random loopback-only DevTools port. A deliberately visible inspection omits the background flag and can bring the controlled window on-screen.

Each active queue retains Chrome while any job is waiting for a conversation lease, preparing, waiting to submit, generating, or collecting response files. A locally queued same-conversation reply does not open a tab until its predecessor finishes. When the queue has no pending or running work, the bridge gracefully sends Chrome `Browser.close`, waits for the process to exit, and uses bounded TERM/KILL fallbacks only if graceful shutdown stalls. Option synchronization and standalone recovery operations participate in the same activity counter, so overlapping work cannot close another operation's browser. `get_chatgpt_bridge_status` reports active operations, scheduled idle closure, the due time, and the most recent close error. The explicit `stop_chatgpt_bridge` tool remains available as a manual escape hatch.

Worker profiles are disposable, but refreshed login state is not: after a verified authenticated worker becomes idle, Chrome is closed so its session databases are flushed, then the supported session state is promoted back into the reusable seed under a cross-process lock before the worker directory is removed. A later Codex task therefore starts from the most recently refreshed session instead of the original copied cookies. One-time sign-in still opens the private bridge profile without automation or remote debugging. Quit that dedicated Chrome instance after signing in so the background worker can reopen the profile; closing only its tab or window may leave Chrome running. The login launcher waits through a startup grace period and reports an error when Chrome exits immediately, which commonly means an earlier bridge login process still owns the private profile. The bridge never automates navigation outside `https://chatgpt.com` or OpenAI authentication origins.

## Configuration

ChatGPT runtime state defaults to `~/Library/Application Support/ChatGPT Chrome Bridge`. The environment overrides are `CHATGPT_CHROME_BRIDGE_STATE_DIR`, `CHATGPT_CHROME_USER_DATA_DIR`, and `CHATGPT_CHROME_EXECUTABLE`.

The worker defaults to a two-hour job response deadline configurable up to four hours, 30 concurrent tabs per Codex worker, and a global five-second submission interval configurable from 1–60 seconds. Prefer asynchronous jobs (`wait: false`) for parallel work. While a job is nonterminal, status-check the same ID rather than resubmitting its prompt.

The UI adapter prefers stable test IDs and accessible names, caches only control signatures, expands the collapsed Advanced menu, enters the Effort submenu, and falls back to semantic rescanning when selectors stop working. Attachment upload similarly prefers the native file input, then the composer attachment control and accessible upload action. Generated-file discovery checks the final assistant turn semantically, with authenticated-request and direct browser-download paths. No website automation can promise survival across every future redesign; `sync_chatgpt_options(force_rescan: true)` is the option-control repair path, while `inspect_chatgpt_conversation` preserves a browser-level escape hatch for completion and response-file UI changes.

## Privacy

Prompts, exact explicit attachment contents, and responses pass through the selected signed-in ChatGPT web account. The plugin keeps a private local automation copy of the selected profile's ChatGPT cookies and site storage so regular Chrome and the background worker can run concurrently. It does not copy saved passwords, browsing history, bookmarks, downloads, or arbitrary tabs. Temporary HEIC/HEIF JPEGs live only under the bridge state directory for the active job and are removed afterward; source photos are never modified.

ChatGPT follow-ups read and extend the exact account conversation named by the target job or URL. Local retention pruning removes only bridge bookkeeping and stale internal inspection evidence; it does not remove or alter the corresponding website conversation. Conversely, deleting a website conversation outside the bridge can make a retained local URL unusable.

Repository bundles are local-only until a separate attachment call transmits the returned ZIP. Their staging directories are removed after creation, while completed ZIPs and manifests remain private local files until the user deletes them. Bundling excludes common secrets and reports warnings, but it is not a substitute for repository-specific security review.

## Lightweight browser storage

Private Chrome launches use a 32 MiB HTTP disk-cache budget and disable Chrome's on-device model downloads. Service-worker asset caches are excluded from login snapshots; cookies, Local Storage, IndexedDB, and other session state are retained. A failed session copy removes its partial temporary directory and restores the previous destination if replacement fails.

At startup, every 15 minutes while the bridge runs, and after worker shutdown, maintenance prunes disposable caches from idle bridge profiles and removes abandoned workers older than five minutes. It takes the session-copy lock, checks both owner/browser PIDs and live Chrome profile arguments, and skips active profiles. Workers marked for session recovery retain their login data. Symlinks are not followed; the regular Chrome profile, downloaded response files, and account conversations are outside cleanup scope. `get_chatgpt_bridge_status(details: true).browserCache` reports the policy and last cleanup/error.

The 32 MiB budget applies to Chrome's HTTP cache, not all browser storage. Active jobs can temporarily use more space for website data. Completed workers are deleted after authenticated session persistence; login data and explicitly saved downloads are not subject to a destructive total-size quota.
