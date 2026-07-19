import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs module, deliberately dependency-free for the hook
import { compactMetadata, META_MAX_CHARS } from "../hooks/metadata.mjs";

const parses = (text: string) => {
  expect(() => JSON.parse(text)).not.toThrow();
  return JSON.parse(text);
};

describe("compactMetadata", () => {
  it("records a normal payload verbatim", () => {
    const input = { input: { command: "ls -la", description: "list files" } };
    expect(parses(compactMetadata(input))).toEqual(input);
  });

  // The bug this exists for: slicing JSON mid-token produced output that could
  // not be parsed at all, so a recorded question's options were unrecoverable
  // even though most of the payload was present.
  it("ALWAYS produces parseable JSON, however big the input", () => {
    for (const size of [10_000, 100_000, 1_000_000]) {
      const out = compactMetadata({ input: { content: "x".repeat(size) } });
      const parsed = parses(out);
      expect(out.length).toBeLessThanOrEqual(META_MAX_CHARS);
      expect(typeof parsed.input.content).toBe("string");
    }
  });

  it("keeps the object SHAPE when shortening, so you can still see the call", () => {
    const parsed = parses(
      compactMetadata({ input: { file_path: "/src/app.ts", content: "y".repeat(80_000) } }),
    );
    expect(parsed.input.file_path).toBe("/src/app.ts");
    expect(parsed.input.content).toContain("…[+");
  });

  it("says how much was elided rather than silently dropping it", () => {
    const parsed = parses(compactMetadata({ a: "z".repeat(60_000) }));
    expect(parsed.a).toMatch(/…\[\+\d+ chars\]$/);
  });

  // A real AskUserQuestion payload — the case that was being cut at 1500.
  it("keeps a full multi-option question intact", () => {
    const payload = {
      input: {
        questions: [
          {
            question: "Where should this land?",
            header: "Branch",
            multiSelect: false,
            options: [
              { label: "Feature branch", description: "d".repeat(400), preview: "p".repeat(400) },
              { label: "Directly on main", description: "d".repeat(400), preview: "p".repeat(400) },
              { label: "Worktree", description: "d".repeat(400), preview: "p".repeat(400) },
            ],
          },
        ],
      },
    };
    const parsed = parses(compactMetadata(payload));
    expect(parsed.input.questions[0].options).toHaveLength(3);
    expect(parsed.input.questions[0].options[2].label).toBe("Worktree");
    // Nothing was shortened: this is comfortably inside the budget now.
    expect(parsed).toEqual(payload);
  });

  it("survives a value it cannot serialize", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(compactMetadata(circular)).toBeUndefined();
  });

  it("returns undefined for nothing", () => {
    expect(compactMetadata(null)).toBeUndefined();
    expect(compactMetadata(undefined)).toBeUndefined();
  });

  it("keeps an enormous array valid by outlining it", () => {
    const out = compactMetadata({ items: Array.from({ length: 200_000 }, (_, i) => i) });
    const parsed = parses(out);
    expect(out.length).toBeLessThanOrEqual(META_MAX_CHARS);
    expect(parsed).toBeTruthy();
  });
});
