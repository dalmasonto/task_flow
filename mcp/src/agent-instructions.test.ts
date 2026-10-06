import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_UPDATED_NOTICE,
  createInstructionsWatcher,
  instructionsStamp,
  renderInstructions,
} from "./agent-instructions.js";

const block = (markdown: string | null, updated_at: string | null) => ({ markdown, updated_at });

describe("renderInstructions", () => {
  it("returns null when neither block has text (or the backend predates them)", () => {
    expect(renderInstructions({})).toBeNull();
    expect(
      renderInstructions({ instructions: block(null, null), project_instructions: block("  \n", "t") }),
    ).toBeNull();
  });

  it("shows role before project, verbatim, with the precedence stated", () => {
    const text = renderInstructions({
      instructions: block("## Reviewer\nReview only.", "t1"),
      project_instructions: block("Use pnpm.", "t2"),
    })!;
    expect(text).toContain("## Reviewer\nReview only.");
    expect(text).toContain("Use pnpm.");
    expect(text.indexOf("Your role instructions")).toBeLessThan(text.indexOf("Project instructions"));
    expect(text).toMatch(/direct request/);
  });

  it("renders only the block that has text", () => {
    const text = renderInstructions({ project_instructions: block("Use pnpm.", "t2") })!;
    expect(text).not.toContain("Your role instructions");
    expect(text).toContain("Project instructions");
  });
});

describe("instructionsStamp", () => {
  it("changes when either updated_at changes, and only then", () => {
    const a = instructionsStamp({ instructions: block("x", "t1"), project_instructions: block(null, null) });
    expect(instructionsStamp({ instructions: block("x", "t2"), project_instructions: block(null, null) })).not.toBe(a);
    expect(instructionsStamp({ instructions: block("x", "t1"), project_instructions: block("p", "t9") })).not.toBe(a);
    expect(instructionsStamp({ instructions: block("y", "t1"), project_instructions: block(null, null) })).toBe(a);
  });
});

describe("createInstructionsWatcher", () => {
  it("treats the first observation as a baseline, not a change", () => {
    const watcher = createInstructionsWatcher();
    expect(watcher.observe({ instructions: block("x", "t1") })).toBe(false);
  });

  it("reports a change once, then settles", () => {
    const watcher = createInstructionsWatcher();
    watcher.observe({ instructions: block("x", "t1") });
    expect(watcher.observe({ instructions: block("x", "t2") })).toBe(true);
    expect(watcher.observe({ instructions: block("x", "t2") })).toBe(false);
  });
});

describe("INSTRUCTIONS_UPDATED_NOTICE", () => {
  it("is the exact pane line", () => {
    expect(INSTRUCTIONS_UPDATED_NOTICE).toBe(
      "[taskflow] your role/project instructions were updated — call whoami",
    );
  });
});
