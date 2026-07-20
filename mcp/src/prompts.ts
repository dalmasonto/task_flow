/**
 * Reading a dashboard-answered prompt back into keystrokes.
 *
 * `AskUserQuestion` accepts SEVERAL questions in one call. The agent's terminal
 * presents them one at a time — question 2's screen only exists once question 1
 * is answered — so a whole set is stored as ONE prompt row and replayed in order
 * only when every question has an answer. Replaying half a set would send the
 * remaining digits at whatever screen the agent had moved on to.
 *
 * Two on-the-wire shapes are supported, because rows written before
 * multi-question support are still in the table:
 *
 *   legacy  options_json = [{number, label}, ...]        one question
 *           answer_json  = [1, 3]                        one flat set
 *
 *   set     options_json = [{question, kind, options}]   N questions
 *           answer_json  = [[1], [2, 3]]                 one set per question
 *
 * A prompt that cannot be read yields NO keystrokes. An agent left waiting is
 * recoverable; digits fired into the wrong screen are not.
 */

import { answerKeystrokes } from "./events.js";

export interface PromptOption {
  number: number;
  label: string;
  description?: string;
}

export interface PromptQuestion {
  question: string;
  kind: string;
  options: PromptOption[];
}

function asOptions(value: unknown): PromptOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (o): o is PromptOption =>
      typeof o === "object" && o !== null && typeof (o as PromptOption).number === "number",
  );
}

/**
 * The questions a prompt is asking.
 *
 * `fallbackKind` and `fallbackQuestion` come from the row's own columns and are
 * used only for the legacy shape, which stored the question text and kind there
 * rather than inside the JSON.
 */
export function parseQuestions(
  optionsJson: string,
  fallbackKind: string,
  fallbackQuestion: string,
): PromptQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  // The discriminator is a nested `options` array: the set shape wraps each
  // question, the legacy shape IS the option list.
  const isSet = parsed.every(
    (entry) => typeof entry === "object" && entry !== null && "options" in entry,
  );

  if (!isSet) {
    const options = asOptions(parsed);
    return options.length ? [{ question: fallbackQuestion, kind: fallbackKind, options }] : [];
  }

  return parsed
    .map((entry) => {
      const e = entry as { question?: unknown; kind?: unknown; options?: unknown };
      return {
        question: typeof e.question === "string" ? e.question : fallbackQuestion,
        kind: typeof e.kind === "string" ? e.kind : "single",
        options: asOptions(e.options),
      };
    })
    .filter((q) => q.options.length > 0);
}

/**
 * The chosen numbers, one set per question.
 *
 * `answer` is the row's single-answer column, kept as a fallback for rows
 * answered before `answer_json` existed.
 */
export function parseAnswerSets(answerJson: string | null, answer: number | null): number[][] {
  const numeric = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];

  if (answerJson) {
    try {
      const parsed: unknown = JSON.parse(answerJson);
      if (Array.isArray(parsed)) {
        // `[[1],[2]]` is one set per question; `[1,3]` is a single flat set.
        return parsed.some(Array.isArray)
          ? parsed.map(numeric).filter((set) => set.length > 0)
          : [numeric(parsed)].filter((set) => set.length > 0);
      }
    } catch {
      // fall through to the single-answer column
    }
  }
  return typeof answer === "number" ? [[answer]] : [];
}

/** Whether every question in the set has at least one choice. */
export function isFullyAnswered(sets: number[][], questionCount: number): boolean {
  if (questionCount === 0) return false;
  if (sets.length !== questionCount) return false;
  return sets.every((set) => set.length > 0);
}

/** What the human chose to do with an answered prompt. */
export type PromptIntent = "submit" | "cancel";

/**
 * The review screen a MULTI-QUESTION set lands on once every question has been
 * answered:
 *
 *     Ready to submit your answers?
 *     > 1. Submit answers
 *       2. Cancel
 *
 * Verified against a live session on 2026-07-21. Without this stage the agent
 * answered all three questions and then sat on the review screen forever — the
 * questions were right, and nothing pressed the final key.
 *
 * A numbered choice, so it takes a number AND Enter, matching the single-select
 * behaviour confirmed the same day.
 */
const REVIEW_SUBMIT = ["1", "Enter"];
const REVIEW_CANCEL = ["2", "Enter"];

/**
 * The full keystroke sequence for an answered prompt, or `[]` when it must not
 * be replayed.
 *
 * Each question contributes its own sequence and they run back to back, in the
 * order the questions were asked — the terminal advances to the next question as
 * each is submitted. A set then confirms at the review screen.
 *
 * A SINGLE question has no review screen (it submits as soon as it is answered),
 * so nothing is appended — and there is no key that safely means "cancel", which
 * is why cancelling one sends nothing rather than guessing.
 */
export function keystrokesForPrompt(
  optionsJson: string,
  kind: string,
  question: string,
  answerJson: string | null,
  answer: number | null,
  intent: PromptIntent = "submit",
): string[] {
  const questions = parseQuestions(optionsJson, kind, question);
  const sets = parseAnswerSets(answerJson, answer);
  if (!isFullyAnswered(sets, questions.length)) return [];

  const hasReviewScreen = questions.length > 1;
  if (intent === "cancel" && !hasReviewScreen) return [];

  const answers = questions.flatMap((q, i) => answerKeystrokes(sets[i] ?? [], q.kind));
  if (!hasReviewScreen) return answers;
  // Cancel is reached the same way as submit: every answer is replayed first,
  // because the review screen only exists once the last question is answered.
  return [...answers, ...(intent === "cancel" ? REVIEW_CANCEL : REVIEW_SUBMIT)];
}
