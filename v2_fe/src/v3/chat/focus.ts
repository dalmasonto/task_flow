/// #TSK1092: opening a chat puts the cursor in its message box, like other
/// messaging apps, without ever being rude about it (tested in focus.test.ts).

export type FocusContext = {
  /// The person has text selected (copying from the transcript, say).
  selecting: boolean
  /// A dialog, menu, popover or listbox is open on top.
  overlayOpen: boolean
  /// Focus is already in some OTHER editable field (a search box, a form).
  inOtherField: boolean
  /// A touch screen, where focusing pops the on-screen keyboard.
  touch?: boolean
  /// The person tapped or clicked to get here (not a page load or a deep link).
  byTap?: boolean
}

export function canTakeFocus(c: FocusContext): boolean {
  // On touch, only a real tap may raise the keyboard, never a page load.
  if (c.touch && !c.byTap) return false
  return !c.selecting && !c.overlayOpen && !c.inOtherField
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === "TEXTAREA" || (tag === "INPUT" && !["button", "checkbox", "radio", "submit"].includes((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable
}

/// Focus the composer inside `root` if the rules allow, caret at the end of
/// any unsent draft. `byTap`: the person clicked or tapped to get here.
/// Returns whether it did.
export function focusComposerIn(root: HTMLElement | null, { byTap = false }: { byTap?: boolean } = {}): boolean {
  if (!root || typeof document === "undefined") return false
  const sel = window.getSelection()
  const active = document.activeElement
  const ok = canTakeFocus({
    selecting: !!sel && !sel.isCollapsed && sel.toString().length > 0,
    overlayOpen: !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'),
    inOtherField: isEditable(active) && !root.contains(active),
    touch: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
    byTap,
  })
  if (!ok) return false
  const input = root.querySelector<HTMLElement>('textarea:not([disabled]), [contenteditable="true"]')
  if (!input) return false
  input.focus({ preventScroll: true })
  if (input instanceof HTMLTextAreaElement) input.setSelectionRange(input.value.length, input.value.length)
  return true
}
