/** Parsing task references out of message/markdown text so they can be rendered
 *  as clickable chips that open the task sheet. Matches `TASK#10`, `task#10`, and
 *  a bare `#10` — all in ONE left-to-right pass. */

export type TaskRefSegment =
  | { type: "text"; value: string }
  | { type: "task"; id: number; raw: string }

// One combined pattern, scanned left-to-right, so matches come out in order and
// the raw text ("TASK#10" vs "#10") is preserved. A separate regex per form —
// each with its own /g lastIndex — interleaves matches out of order and breaks
// the segmentation. `task#` is covered by the case-insensitive `TASK#`
// alternative; the prefix is non-capturing so group 1 is always the number.
const TASK_REF = /(?:TASK#|#)(\d+)/gi

/**
 * Split a run of text into plain-text and task-reference segments. `TASK#10` (or
 * `#10`) becomes a `task` segment carrying the numeric id (and the raw matched
 * text for the chip label); everything else stays text. Returns a single text
 * segment for input with no references, and an empty array for empty input.
 */
export function splitTaskRefs(text: string): TaskRefSegment[] {
  const segments: TaskRefSegment[] = []
  let last = 0
  // A fresh lastIndex each call — the regex is module-level with the /g flag.
  TASK_REF.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TASK_REF.exec(text))) {
    if (match.index > last) segments.push({ type: "text", value: text.slice(last, match.index) })
    segments.push({ type: "task", id: Number(match[1]), raw: match[0] })
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
