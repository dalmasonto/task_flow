import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs module, deliberately dependency-free for the hook
import { parsePermissionPrompt, isPermissionNotification } from "../hooks/permission-prompt.mjs";

/// The real screen from the bug report (#48), reproduced verbatim including the
/// selection caret and the footer.
const THREE_OPTION_SCREEN = `
Bash command

  gh issue list --state open --limit 30 2>&1 | head -50
  List open GitHub issues and remotes

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for: gh issue *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`;

const TWO_OPTION_SCREEN = `
Edit file

Do you want to proceed?
❯ 1. Yes
  2. No
`;

describe("isPermissionNotification", () => {
  // The two message shapes actually observed in taskflow_task_activity (206 rows).
  it("recognises the permission message", () => {
    expect(isPermissionNotification("Claude needs your permission")).toBe(true);
    expect(isPermissionNotification("Claude needs your permission to use Bash")).toBe(true);
  });

  it("ignores the idle-waiting message", () => {
    expect(isPermissionNotification("Claude is waiting for your input")).toBe(false);
  });

  it("ignores empty or missing messages", () => {
    expect(isPermissionNotification("")).toBe(false);
    expect(isPermissionNotification(undefined)).toBe(false);
  });
});

describe("parsePermissionPrompt", () => {
  it("parses the real three-option approval screen", () => {
    const parsed = parsePermissionPrompt(THREE_OPTION_SCREEN);
    expect(parsed).not.toBeNull();
    expect(parsed!.options).toEqual([
      { number: 1, label: "Yes" },
      { number: 2, label: "Yes, and don't ask again for: gh issue *" },
      { number: 3, label: "No" },
    ]);
  });

  // The digits are what get typed into a live terminal. "No" MUST be 3 here, not
  // 2 — collapsing this to a generic Yes/No would send "2" and silently pick
  // "don't ask again" for a command the human just denied.
  it("keeps the true option numbering rather than a generic yes/no", () => {
    const parsed = parsePermissionPrompt(THREE_OPTION_SCREEN);
    expect(parsed!.options.find((o) => o.label === "No")!.number).toBe(3);
  });

  it("carries the surrounding context so the dashboard shows what is being approved", () => {
    const parsed = parsePermissionPrompt(THREE_OPTION_SCREEN);
    expect(parsed!.question).toContain("gh issue list");
    expect(parsed!.question).toContain("Do you want to proceed?");
  });

  it("strips the selection caret from the first option", () => {
    const parsed = parsePermissionPrompt(TWO_OPTION_SCREEN);
    expect(parsed!.options[0]).toEqual({ number: 1, label: "Yes" });
  });

  it("parses a two-option screen", () => {
    expect(parsePermissionPrompt(TWO_OPTION_SCREEN)!.options).toHaveLength(2);
  });

  it("drops the footer line from the options", () => {
    const parsed = parsePermissionPrompt(THREE_OPTION_SCREEN);
    expect(parsed!.options.some((o) => o.label.includes("Esc to cancel"))).toBe(false);
  });

  // Scrollback: an older resolved prompt sits above the live one. Answering the
  // stale block's numbering would type into the wrong screen.
  it("uses the LAST prompt block when scrollback holds an earlier one", () => {
    const pane = `
Do you want to proceed?
  1. Yes
  2. No

... later output ...

Do you want to proceed?
❯ 1. Approve
  2. Approve for session
  3. Reject
`;
    const parsed = parsePermissionPrompt(pane);
    expect(parsed!.options.map((o) => o.label)).toEqual([
      "Approve",
      "Approve for session",
      "Reject",
    ]);
  });

  // --- Everything below must refuse to parse. A null result means the hook
  // --- reports a read-only notice and NEVER sends a keystroke.

  it("returns null with no proceed anchor", () => {
    expect(parsePermissionPrompt("just some terminal output\n1. Yes\n2. No")).toBeNull();
  });

  it("returns null when the numbering does not start at 1", () => {
    expect(parsePermissionPrompt("Do you want to proceed?\n  2. Yes\n  3. No")).toBeNull();
  });

  it("returns null when the numbering is not contiguous", () => {
    expect(parsePermissionPrompt("Do you want to proceed?\n  1. Yes\n  2. Maybe\n  4. No")).toBeNull();
  });

  it("returns null with fewer than two options", () => {
    expect(parsePermissionPrompt("Do you want to proceed?\n  1. Yes")).toBeNull();
  });

  it("returns null when no options follow the anchor", () => {
    expect(parsePermissionPrompt("Do you want to proceed?\n\nsomething else entirely")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parsePermissionPrompt("")).toBeNull();
  });
});
