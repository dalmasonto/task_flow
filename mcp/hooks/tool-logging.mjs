/**
 * Which tool calls are worth an activity row (#56).
 *
 * The PostToolUse hook logged every tool call. Measured on project 2: 5713
 * activity rows in 5 days (~1140/day), of which `tool:Bash` was 2728,
 * `tool:Edit` 707 and `tool:Read` 584. Roughly 70% was read-only exploration —
 * rows nobody reads back, but which every client paging the feed still carries,
 * and which crowd genuine notes out of view.
 *
 * The activity feed is a JOURNAL: what an agent did, for a human reconstructing
 * it later. "Read a file" is not that. "Edited a file", "changed a task status",
 * "sent a message" are.
 *
 * A SKIP list, not an allowlist: an unrecognised tool is more likely to matter
 * than not, and one extra row costs far less than silently losing something that
 * did. New tools default to being recorded.
 *
 * Deliberately dependency-free (like metadata.mjs) so the hook needs no build.
 */

/// Read-only or high-volume-low-signal. Bash is the largest single writer and
/// the most debatable entry: it is often meaningful (running tests, committing),
/// but at 2728 rows in five days it drowns the feed it is meant to inform. Move
/// it out of this list if the journal starts feeling too thin.
const SKIP_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
]);

/// #57: TaskFlow's own tools already write a SEMANTIC row from the backend —
/// `status_changed` carrying `#57 "title" · in_progress -> partial_done`, `note`
/// carrying the note itself. The hook's parallel row describes the same event
/// with strictly less: body "completed", no task link, the id buried in JSON.
///
/// Measured on project 2: 594 rows, 10% of the feed, 257 KB. The two worst are
/// pure duplication of content that exists in full elsewhere —
/// send_message (112 KB) embeds whole message bodies that ARE the message
/// table, log_activity (86 KB) embeds the note body of the row it just created.
///
/// Scoped to this prefix on purpose: another MCP server's tools are somebody
/// else's events, and nothing writes a semantic row for them.
const TASKFLOW_TOOL_PREFIX = "mcp__taskflow_v2__";

/**
 * Whether this tool call should be recorded as activity.
 *
 * @param {string | undefined | null} toolName
 * @returns {boolean}
 */
export function shouldLogTool(toolName) {
  if (!toolName) return false;
  if (toolName.startsWith(TASKFLOW_TOOL_PREFIX)) return false;
  // Exact match only — a tool merely CONTAINING "Read" is not the Read tool.
  return !SKIP_TOOLS.has(toolName);
}
