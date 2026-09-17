---
name: ask-chatgpt-account
description: "Use signed-in ChatGPT for standalone research, analysis, drafting, authorized file analysis, and exact-chat follow-ups. Also use for bridge setup, project preferences, login and updates. ChatGPT cannot inspect local or Codex context implicitly."
---

# ChatGPT account bridge

Use the bridge for a self-contained assignment that benefits from ChatGPT. Keep local inspection, edits and authoritative verification with Codex. Do not delegate merely to repeat completed work.

## Context and account boundaries

ChatGPT receives only the submitted text, exact authorized attachments, and the selected ChatGPT conversation history for a reply. It cannot see Codex messages, repositories, unlisted files, terminal/UI state or other workers. A ChatGPT project only organizes chats; it does not transmit Codex context. Include every fact needed in the prompt. Never attach secrets or infer permission to export adjacent files.

Use the configured account/project. The bridge preserves the website's current model (including Latest/GPT-6) and changes only thinking effort. Omit `reasoning` for the configured default; use another visible effort when requested or justified. Do not silently substitute an unavailable option unless fallback was authorized.

## Start, wait, retrieve

1. Use `delegate_research_to_chatgpt` for a Codex-written assignment; use `ask_chatgpt` for a direct user prompt. Specify the deliverable and necessary context. For files, set `expect_response_files: true` and describe the filename, format and checks.
2. For long or parallel work, use `wait: false` and retain every returned job ID. Continue useful independent work, then use `wait_for_chatgpt_response` on that ID. For a short task where blocking is appropriate, `wait: true` returns the result directly.
3. Prefer a bounded wait over repeated immediate status calls. Waiting happens in local code. A wait timeout does not cancel the underlying job. Pro may take hours; queued, waiting_for_conversation, preparing, waiting_to_submit, generating and collecting_files are active phases. Never submit a duplicate while the original remains active. Only consider retrying a failed job after inspecting its error.
4. Routine status defaults to compact output. `list_chatgpt_jobs` lists job IDs/phases without full answers; use its status/limit filters to narrow the list. `get_chatgpt_bridge_status` gives configuration, browser state, aggregate counts and errors. Pass `details: true` only when diagnostics are needed. Completed waits return the complete answer and file links even in compact mode; do not repeatedly fetch that same completed result.
5. Read the final result and report material warnings. An interim preview is not completion. Attribute ChatGPT's contribution and verify claims against appropriate evidence.

Jobs send at a shared five-second interval by default and may generate concurrently. Job IDs belong to the creating worker; retain the conversation URL for cross-task recovery. Terminal local records expire after 24 hours (maximum 200); website chats and downloaded files remain. Idle browsers close automatically after saving refreshed login state.

## Follow-ups and files

- Use `reply_to_chatgpt_conversation` with exactly one completed `job_id` or exact `conversation_url`, plus the new prompt. It inherits only that ChatGPT conversation. Track the new reply ID; never reply to an active job or switch to an arbitrary open chat. Same-chat replies serialize.
- Attach only exact files authorized for external upload. For repository bundles, attachment formats/limits, or generated-file recovery, read [files.md](references/files.md). A bundle is prepared locally; preparing it does not authorize uploading it.
- Generated outputs return local resource links. Inspect them before delivery; do not execute generated code/macros automatically. For incomplete downloads, use `collect_chatgpt_response_files` on the same job/URL; it never resubmits the prompt.
- For uncertain completion, lost local IDs, login trouble or browser inspection, read [recovery.md](references/recovery.md). Use `inspect_chatgpt_conversation` only when compact status or file recovery is insufficient.

## Setup and preferences

For first setup, ask which of the installer's own ChatGPT accounts has their paid plan and Pro access; use an account already identified without asking again. Check the live options with setup or `sync_chatgpt_options`. If Pro is absent, ask them to switch accounts or explicitly accept the available options (`--allow-no-pro` for the installer). A Chrome profile name or successful login does not establish Pro access; UI discovery does not verify billing. Never purchase or upgrade a plan during setup. List local profiles and ask which to use if ambiguous. Explicitly ask **“Where should new chats go: no project (recommended default), or a project in your ChatGPT account?”** If they choose a project, request its URL. Use a choice already supplied without asking again; otherwise wait for the answer. Do not infer it from a Codex folder or the maintainer.

Save with `configure_chatgpt_bridge`: `project_url: ""` clears the destination; a project URL sets it. Read back status to verify. Before plugin tools are loaded, follow the packaged `docs/CODEX_SETUP.md` and `docs/INSTALL.md` via the plugin root; the installer accepts `--no-project` or `--project-url URL`. Existing preferences survive updates. Do not repeat the setup question during ordinary jobs or automatic updates.

When signed out, call `open_chatgpt_for_login`; the user signs in/MFA and quits that dedicated Chrome instance with Command-Q before `sync_chatgpt_options`. A public guest composer is not authenticated. Use `force_rescan: true` for stale effort controls. The legacy `headless` setting means off-screen background Chrome, not true windowless Chrome.

Managed installs check stable GitHub releases automatically. Use `check_chatgpt_bridge_updates` or `update_chatgpt_bridge` when requested. New Codex tasks load updates; keep active jobs running. Read the installation guide for manual updates or rollback.
