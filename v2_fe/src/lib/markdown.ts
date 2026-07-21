/** Small pure helpers for previewing markdown in tight spaces. */

/**
 * The first non-empty line of a markdown string, stripped of leading heading
 * (`#`), list (`-`, `*`, `+`), and blockquote (`>`) markers — a one-line preview
 * for places that height-gate the full text behind a dialog (e.g. the board's
 * project description). Returns "" when the input has no visible text.
 */
export function firstLine(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    return line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s*/, "")
      .trim()
  }
  return ""
}
