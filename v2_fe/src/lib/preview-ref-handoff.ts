/// Handing a reference click off from the attachment preview to whatever opens
/// it (the task sheet, the chat dock).
///
/// The preview is a modal dialog at `z-80`/`z-81`; the task sheet is `z-40`/`z-50`
/// and the chat dock `z-[60]`. Clicking a `TASK#n` chip inside an open preview
/// therefore mounted the sheet UNDERNEATH the document the user was reading —
/// it opened, it just could not be seen.
///
/// Raising the sheet is not the fix. `TaskDetailSheet` renders the attachments
/// list itself, so the preview is also opened FROM the sheet, and that direction
/// needs the preview on top. The two flows want opposite orders, so no fixed
/// z-index satisfies both. The preview is additionally `modal="trap-focus"`, so
/// a sheet merely painted above it would still have focus trapped in the dialog.
///
/// Closing the preview first sidesteps all of it: only one surface is ever
/// mounted, so there is no stacking question left to get wrong.

/// Wrap `open` so the preview closes before it runs.
///
/// Returns null when there is no opener, because the chip contexts use null to
/// mean "render inert". Wrapping null would produce a chip that looks clickable
/// and does nothing, which is worse than the plain text it replaced.
export function handOffFromPreview<T>(
  closePreview: () => void,
  open: ((value: T) => void) | null,
): ((value: T) => void) | null {
  if (!open) return null
  return (value: T) => {
    closePreview()
    open(value)
  }
}
