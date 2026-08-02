import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs module, deliberately dependency-free for the hook
import { shouldLogTool } from "../hooks/tool-logging.mjs";

/// #56: the PostToolUse hook logged EVERY tool call. Measured on project 2:
/// 5713 activity rows in 5 days (~1140/day), of which `tool:Bash` was 2728,
/// `tool:Edit` 707 and `tool:Read` 584 — roughly 70% read-only exploration that
/// nobody reads back, but which every client paging the feed still has to carry.
describe("shouldLogTool", () => {
  it("skips read-only exploration tools", () => {
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookRead", "TodoWrite"]) {
      expect(shouldLogTool(tool), `${tool} should be skipped`).toBe(false);
    }
  });

  it("skips Bash, the single largest writer", () => {
    expect(shouldLogTool("Bash")).toBe(false);
  });

  // What survives is what CHANGED something — the journal a human reads back to
  // reconstruct what an agent actually did.
  it("logs tools that modify files", () => {
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      expect(shouldLogTool(tool), `${tool} should be logged`).toBe(true);
    }
  });

  // #57: TaskFlow's own tools write a SEMANTIC row already — `status_changed`
  // carrying `#57 "title" · in_progress -> partial_done`, `note` carrying the
  // note. The hook's parallel `tool:mcp__taskflow_v2__*` row describes the same
  // event with strictly less: body "completed", no task link, the id buried in
  // JSON. Measured on project 2: 594 rows, 10% of the feed, 257 KB — and
  // send_message (112 KB) / log_activity (86 KB) embed whole message and note
  // bodies that already exist in full as their own rows.
  it("skips TaskFlow's own tools, which already write a better row", () => {
    for (const tool of [
      "mcp__taskflow__update_task_status",
      "mcp__taskflow__send_message",
      "mcp__taskflow__log_activity",
      "mcp__taskflow__create_task",
      "mcp__taskflow__claim_task",
      "mcp__taskflow__heartbeat",
      // configs written before the 2.0.0 rename keep the old server key
      "mcp__taskflow_v2__update_task_status",
      "mcp__taskflow_v2__send_message",
    ]) {
      expect(shouldLogTool(tool), `${tool} should be skipped`).toBe(false);
    }
  });

  // Prefix-scoped: another MCP server's tools are somebody else's events, and
  // nothing else writes a semantic row for them.
  it("still logs MCP tools from other servers", () => {
    expect(shouldLogTool("mcp__gitnexus__analyze")).toBe(true);
    expect(shouldLogTool("mcp__some_other__thing")).toBe(true);
  });

  // An unfamiliar tool is more likely to matter than not, and one extra row is
  // trivial next to missing something that did. The skip list is explicit so the
  // default stays "record it".
  it("logs an unrecognised tool rather than silently dropping it", () => {
    expect(shouldLogTool("SomeToolNobodyHasSeenYet")).toBe(true);
  });

  it("does not log a missing tool name", () => {
    expect(shouldLogTool("")).toBe(false);
    expect(shouldLogTool(undefined)).toBe(false);
  });

  // Skips are exact, not substring: a tool merely CONTAINING "Read" still counts.
  it("matches skipped names exactly", () => {
    expect(shouldLogTool("ReadTheDocsPublisher")).toBe(true);
    expect(shouldLogTool("BashCommandBuilder")).toBe(true);
  });
});
