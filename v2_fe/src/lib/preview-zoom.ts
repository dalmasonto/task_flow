/// Zoom rules for the attachment preview dialog (`message-attachments.tsx`).
///
/// An IMAGE's zoom is its scale against its natural size: 1 is 100%, one image
/// pixel per CSS pixel. It opens at `fitScale` — the whole image inside the
/// padded stage, aspect kept, never enlarged past 100% — and can go down to 10%
/// and up to 400%. Steps are multiplicative (×1.25), so each click is the same
/// visible change whether the image is at 20% or 300%.
///
/// A PDF's zoom is a width multiplier on its fitted page, 100%–300% in 25%
/// steps, as before: below 100% a PDF page only gets harder to read.

export type ZoomKind = "image" | "pdf"

const LIMITS: Record<ZoomKind, { min: number; max: number }> = {
  image: { min: 0.1, max: 4 },
  pdf: { min: 1, max: 3 },
}

const IMAGE_STEP = 1.25
const PDF_STEP = 0.25

export function zoomLimits(kind: ZoomKind) {
  return LIMITS[kind]
}

export function clampZoom(kind: ZoomKind, value: number): number {
  const { min, max } = LIMITS[kind]
  return Math.min(max, Math.max(min, value))
}

/// One zoom-in (`direction` 1) or zoom-out (-1) click from `zoom`.
export function stepZoom(kind: ZoomKind, zoom: number, direction: 1 | -1): number {
  const next = kind === "image" ? zoom * IMAGE_STEP ** direction : zoom + PDF_STEP * direction
  return clampZoom(kind, next)
}

/// The scale that shows a whole `natural`-sized image inside a `box`, keeping
/// its aspect ratio and never enlarging it past its natural size.
export function fitScale(natural: { w: number; h: number }, box: { w: number; h: number }): number {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return 1
  return clampZoom("image", Math.min(1, box.w / natural.w, box.h / natural.h))
}
