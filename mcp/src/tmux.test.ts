import { describe, it, expect } from "vitest";
import { normalizeSnapshot } from "./tmux.js";

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
