/** Detecting an in-progress `@mention` in the composer, so typing `@` opens an
 *  agent picker instead of forcing the human to type a full (spaced) name. */

export type MentionMatch = {
  /** Index of the `@` in the text. */
  start: number
  /** The text typed after `@`, up to the caret (may be empty right after `@`). */
  query: string
}

/**
 * If the caret sits inside an `@mention` being typed, return the `@` position and
 * the query after it; otherwise null. A mention starts with `@` at the beginning
 * of the text or right after whitespace, and runs until whitespace — so a lone
 * `@` opens the picker, and an email like `a@b` (the `@` is mid-word) does not.
 */
export function detectMention(text: string, caret: number): MentionMatch | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "@") {
      const prev = text[i - 1]
      if (i === 0 || (prev !== undefined && /\s/.test(prev))) {
        return { start: i, query: text.slice(i + 1, caret) }
      }
      return null
    }
    // Whitespace before finding an `@` means the caret is not in a mention.
    if (ch !== undefined && /\s/.test(ch)) return null
  }
  return null
}
