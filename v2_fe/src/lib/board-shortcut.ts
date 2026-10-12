/// #662: the board dialog's keyboard shortcut (⌘/Ctrl+B).
///
/// A pure predicate so the rules — which chords count, and when to stay out of
/// the way — are testable without a DOM: node-env vitest has no `KeyboardEvent`,
/// which is why the parameter is structural rather than the real type.

type ShortcutEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey?: boolean
  altKey?: boolean
  /// Deliberately `unknown`: a real KeyboardEvent's target is `EventTarget`,
  /// which the structural check below narrows. Keeping the parameter type
  /// honest is what lets `App.tsx` pass the event straight through.
  target?: unknown
}

/// The chord alone: Cmd/Ctrl+B, nothing else held. What OPENING requires.
export function isBoardChord(event: Pick<ShortcutEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
  return event.key.toLowerCase() === "b"
}

/// True when this key event should OPEN the board dialog. The chord, and never
/// while the caret is in a text field, where ⌘B means bold and a chat draft
/// must not summon a board. CLOSING uses `isBoardChord` instead: once the board
/// is up, its own search box has the focus, and "put the board away" must still
/// work from there.
export function isBoardShortcut(event: ShortcutEvent): boolean {
  if (!isBoardChord(event)) return false
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined
  if (target) {
    const tag = (target.tagName ?? "").toUpperCase()
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false
    if (target.isContentEditable) return false
  }
  return true
}
