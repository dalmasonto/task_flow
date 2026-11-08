/** #1122: the `@mention` picker's matching and keyboard rules, WhatsApp/Slack
 *  style. Pure and framework-free so the v2 composer and the v3 composer share
 *  one implementation (main, #MSG5744).
 *
 *  - ↑ / ↓ move the highlight, wrapping at the ends. Shift+Tab moves up.
 *  - Enter or Tab picks the highlighted row (Enter does NOT send while open).
 *  - Esc closes the picker for this `@` only; the text stays as typed.
 *  - With nothing to pick, every key falls through to the composer. */

/** Best match first: exact name, then name starts with the query, then a word
 *  in the name starts with it, then it appears anywhere. Ties keep input order. */
export function rankMentionMatches<T>(items: readonly T[], query: string, name: (item: T) => string, limit = 6): T[] {
  const q = query.trim().toLowerCase()
  const scored: { item: T; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const n = name(item).toLowerCase()
    let score: number
    if (!q) score = 3
    else if (n === q) score = 0
    else if (n.startsWith(q)) score = 1
    else if (n.split(/[\s._()-]+/).some((word) => word.startsWith(q))) score = 2
    else if (n.includes(q)) score = 3
    else return
    scored.push({ item, score, index })
  })
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.item)
}

export type PickerAction =
  /** Not the picker's key: let the composer handle it (e.g. send on Enter). */
  | { kind: "none" }
  | { kind: "move"; index: number }
  | { kind: "pick"; index: number }
  | { kind: "close" }

export type PickerKeyEvent = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }

/** What a keydown means while the picker shows `count` rows with `active`
 *  highlighted. `count` 0 (closed or no match) is always `none`. */
export function mentionPickerKey(event: PickerKeyEvent, count: number, active: number): PickerAction {
  if (count <= 0 || event.isComposing) return { kind: "none" }
  const at = clampActive(active, count)
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: "none" }
  switch (event.key) {
    case "ArrowDown":
      return { kind: "move", index: (at + 1) % count }
    case "ArrowUp":
      return { kind: "move", index: (at - 1 + count) % count }
    case "Tab":
      return event.shiftKey ? { kind: "move", index: (at - 1 + count) % count } : { kind: "pick", index: at }
    case "Enter":
      // Shift+Enter still means "newline" to the composer.
      return event.shiftKey ? { kind: "none" } : { kind: "pick", index: at }
    case "Escape":
      return { kind: "close" }
    default:
      return { kind: "none" }
  }
}

/** Keep the highlight on a real row when the list shrinks or grows. */
export function clampActive(active: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(active) || active < 0) return 0
  return Math.min(active, count - 1)
}

/** A key for "this `@` and its query". It changes with every character, so
 *  the highlight resets to the top on each new query. It is NOT the Esc
 *  dismissal: that is keyed by the `@` position alone (the composer's
 *  `mentionDismissedAt`), so it holds while typing and lifts on a new `@`. */
export function mentionKey(mention: { start: number; query: string } | null): string | null {
  return mention ? `${mention.start}:${mention.query}` : null
}
