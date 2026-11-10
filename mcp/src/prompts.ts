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
  isOther?: boolean;
}

export type KeyStep = { key: string } | { text: string };

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
 * A single SINGLE-select question has no review screen (it submits as soon as it
 * is answered), so nothing is appended and there is no safe "cancel" key. A
 * single MULTI-select question DOES reach the review screen, so it gets the
 * submit/cancel like a set does.
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

  // The review screen appears for a question SET *and* for a single
  // multi-select question — both end on "Ready to submit your answers?".
  // Gating only on question count (as it did) left a lone multi-select stuck on
  // that screen with nothing to press it. Verified live 2026-07-21.
  const hasReviewScreen = questions.length > 1 || questions.some((q) => q.kind === "multi");
  if (intent === "cancel" && !hasReviewScreen) return [];

  const answers = questions.flatMap((q, i) => answerKeystrokes(sets[i] ?? [], q.kind));
  if (!hasReviewScreen) return answers;
  // Cancel is reached the same way as submit: every answer is replayed first,
  // because the review screen only exists once the last question is answered.
  return [...answers, ...(intent === "cancel" ? REVIEW_CANCEL : REVIEW_SUBMIT)];
}

/** The Other free-text value per question, parallel to the answer sets. */
export function parseAnswerTexts(answerTextJson: string | null, count: number): (string | null)[] {
  if (!answerTextJson) return Array(count).fill(null);
  try {
    const parsed: unknown = JSON.parse(answerTextJson);
    if (Array.isArray(parsed)) {
      return Array.from({ length: count }, (_, i) =>
        typeof parsed[i] === "string" ? (parsed[i] as string) : null,
      );
    }
  } catch { /* fall through */ }
  return Array(count).fill(null);
}

/**
 * The full ordered steps for an answered prompt. Without any Other text this is
 * `keystrokesForPrompt` wrapped as `{key}` steps. With Other text on a single
 * multi-select question, it walks the arrow-based flow the new TUI uses (see the
 * hypothesis in the test — verified live before this ships).
 */
export function stepsForPrompt(
  optionsJson: string,
  kind: string,
  question: string,
  answerJson: string | null,
  answer: number | null,
  answerTextJson: string | null,
  intent: PromptIntent = "submit",
): KeyStep[] {
  const questions = parseQuestions(optionsJson, kind, question);
  const sets = parseAnswerSets(answerJson, answer);
  const texts = parseAnswerTexts(answerTextJson, questions.length);

  // Only the scoped case gets the Other flow: one multi-select question whose
  // Other option was picked with text. Everything else uses the proven path.
  const single = questions.length === 1 ? questions[0] : undefined;
  const other = single?.options.find((o) => o.isOther);
  const otherPicked =
    other && sets[0]?.includes(other.number) && (texts[0] ?? "").length > 0;

  if (!otherPicked || intent === "cancel") {
    return keystrokesForPrompt(optionsJson, kind, question, answerJson, answer, intent)
      .map((key) => ({ key }));
  }

  const otherIndex = single!.options.findIndex((o) => o.isOther);

  // SINGLE-select Other (#30): one answer, no toggles, no review screen. Arrow
  // down from the caret on option 1 to the "Type something" row, type the text
  // (which fills the field), and Enter submits it — single-select commits on
  // Enter, unlike multi-select where Enter only toggles. HYPOTHESIS, verified
  // live before shipping (the choreography is the one thing tests can't prove).
  if (single!.kind !== "multi") {
    const singleSteps: KeyStep[] = [];
    for (let i = 0; i < otherIndex; i++) singleSteps.push({ key: "Down" });
    singleSteps.push({ text: texts[0]! });
    singleSteps.push({ key: "Enter" });
    return singleSteps;
  }

  const steps: KeyStep[] = [];
  // Walk down the list from the caret's start on option 1, toggling picks.
  for (let i = 0; i < single!.options.length; i++) {
    const opt = single!.options[i]!;
    if (opt.isOther) {
      // Typing (which send-keys -l mimics) AUTO-CHECKS the Other option, and
      // Enter merely TOGGLES it — so NO Enter here, or it would deselect the box
      // the paste just checked. Verified live 2026-07-21: with an Enter, Other
      // came back unchecked and dropped from the answer.
      steps.push({ text: texts[0]! });
    } else if (sets[0]!.includes(opt.number)) {
      steps.push({ key: "Enter" }); // toggle this pick
    }
    if (i < single!.options.length - 1) steps.push({ key: "Down" });
  }
  steps.push({ key: "Down" }, { key: "Enter" }); // to Submit, activate -> review
  steps.push({ key: "1" }, { key: "Enter" });    // Submit answers
  return steps;
}

