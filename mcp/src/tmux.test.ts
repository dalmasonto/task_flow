import { describe, it, expect } from "vitest";
import { normalizeSnapshot, sanitizeForPane, buildNotice } from "./tmux.js";

describe("normalizeSnapshot", () => {
  // A TUI pads the screen to its full height. Keeping that padding would make
  // every capture differ on cursor movement alone, defeating the change-detection
  // that keeps an idle agent from writing a frame every tick.
  it("drops trailing blank lines so an idle screen compares equal", () => {
    const a = normalizeSnapshot("$ ls\nfile.txt\n\n\n\n");
    const b = normalizeSnapshot("$ ls\nfile.txt\n\n");
    expect(a).toBe("$ ls\nfile.txt");
    expect(a).toBe(b);
  });

  it("keeps interior blank lines", () => {
    expect(normalizeSnapshot("a\n\nb\n")).toBe("a\n\nb");
  });

  it("keeps the TAIL when oversized — the bottom is the live part", () => {
    const out = normalizeSnapshot("old-content\n" + "x".repeat(50) + "NEWEST", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("NEWEST")).toBe(true);
    expect(out).not.toContain("old-content");
  });

  it("leaves a normal screen untouched", () => {
    expect(normalizeSnapshot("bash-5.1$ echo hi\nhi", 1000)).toBe("bash-5.1$ echo hi\nhi");
  });
});

describe("sanitizeForPane", () => {
  // The whole point: a newline would SUBMIT the agent's prompt early, turning a
  // notice into an unintended instruction. Nothing typed into a live pane may
  // carry control characters.
  it("strips newlines and carriage returns", () => {
    expect(sanitizeForPane("hello\nworld\r\nagain")).toBe("hello world again");
  });

  it("strips ESC so a notice cannot rewrite the pane", () => {
    expect(sanitizeForPane("safe\u001b[2Jwiped")).toBe("safe wiped");
  });

  it("strips C1 controls and DEL too", () => {
    expect(sanitizeForPane("a\u0000b\u007fc\u009dd")).toBe("a b c d");
  });

  it("truncates so a huge body cannot flood the prompt", () => {
    const out = sanitizeForPane("x".repeat(500), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});

describe("buildNotice", () => {
  // Composed locally from COUNTS. If message bodies ever leaked in here, a
  // channel post would become a way to type arbitrary text into a live agent.
  it("carries counts and the mark_read instruction, never message content", () => {
    const notice = buildNotice(3, 2);
    expect(notice).toContain("3 unread messages");
    expect(notice).toContain("2 channels");
    expect(notice).toContain("mark_read");
  });

  it("reads naturally for a single message in one channel", () => {
    expect(buildNotice(1, 1)).toContain("1 unread message in a channel");
  });

  it("is always a single line", () => {
    expect(buildNotice(9, 4)).not.toMatch(/[\r\n]/);
  });
});
