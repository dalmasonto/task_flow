/// Layering between the attachment preview and whatever a reference chip inside
/// it opens (the task sheet, the chat dock).
///
/// Clicking a `TASK#n` chip while reading an attachment used to mount the task
/// sheet BEHIND the document: the preview is z-80/81 and the sheet is z-40/50.
///
/// Raising the sheet is not available. `TaskDetailSheet` renders the attachment
/// list itself, so the preview is ALSO opened from the sheet, and that direction
/// needs the preview on top — it works today. The two flows want opposite
/// orders, so no single pair of fixed z-indexes satisfies both.
///
/// So the preview steps back instead of the sheet stepping up: on handing off it
/// drops below the sheet, releases its focus trap, and stops treating presses in
/// the sheet as dismissals. It stays OPEN — closing it would lose the reader's
/// place in the document, which is the whole reason they clicked a reference
/// while reading. Clicking the preview again restores it to the front.

/// The task sheet's layers, read from `App.tsx` (`TaskDetailSheet`: a z-40
/// backdrop under a z-50 panel). Duplicated here as named constants so the
/// relationship is asserted by a test rather than left as two magic numbers in
/// different files that drift apart silently.
export const TASK_SHEET_BACKDROP_Z = 40
export const TASK_SHEET_PANEL_Z = 50

export type PreviewLayer = {
  /// Tailwind class for the dialog backdrop.
  backdropClass: string
  /// Tailwind class for the dialog popup.
  popupClass: string
  /// The popup's numeric z, so the ordering against the task sheet is testable.
  z: number
  /// base-ui `modal`. `"trap-focus"` keeps focus in the dialog; `false` frees it
  /// so a surface above can actually be typed into.
  modal: boolean | "trap-focus"
  /// base-ui `disablePointerDismissal`. A non-modal dialog closes on an outside
  /// press by default, and every click in the task sheet is an outside press.
  disablePointerDismissal: boolean
}

/// Class names are written out in full rather than built from the numbers.
/// Tailwind scans source text for literal class names, so a computed
/// `` `z-${n}` `` never reaches the stylesheet and silently does nothing.
const FRONT: PreviewLayer = {
  backdropClass: "z-80",
  popupClass: "z-81",
  z: 81,
  modal: "trap-focus",
  disablePointerDismissal: false,
}

const BEHIND_TASK_SHEET: PreviewLayer = {
  backdropClass: "z-30",
  popupClass: "z-31",
  z: 31,
  modal: false,
  disablePointerDismissal: true,
}

/// How the preview should render, given whether it has handed a reference off to
/// a surface that must appear in front of it.
export function previewLayer(backgrounded: boolean): PreviewLayer {
  return backgrounded ? BEHIND_TASK_SHEET : FRONT
}

/// Wrap `open` so the preview steps behind before the target mounts.
///
/// Returns null when there is no opener, because the chip contexts use null to
/// mean "render inert". Wrapping null would produce a chip that looks clickable
/// and does nothing, which is worse than the plain text it replaced.
export function handOffFromPreview<T>(
  background: () => void,
  open: ((value: T) => void) | null,
): ((value: T) => void) | null {
  if (!open) return null
  return (value: T) => {
    background()
    open(value)
  }
}
