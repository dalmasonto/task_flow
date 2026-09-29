/// Zoom rules for the attachment preview dialog (`message-attachments.tsx`).
///
/// An IMAGE's zoom is its scale against its natural size: 1 is 100%, one image
/// pixel per CSS pixel. It opens at a FIXED `IMAGE_START_ZOOM` (50% — about a
/// 2–3× phone screenshot's own screen size) and can go down to 10% and up to
/// 400%. Fixed on purpose: a fit-to-stage start measured the stage, and the
/// image's own scrollbars changed that measurement, so the picture jumped
/// between sizes. Steps are multiplicative (×1.25), so each click is the same
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

/// Where an image opens the first time, and what the reset button returns
/// it to (after that, the viewer's last choice: `readImageZoom`).
export const IMAGE_START_ZOOM = 0.5
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

/// The image zoom a viewer last chose, remembered across previews (and across
/// opening the dialog again) so a set of screenshots is flipped through at one
/// scale. Per-viewer convenience only: storage can be missing or throw, and
/// anything unreadable falls back to `IMAGE_START_ZOOM`.
const IMAGE_ZOOM_KEY = "taskflow.preview.image-zoom"

export function readImageZoom(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): number {
  try {
    const value = Number(storage?.getItem(IMAGE_ZOOM_KEY))
    return Number.isFinite(value) && value > 0 ? clampZoom("image", value) : IMAGE_START_ZOOM
  } catch {
    return IMAGE_START_ZOOM
  }
}

export function writeImageZoom(
  zoom: number,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage,
): void {
  try {
    if (zoom === IMAGE_START_ZOOM) storage?.removeItem(IMAGE_ZOOM_KEY)
    else storage?.setItem(IMAGE_ZOOM_KEY, String(zoom))
  } catch {
    // Private mode / blocked storage: the zoom just is not remembered.
  }
}
