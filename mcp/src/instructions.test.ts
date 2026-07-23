import { describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS } from "./instructions.js";

describe("AGENT_INSTRUCTIONS", () => {
  it("names the core tools an agent needs on connect", () => {
    for (const tool of [
      "whoami",
      "register_session",
      "heartbeat",
      "check_messages",
      "mark_read",
      "send_message",
      "download_attachment",
      "list_tasks",
      "claim_task",
      "update_task_status",
      "report_review",
      "log_activity",
    ]) {
      expect(AGENT_INSTRUCTIONS, `should mention ${tool}`).toContain(tool);
    }
  });

  it("teaches the file-attachment affordance that was being missed", () => {
    expect(AGENT_INSTRUCTIONS).toContain("files");
    expect(AGENT_INSTRUCTIONS.toLowerCase()).toContain("inline");
  });

  it("documents the DO NOT ACT convention and the review lifecycle", () => {
    expect(AGENT_INSTRUCTIONS).toContain("DO NOT ACT");
    expect(AGENT_INSTRUCTIONS).toContain("partial_done");
  });

  it("explains what TaskFlow is and its multi-agent nature", () => {
    expect(AGENT_INSTRUCTIONS).toContain("TaskFlow is");
    expect(AGENT_INSTRUCTIONS.toLowerCase()).toContain("local-first");
    expect(AGENT_INSTRUCTIONS.toLowerCase()).toContain("multi-agent");
  });

  it("is substantial enough to be a real guide", () => {
    expect(AGENT_INSTRUCTIONS.length).toBeGreaterThan(500);
  });

  // #54: a GitHub issue written as a bare `#12` renders as a TaskFlow task chip
  // and clicks through to a task that does not exist. Agents write most of the
  // messages in a project, so the convention has to reach them here.
  it("teaches the #gh<n> convention for GitHub issues", () => {
    expect(AGENT_INSTRUCTIONS).toContain("#gh");
  });

  it("warns against writing a bare #<n> for a GitHub issue", () => {
    const lower = AGENT_INSTRUCTIONS.toLowerCase();
    expect(lower).toContain("github issue");
    // It must state the consequence, not just the rule.
    expect(lower).toMatch(/task chip|as a task|taskflow task/);
  });
});
