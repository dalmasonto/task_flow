/// #TSK1092: opening a chat puts the cursor in its message box, like other
/// messaging apps, without ever being rude about it (tested in focus.test.ts).

export type FocusContext = {
  /// The person has text selected (copying from the transcript, say).
  selecting: boolean
  /// A dialog, menu, popover or listbox is open on top.
  overlayOpen: boolean
  /// Focus is already in some OTHER editable field (a search box, a form).
  inOtherField: boolean
}

export function canTakeFocus(c: FocusContext): boolean {
  return !c.selecting && !c.overlayOpen && !c.inOtherField
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === "TEXTAREA" || (tag === "INPUT" && !["button", "checkbox", "radio", "submit"].includes((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable
}

/// Focus the composer inside `root` if the rules allow. Returns whether it did.
export function focusComposerIn(root: HTMLElement | null): boolean {
  if (!root || typeof document === "undefined") return false
  const sel = window.getSelection()
  const active = document.activeElement
  const ok = canTakeFocus({
    selecting: !!sel && !sel.isCollapsed && sel.toString().length > 0,
    overlayOpen: !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'),
    inOtherField: isEditable(active) && !root.contains(active),
  })
  if (!ok) return false
  const input = root.querySelector<HTMLElement>('textarea:not([disabled]), [contenteditable="true"]')
  if (!input) return false
  input.focus({ preventScroll: true })
  return true
}
