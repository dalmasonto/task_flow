/** Parsing references out of message/markdown text so they can be rendered as
 *  clickable chips. Matches `TASK#10`, `task#10` and a bare `#10` as TaskFlow
 *  tasks, and `#gh10` / `#GH10` as GitHub issues — all in ONE left-to-right
 *  pass. */

export type TaskRefSegment =
  | { type: "text"; value: string }
  | { type: "task"; id: number; raw: string }
  /// #54: an issue on the project's linked GitHub repo. Written `#gh12` so it is
  /// distinguishable from a task — a bare `#12` meaning a GitHub issue used to
  /// render as a task chip and click through to a task that does not exist.
  | { type: "github"; issue: number; raw: string }
  /// A message in this project's chat. Written `#msg12` for the same reason
  /// `#gh12` exists: a bare `#12` is read as a task, so an unqualified message
  /// reference points confidently at the wrong thing.
  | { type: "message"; message: number; raw: string }

// One combined pattern, scanned left-to-right, so matches come out in order and
// the raw text ("TASK#10" vs "#10") is preserved. A separate regex per form —
// each with its own /g lastIndex — interleaves matches out of order and breaks
// the segmentation. `task#` is covered by the case-insensitive `TASK#`
// alternative.
//
// ALTERNATION ORDER IS LOAD-BEARING: `#gh` must be tried before the bare `#`.
// With `#` first, `#gh12` would match `#` and then fail on `g`, and the reference
// would silently fall through as plain text. Group 1 is the prefix (which form
// matched), group 2 is always the number.
const TASK_REF = /(TASK#|#gh|#msg|#)(\d+)/gi

/**
 * Split a run of text into plain-text and reference segments. `TASK#10` (or
 * `#10`) becomes a `task` segment and `#gh10` a `github` segment, each carrying
 * the number and the raw matched text for the chip label; everything else stays
 * text. Returns a single text segment for input with no references, and an empty
 * array for empty input.
 */
export function splitTaskRefs(text: string): TaskRefSegment[] {
  const segments: TaskRefSegment[] = []
  let last = 0
  // A fresh lastIndex each call — the regex is module-level with the /g flag.
  TASK_REF.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TASK_REF.exec(text))) {
    if (match.index > last) segments.push({ type: "text", value: text.slice(last, match.index) })
    const prefix = match[1].toLowerCase()
    segments.push(
      prefix === "#gh"
        ? { type: "github", issue: Number(match[2]), raw: match[0] }
        : prefix === "#msg"
          ? { type: "message", message: Number(match[2]), raw: match[0] }
          : { type: "task", id: Number(match[2]), raw: match[0] },
    )
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) })
  return segments
}

/** Does this string contain at least one task reference? */
export function hasTaskRef(text: string): boolean {
  TASK_REF.lastIndex = 0
  return TASK_REF.test(text)
}
