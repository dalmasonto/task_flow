import { describe, it, expect } from "vitest";
import { parseQuestions, parseAnswerSets, keystrokesForPrompt, isFullyAnswered } from "./prompts.js";

const opt = (n: number, label: string) => ({ number: n, label });

/** The shape the hook wrote before multi-question support. */
const legacyOptions = JSON.stringify([opt(1, "Red"), opt(2, "Green")]);

/** The shape it writes now: a list of questions, each with its own options. */
const setOptions = JSON.stringify([
  { question: "Colour?", kind: "single", options: [opt(1, "Red"), opt(2, "Green")] },
  { question: "Checks?", kind: "multi", options: [opt(1, "Lint"), opt(2, "Types"), opt(3, "Tests")] },
]);

describe("parseQuestions", () => {
  // The hook wrote the old shape until today, and rows written before the change
  // are still in the table. Reading one must not throw or silently yield nothing
  // — an unanswerable prompt leaves the agent blocked forever.
  it("reads a legacy prompt as a single question", () => {
    const qs = parseQuestions(legacyOptions, "single", "Colour?");
    expect(qs).toHaveLength(1);
    expect(qs[0]?.question).toBe("Colour?");
    expect(qs[0]?.kind).toBe("single");
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["Red", "Green"]);
  });

  it("carries the legacy prompt's kind through", () => {
    expect(parseQuestions(legacyOptions, "multi", "Q")[0]?.kind).toBe("multi");
  });

  it("reads every question in a set", () => {
    const qs = parseQuestions(setOptions, "set", "Colour?");
    expect(qs.map((q) => q.question)).toEqual(["Colour?", "Checks?"]);
    expect(qs.map((q) => q.kind)).toEqual(["single", "multi"]);
    expect(qs[1]?.options).toHaveLength(3);
  });

  it("returns nothing for junk rather than throwing at the stream", () => {
    expect(parseQuestions("{not json", "single", "Q")).toEqual([]);
    expect(parseQuestions("[]", "single", "Q")).toEqual([]);
    expect(parseQuestions("null", "single", "Q")).toEqual([]);
  });
});

describe("parseAnswerSets", () => {
  it("reads a legacy flat answer as one set", () => {
    expect(parseAnswerSets("[1,3]", 1)).toEqual([[1, 3]]);
  });

  it("falls back to the single answer column when there is no json", () => {
    expect(parseAnswerSets(null, 2)).toEqual([[2]]);
  });

  it("reads one set per question", () => {
    expect(parseAnswerSets("[[1],[2,3]]", null)).toEqual([[1], [2, 3]]);
  });

  it("survives malformed json instead of firing keys blindly", () => {
    expect(parseAnswerSets("{oops", 2)).toEqual([[2]]);
    expect(parseAnswerSets("{oops", null)).toEqual([]);
  });

  it("drops non-numeric entries", () => {
    expect(parseAnswerSets('[["x",1],[2]]', null)).toEqual([[1], [2]]);
  });
});

describe("isFullyAnswered", () => {
  // The terminal shows questions ONE AT A TIME. Replaying a partial set sends
  // question 2's digits at question 2's screen — but question 3's digits land
  // wherever the agent happens to be, which could be a confirmation dialog.
  it("is false while any question is unanswered", () => {
    expect(isFullyAnswered([[1]], 2)).toBe(false);
    expect(isFullyAnswered([[1], []], 2)).toBe(false);
  });

  it("is true once every question has a choice", () => {
    expect(isFullyAnswered([[1], [2, 3]], 2)).toBe(true);
  });

  it("is false when there are no questions at all", () => {
    expect(isFullyAnswered([], 0)).toBe(false);
  });
});

describe("keystrokesForPrompt", () => {
  it("answers a legacy single-select with the number and a submit", () => {
    expect(keystrokesForPrompt(legacyOptions, "single", "Q", "[2]", 2)).toEqual(["2", "Enter"]);
  });

  // Each question is a separate screen, so the sequences run back to back in the
  // order the questions were asked. Getting the order wrong answers the right
  // question with the wrong number.
  //
  // A SET then lands on a review screen ("Ready to submit your answers?" —
  // 1. Submit answers / 2. Cancel), verified from a live session 2026-07-21.
  // Without that final stage the agent answered every question and then sat on
  // the review screen forever.
  it("answers a set in question order, then submits at the review screen", () => {
    expect(keystrokesForPrompt(setOptions, "set", "Q", "[[2],[1,3]]", null)).toEqual([
      "2",
      "Enter",
      "1",
      "3",
      "Right",
      "1",
      "1",
      "Enter",
    ]);
  });

  // A single question submits on its own — no review screen, as verified when
  // ["3","Enter"] resumed the agent. Appending a review submit here would send a
  // stray "1" at whatever came next.
  it("does not add a review stage to a single question", () => {
    expect(keystrokesForPrompt(legacyOptions, "single", "Q", "[2]", 2)).toEqual(["2", "Enter"]);
  });

  // Cancel is the OTHER option on that same review screen, so it replays every
  // answer first and only then chooses 2. Sending "2" before the review screen
  // exists would pick option 2 of whichever question is on screen.
  it("cancels at the review screen after replaying the answers", () => {
    expect(keystrokesForPrompt(setOptions, "set", "Q", "[[2],[1,3]]", null, "cancel")).toEqual([
      "2",
      "Enter",
      "1",
      "3",
      "Right",
      "1",
      "2",
      "Enter",
    ]);
  });

  // There is no review screen for one question, so there is no cancel key that
  // could be pressed safely — better to send nothing than to guess.
  it("sends nothing when asked to cancel a single question", () => {
    expect(keystrokesForPrompt(legacyOptions, "single", "Q", "[2]", 2, "cancel")).toEqual([]);
  });

  // Half a set is worse than none: the leftover digits land on whatever screen
  // the agent has moved on to.
  it("sends nothing for a partially answered set", () => {
    expect(keystrokesForPrompt(setOptions, "set", "Q", "[[2]]", null)).toEqual([]);
  });

  it("sends nothing when nothing was chosen", () => {
    expect(keystrokesForPrompt(setOptions, "set", "Q", "[[],[]]", null)).toEqual([]);
    expect(keystrokesForPrompt(legacyOptions, "single", "Q", null, null)).toEqual([]);
  });

  it("sends nothing when the options cannot be read", () => {
    expect(keystrokesForPrompt("{bad", "single", "Q", "[1]", 1)).toEqual([]);
  });
});
