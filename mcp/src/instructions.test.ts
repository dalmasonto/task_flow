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

  it("is substantial enough to be a real guide", () => {
    expect(AGENT_INSTRUCTIONS.length).toBeGreaterThan(500);
  });
});
