import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs module, deliberately dependency-free for the hook
import { compactMetadata, BULK_FIELD_MAX_CHARS } from "../hooks/metadata.mjs";

const parses = (text: string) => {
  expect(() => JSON.parse(text)).not.toThrow();
  return JSON.parse(text);
};

describe("compactMetadata", () => {
  it("records a payload verbatim when nothing is oversized", () => {
    const input = { input: { command: "ls -la", description: "list files" } };
    expect(parses(compactMetadata(input, "Bash"))).toEqual(input);
  });

  // The rule: a tool call is a structure. Capping the payload as a whole would
  // drop the fields that say WHICH call it was.
  it("caps only the bulk field and keeps every other field whole", () => {
    const parsed = parses(
      compactMetadata(
        { input: { file_path: "/src/App.tsx", content: "x".repeat(500_000) } },
        "Write",
      ),
    );
    expect(parsed.input.file_path).toBe("/src/App.tsx");
    expect(parsed.input.content).toMatch(/…\[\+\d+ chars\]$/);
    expect(parsed.input.content.length).toBeGreaterThan(BULK_FIELD_MAX_CHARS);
  });

  it("keeps a Bash description even when the command is enormous", () => {
    const parsed = parses(
      compactMetadata(
        { input: { command: "y".repeat(200_000), description: "run the migration", timeout: 600000 } },
        "Bash",
      ),
    );
    expect(parsed.input.description).toBe("run the migration");
    expect(parsed.input.timeout).toBe(600000);
    expect(parsed.input.command).toContain("…[+");
  });

  it("caps both sides of an Edit", () => {
    const parsed = parses(
      compactMetadata(
        { input: { file_path: "/a.ts", old_string: "a".repeat(50_000), new_string: "b".repeat(50_000), replace_all: false } },
        "Edit",
      ),
    );
    expect(parsed.input.file_path).toBe("/a.ts");
    expect(parsed.input.replace_all).toBe(false);
    expect(parsed.input.old_string).toContain("…[+");
    expect(parsed.input.new_string).toContain("…[+");
  });

  // MultiEdit nests its strings in an array — a top-level-only pass would miss
  // them and let a huge payload through unshortened.
  it("reaches bulk fields nested inside arrays", () => {
    const parsed = parses(
      compactMetadata(
        { input: { file_path: "/a.ts", edits: [{ old_string: "q".repeat(60_000), new_string: "r" }] } },
        "Edit",
      ),
    );
    expect(parsed.input.edits[0].old_string).toContain("…[+");
    expect(parsed.input.edits[0].new_string).toBe("r");
  });

  // The whole point of the rewrite: no global budget. A big AskUserQuestion is
  // recorded in full, because none of its fields are bulk carriers.
  it("does NOT shorten a tool with no bulk field, however long", () => {
    const payload = {
      input: {
        questions: [
          {
            question: "Where should this land?",
            multiSelect: false,
            options: Array.from({ length: 4 }, (_, i) => ({
              label: `Option ${i}`,
              description: "d".repeat(5_000),
              preview: "p".repeat(5_000),
            })),
          },
        ],
      },
    };
    const out = compactMetadata(payload, "AskUserQuestion");
    expect(parses(out)).toEqual(payload);
    expect(out.length).toBeGreaterThan(40_000);
  });

  it("records an unknown tool verbatim rather than guessing its big field", () => {
    const payload = { input: { anything: "z".repeat(100_000) } };
    expect(parses(compactMetadata(payload, "SomeFutureTool"))).toEqual(payload);
  });

  it("says how much was elided instead of dropping it silently", () => {
    const parsed = parses(compactMetadata({ input: { content: "z".repeat(60_000) } }, "Write"));
    expect(parsed.input.content).toMatch(/…\[\+40000 chars\]$/);
  });

  // A crashed hook is a crashed tool call, so a cycle must not blow the stack.
  // It is marked and the rest is still recorded.
  it("survives a circular payload instead of crashing the hook", () => {
    const circular: Record<string, unknown> = { input: { command: "ls" } };
    circular.self = circular;
    const parsed = parses(compactMetadata(circular, "Bash"));
    expect(parsed.input.command).toBe("ls");
    expect(parsed.self).toBe("[circular]");
  });

  it("still returns undefined when a value cannot be serialized at all", () => {
    // BigInt makes JSON.stringify throw outright.
    expect(compactMetadata({ input: { n: BigInt(1) } })).toBeUndefined();
  });

  it("returns undefined for nothing", () => {
    expect(compactMetadata(null, "Bash")).toBeUndefined();
    expect(compactMetadata(undefined)).toBeUndefined();
  });
});