// ---------------------------------------------------------------------------
// #1034: a SCREEN-GATED replay plan.
//
// `stepsForPrompt` is one flat key list, sent with fixed pauses. Nothing checked
// that question 2's screen was actually showing before its digit went in, so a
// slow re-render let "2 Enter" land on question 1 (or on the composer once the
// tool had returned): the "separate 1, 2, 3 in the pane" bug. A plan is the same
// keys split per screen, each segment tagged with text that must be ON the pane
// before it is sent. The executor (`sendPlannedSteps`) waits for it and stops
// typing, for good, the moment a screen doesn't match. An agent left waiting is
// recoverable; stray digits are not.
// ---------------------------------------------------------------------------

/** One screen's worth of keys, and the text that proves that screen is up. */
export interface PlanSegment {
  /** Text that must be visible on the pane before `steps` are sent. */
  expect: string;
  steps: KeyStep[];
}

/** The review screen a set (or a lone multi-select) ends on. */
export const REVIEW_SCREEN_TEXT = "Ready to submit your answers?";

/**
 * Keys for ONE question, including a free-text Other pick.
 *
 * `last` says whether this question is the only/final one; a multi-select
 * always advances with Right (to the next question or to the review screen),
 * except when an Other text field holds focus, where Right would only move the
 * text cursor, so it walks Down to the Submit/Next row and presses Enter.
 */
function questionSteps(q: PromptQuestion, set: number[], text: string | null): KeyStep[] {
  const other = q.options.find((o) => o.isOther);
  const otherPicked = other != null && set.includes(other.number) && (text ?? "").length > 0;
  if (!otherPicked) return answerKeystrokes(set, q.kind).map((key) => ({ key }));

  const otherIndex = q.options.findIndex((o) => o.isOther);
  if (q.kind !== "multi") {
    // Single-select Other: arrow to the "Type something" row, type, Enter commits.
    const steps: KeyStep[] = [];
    for (let i = 0; i < otherIndex; i++) steps.push({ key: "Down" });
    steps.push({ text: text! }, { key: "Enter" });
    return steps;
  }
  // Multi-select Other: walk the list toggling picks; typing auto-checks Other
  // (an Enter there would UN-check it, verified live 2026-07-21).
  const steps: KeyStep[] = [];
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i]!;
    if (opt.isOther) steps.push({ text: text! });
    else if (set.includes(opt.number)) steps.push({ key: "Enter" });
    if (i < q.options.length - 1) steps.push({ key: "Down" });
  }
  steps.push({ key: "Down" }, { key: "Enter" });
  return steps;
}

/**
 * The replay plan for an answered prompt, or `[]` when it must not be replayed
 * (half-answered, unreadable, or a cancel with no review screen to cancel on).
 */
export function planForPrompt(
  optionsJson: string,
  kind: string,
  question: string,
  answerJson: string | null,
  answer: number | null,
  answerTextJson: string | null,
  intent: PromptIntent = "submit",
): PlanSegment[] {
  const questions = parseQuestions(optionsJson, kind, question);
  const sets = parseAnswerSets(answerJson, answer);
  if (!isFullyAnswered(sets, questions.length)) return [];
  const texts = parseAnswerTexts(answerTextJson, questions.length);
  const hasReviewScreen = questions.length > 1 || questions.some((q) => q.kind === "multi");
  if (intent === "cancel" && !hasReviewScreen) return [];

  const plan: PlanSegment[] = questions.map((q, i) => ({
    expect: q.question,
    // A cancel still answers every question to REACH the review screen, but
    // without Other text: what is typed there is about to be thrown away.
    steps: questionSteps(q, sets[i]!, intent === "cancel" ? null : texts[i] ?? null),
  }));
  if (hasReviewScreen) {
    plan.push({
      expect: REVIEW_SCREEN_TEXT,
      steps: (intent === "cancel" ? REVIEW_CANCEL : REVIEW_SUBMIT).map((key) => ({ key })),
    });
  }
  return plan;
}

/**
 * Whether `expect` is on `screen`. Both sides are whitespace-collapsed (the TUI
 * wraps long questions over several lines) and only the first 48 characters of
 * the expected text are required (a long question can be cut off on a short
 * pane). Box-drawing and other decoration never sits inside question text.
 */
export function screenShows(screen: string, expect: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(expect).slice(0, 48);
  if (!want) return false;
  return norm(screen).includes(want);
}
