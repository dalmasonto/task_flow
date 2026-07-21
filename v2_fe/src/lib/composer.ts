/** Small pure helpers for the message composer. */

/**
 * Splice `insert` into `value` over the `[start, end)` selection, returning the
 * new value and where the caret should land (just past the insert).
 *
 * The textarea keeps its selection even after it blurs, so clicking a chip and
 * then splicing lands the text at the last cursor position without any focus
 * juggling. Extracted from the inline composer logic so it can be tested.
 */
export function spliceAtCaret(
  value: string,
  start: number,
  end: number,
  insert: string,
): { value: string; caret: number } {
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    caret: start + insert.length,
  }
}

/**
 * How a staged file is referenced in the message body: its name in square
 * brackets, so a message with several attachments can point at one of them.
 */
export function fileReferenceText(name: string): string {
  return `[${name}]`
}
