export function buildDelegationPrompt({ task, context, deliverable, attachments = [] }) {
  if (!task || !String(task).trim()) {
    throw new Error("A non-empty delegated task is required.");
  }
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  return [
    String(task).trim(),
    context && String(context).trim()
      ? `Relevant context:\n${String(context).trim()}`
      : null,
    deliverable && String(deliverable).trim()
      ? `Requested deliverable:\n${String(deliverable).trim()}`
      : null,
    hasAttachments
      ? "You have no access to the Codex conversation, active project, repository, terminal output, computer, private state, other workers, or any local files except the exact files attached to this message. Work only from this prompt, those explicit attachments, and general information; do not imply that you inspected anything else. Being filed in a ChatGPT project is organizational only and provides no Codex task context. Identify uncertainty and distinguish facts from recommendations."
      : "You have no access to the Codex conversation, active project, repository, files, code, terminal output, computer, private state, or other workers. Work only from this prompt and general information; do not imply that you inspected unavailable context. Being filed in a ChatGPT project is organizational only and provides no Codex task context. Identify uncertainty and distinguish facts from recommendations.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
