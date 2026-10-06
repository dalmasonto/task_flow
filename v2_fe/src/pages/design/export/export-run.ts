/// #507: the design export's browser half — picture each page, dress it (a
/// device frame or rounded corners), and assemble a PDF or a ZIP of PNGs.
///
/// Rendering is CLIENT-SIDE by the owner's decision: every page is loaded in a
/// hidden iframe at the device's exact viewport, and the page runtime inside it
/// (`composer.rs`, `design:capture`) draws itself — only that document can read
/// its own fonts and styles; this one is cross-origin to it.
///
/// This module is only ever reached through a dynamic `import()` from the
/// export dialog, so jsPDF, JSZip, the frames' CSS and the DOM rasteriser load
/// when someone exports, never with the app.


import { sandboxUrl } from "@/lib/design-api"
import { inlineFontCss } from "./font-inline"
import { inlineImage } from "./image-inline"
import { statusBarHtml, statusBarStyle } from "@/lib/design-frames"
import type { ChromeStyle, DevicePreset } from "@/lib/design-devices"
import {
  CAPTION_H,
  FRAME_METRICS,
  PAGE_MARGIN,
  bestPageSetup,
  captureViewport,
  screenFileName,
  screensPerPage,
  slotOrigin,
  type ExportDress,
  type ExportItem,
} from "./export-plan"

export type ExportOptions = {
  items: ExportItem[]
  device: DevicePreset
  /// The project the pages belong to: the export's image proxy is per project.
  projectId: number
  /// A FRESH sandbox token, asked for per screen: a token lives ten minutes
  /// and a long export outlives one (`lib/sandbox-token.ts`).
  getSandboxToken: () => Promise<string>
  theme: string
  /// What each screen is dressed in (see `ExportDress`).
  dress: ExportDress
  /// Corner radius in CSS px for a bare screenshot.
  radius: number
  /// The whole page length rather than one screen's worth.
  fullPage: boolean
  format: "pdf" | "png"
  projectName: string
  scopeLabel: string
  onProgress: (done: number, total: number, phase: string) => void
  isCancelled: () => boolean
}

type Picture = { dataUrl: string; width: number; height: number }

/// What a capture could not have: the external images the server refused or
/// failed to fetch. The screen still shows, with a placeholder card drawn
/// where each one was (`composer.rs`, `IMAGE_PLACEHOLDER`).
type CaptureResult = Picture & { missingImages: string[] }

/// The export's result: the file, and the assets it stands in for. Every
/// screen is in the file — an asset is the only thing an export goes
/// without, and the dialog names each one so the owner knows which host
/// would not serve it.
export type ExportResult = {
  blob: Blob
  /// Screens whose picture has a placeholder for an image the server could
  /// not fetch, with the urls.
  missingImages: { item: ExportItem; urls: string[] }[]
}

export class ExportCancelled extends Error {}

const CAPTURE_TIMEOUT_MS = 45_000

/// Load `route` in a hidden iframe at the device's viewport and ask the page to
/// picture itself. Resolves with a PNG data URL at up to 2× (a phone's 3× is
/// more pixels than any PDF shows, and each one costs memory).
function capturePage(route: string, opts: ExportOptions): Promise<CaptureResult> {
  const { device } = opts
  // The frame's own screen when the screen is dressed in one (see
  // `captureViewport`): the page lays out for the area it will be shown in.
  const viewport = captureViewport(device, opts.dress)
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    // Off-screen but laid out at full size: a `display:none` frame has no
    // viewport, and its page would render at 0×0.
    Object.assign(frame.style, {
      position: "fixed",
      left: "-20000px",
      top: "0",
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    })
    const id = `cap-${Math.random().toString(36).slice(2)}`
    let asked = false
    const missingImages = new Set<string>()
    const done = (fn: () => void) => {
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      frame.remove()
      fn()
    }
    const timer = window.setTimeout(
      () => done(() => reject(new Error(`${route} did not finish rendering in time.`))),
      CAPTURE_TIMEOUT_MS,
    )
    const onMessage = (event: MessageEvent) => {
      // Only THIS frame's messages: every artboard on the canvas speaks the
      // same protocol.
      if (event.source !== frame.contentWindow) return
      const data = event.data as {
        type?: string
        id?: string
        dataUrl?: string
        error?: string
        width?: number
        height?: number
        sheets?: unknown
        faces?: unknown
        key?: unknown
        url?: unknown
      }
      if (!data || typeof data !== "object") return
      // One of the page's external images, fetched through the server and
      // handed back inline (see `image-inline.ts`). Only for this capture.
      // A null answer is sent as such: the page then lets the library draw
      // its placeholder rather than wait out its own timeout.
      if (data.type === "design:fetch-image" && data.id === id && typeof data.key === "string" && typeof data.url === "string") {
        const { key, url } = data
        void inlineImage(opts.projectId, url).then((dataUrl) => {
          if (!dataUrl) missingImages.add(url)
          frame.contentWindow?.postMessage({ type: "design:image-data", key, dataUrl }, "*")
        })
        return
      }
      // The page's webfonts, fetched here and handed back inline (see
      // `font-inline.ts`). Only for the capture this frame was asked for.
      if (data.type === "design:font-sources" && data.id === id) {
        const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
        void inlineFontCss({ sheets: strings(data.sheets), faces: strings(data.faces) })
          .catch(() => "")
          .then((cssText) => frame.contentWindow?.postMessage({ type: "design:font-css", id, cssText }, "*"))
        return
      }
      if (data.type === "design:ready" && !asked) {
        asked = true
        frame.contentWindow?.postMessage({ type: "design:theme", theme: opts.theme }, "*")
        // A beat for the Tailwind runtime and the theme switch to settle.
        window.setTimeout(() => {
          frame.contentWindow?.postMessage(
            { type: "design:capture", id, fullPage: opts.fullPage, scale: Math.min(device.dpr, 2) },
            "*",
          )
        }, 700)
      }
      if (data.type === "design:captured" && data.id === id) {
        if (data.error || !data.dataUrl?.startsWith("data:image/png")) {
          done(() => reject(new Error(`Could not picture ${route}: ${data.error ?? "no image"}`)))
        } else {
          const picture = {
            dataUrl: data.dataUrl,
            width: data.width ?? viewport.width,
            height: data.height ?? viewport.height,
            missingImages: [...missingImages],
          }
          done(() => resolve(picture))
        }
      }
    }
    window.addEventListener("message", onMessage)
    opts
      .getSandboxToken()
      .then((token) => {
        frame.src = sandboxUrl(token, route)
        document.body.appendChild(frame)
      })
      .catch((err: unknown) => done(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not read a captured image."))
    img.src = src
  })

/// A frameless screenshot: rounded corners and a soft shadow, on a transparent
/// margin so it sits on the PDF's white like a card.
async function roundAndShadow(shot: Picture, radiusCss: number): Promise<Picture> {
  const img = await loadImage(shot.dataUrl)
  const scale = img.naturalWidth / shot.width
  const r = Math.max(0, radiusCss) * scale
  const pad = Math.round(24 * scale)
  const canvas = document.createElement("canvas")
  canvas.width = img.naturalWidth + pad * 2
  canvas.height = img.naturalHeight + pad * 2
  const ctx = canvas.getContext("2d")!
  ctx.save()
  ctx.shadowColor = "rgba(15, 23, 42, 0.18)"
  ctx.shadowBlur = 18 * scale
  ctx.shadowOffsetY = 6 * scale
  ctx.fillStyle = "#ffffff"
  ctx.beginPath()
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r)
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r)
  ctx.clip()
  ctx.drawImage(img, pad, pad)
  ctx.restore()
  // A hairline edge, so a white page does not dissolve into the white paper.
  ctx.strokeStyle = "rgba(15, 23, 42, 0.10)"
  ctx.lineWidth = Math.max(1, scale)
  ctx.beginPath()
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r)
  ctx.stroke()
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width / scale, height: canvas.height / scale }
}


/// The screenshot's top-left colour — what the status-bar strip is filled
/// with, so the page appears to run up under it.
async function topColor(src: string): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(img, 2, 2, 1, 1, 0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

/// Whether a CSS rgb() colour is dark (perceived luminance under half).
function isDark(rgb: string): boolean {
  const [r, g, b] = (rgb.match(/\d+/g) ?? ["255", "255", "255"]).map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/// A screenshot inside an open-source device frame (devices.css, MIT). The
/// frame is real DOM in THIS document, rasterised with the screenshot as its
/// screen, at a scale that keeps the screenshot's own resolution.
async function inDeviceFrame(shot: Picture, frame: string): Promise<Picture> {
  const { domToPng } = await import("modern-screenshot")
  const holder = document.createElement("div")
  Object.assign(holder.style, { position: "fixed", left: "-20000px", top: "0", padding: "24px", background: "transparent" })
  holder.innerHTML = `
    <div class="tf-frame device device-${frame}">
      <div class="device-frame"><img class="device-screen" alt="" /></div>
      <div class="device-stripe"></div><div class="device-header"></div>
      <div class="device-sensors"></div><div class="device-btns"></div>
      <div class="device-power"></div><div class="device-home"></div>
    </div>`
  const img = holder.querySelector("img")!
  const top = await topColor(shot.dataUrl)
  const metrics = FRAME_METRICS[frame]
  // The frame's screen has its own proportions; cover it from the top, the
  // part of a page a viewer looks at first.
  Object.assign(img.style, {
    objectFit: "cover",
    objectPosition: "top",
    boxSizing: "border-box",
    // The status-bar strip a notch or Dynamic Island sits in stays clear.
    paddingTop: `${metrics?.statusBar ?? 0}px`,
    background: top,
  })
  // ...and shows the status bar a real phone draws there, as the canvas does:
  // light ink on a dark page, dark ink on a light one.
  const barStyle = statusBarStyle(frame)
  if (metrics?.statusBar && barStyle) {
    const bar = document.createElement("div")
    bar.innerHTML = statusBarHtml(barStyle, metrics.screenW, metrics.statusBar, isDark(top) ? "#f5f5f5" : "#0a0a0a")
    Object.assign(bar.style, { position: "absolute", left: `${metrics.screenX}px`, top: `${metrics.screenY}px`, zIndex: "2" })
    holder.querySelector(".device")!.appendChild(bar)
  }
  img.src = shot.dataUrl
  document.body.appendChild(holder)
  try {
    await img.decode()
    const screenWidth = img.getBoundingClientRect().width || 1
    const natural = (await loadImage(shot.dataUrl)).naturalWidth
    const scale = Math.min(4, Math.max(1, natural / screenWidth))
    const rect = holder.getBoundingClientRect()
    const dataUrl = await domToPng(holder, { scale, backgroundColor: null as unknown as string })
    return { dataUrl, width: rect.width, height: rect.height }
  } finally {
    holder.remove()
  }
}

/// A screenshot in the canvas's classic chrome (`ClassicBoard`): a black bezel
/// with a notch pill and home indicator (phone), a camera dot (tablet) or a
/// window bar (laptop). Drawn straight onto a canvas — the same measurements
/// the canvas uses, at the screenshot's own resolution.
async function inClassicChrome(shot: Picture, chrome: ChromeStyle): Promise<Picture> {
  const img = await loadImage(shot.dataUrl)
  const s = img.naturalWidth / shot.width
  const { padding: p } = chrome
  const border = 1
  const margin = 24
  const w = shot.width + p.left + p.right + border * 2
  const h = shot.height + p.top + p.bottom + border * 2
  const canvas = document.createElement("canvas")
  canvas.width = Math.round((w + margin * 2) * s)
  canvas.height = Math.round((h + margin * 2) * s)
  const ctx = canvas.getContext("2d")!
  ctx.scale(s, s)
  ctx.translate(margin, margin)

  // The bezel, with the canvas board's soft drop shadow.
  ctx.save()
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)"
  ctx.shadowBlur = 24
  ctx.shadowOffsetY = 10
  ctx.fillStyle = "#000000"
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, chrome.outerRadius)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = "rgba(63, 63, 70, 0.8)"
  ctx.lineWidth = border
  ctx.beginPath()
  ctx.roundRect(border / 2, border / 2, w - border, h - border, chrome.outerRadius)
  ctx.stroke()

  // The screen.
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(border + p.left, border + p.top, shot.width, shot.height, chrome.innerRadius)
  ctx.clip()
  ctx.drawImage(img, border + p.left, border + p.top, shot.width, shot.height)
  ctx.restore()

  const pill = (x: number, y: number, pw: number, ph: number, fill: string, ring?: string) => {
    ctx.beginPath()
    ctx.roundRect(x, y, pw, ph, ph / 2)
    ctx.fillStyle = fill
    ctx.fill()
    if (ring) {
      ctx.strokeStyle = ring
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  const cx = w / 2
  if (chrome.notch) pill(cx - 48, border + 8, 96, 16, "#18181b", "#27272a")
  if (chrome.homeIndicator) pill(cx - 56, h - border - 6 - 4, 112, 4, "#3f3f46")
  if (chrome.cameraDot) pill(cx - 3, border + 6, 6, 6, "#27272a", "rgba(82, 82, 91, 0.6)")
  if (chrome.topBar) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(border, border, w - border * 2, 22, [chrome.outerRadius, chrome.outerRadius, 0, 0])
    ctx.fillStyle = "#18181b"
    ctx.fill()
    ctx.restore()
    for (let i = 0; i < 3; i++) pill(border + 12 + i * 14, border + 7, 8, 8, "#3f3f46")
  }

  return { dataUrl: canvas.toDataURL("image/png"), width: w + margin * 2, height: h + margin * 2 }
}

type Dressed = { item: ExportItem; picture: Picture }

/// One screen, pictured and dressed: the same pipeline an export runs per
/// page, for the board menu's single-screen download.
export async function renderScreen(
  route: string,
  opts: Pick<ExportOptions, "device" | "projectId" | "getSandboxToken" | "theme" | "dress" | "radius" | "fullPage">,
): Promise<CaptureResult> {
  const shot = await capturePage(route, opts as ExportOptions)
  const { missingImages } = shot
  const dressed = await (() => {
    switch (opts.dress.kind) {
      case "device":
        return inDeviceFrame(shot, opts.dress.frame)
      case "classic":
        return inClassicChrome(shot, opts.dress.chrome)
      case "none":
        return roundAndShadow(shot, opts.radius)
    }
  })()
  return { ...dressed, missingImages }
}

/// #507 follow-up: download ONE board's screen as a PNG, bare (rounded
/// corners), in its device's frame, or in the classic chrome.
export async function downloadScreen(input: {
  route: string
  label: string
  device: DevicePreset
  projectId: number
  getSandboxToken: () => Promise<string>
  theme: string
  dress: ExportDress
}): Promise<void> {
  const picture = await renderScreen(input.route, {
    device: input.device,
    projectId: input.projectId,
    getSandboxToken: input.getSandboxToken,
    theme: input.theme,
    dress: input.dress,
    radius: 8,
    fullPage: false,
  })
  const blob = await (await fetch(picture.dataUrl)).blob()
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "screen"
  saveBlob(blob, `${slug(input.label)}-${slug(input.device.label)}${input.dress.kind === "none" ? "" : "-framed"}.png`)
}

type Captured = Pick<ExportResult, "missingImages"> & { dressed: Dressed[] }

/// Every screen, in order. A screen is never left out (the owner's rule: an
/// asset the page cannot have is replaced, the page itself is not), so a
/// capture that fails is tried once more — a page can miss its moment to a
/// slow CDN or a busy tab — and a second failure fails the export, naming
/// the screen, rather than saving a document with a page missing.
async function captureAll(opts: ExportOptions): Promise<Captured> {
  const dressed: Dressed[] = []
  const missingImages: ExportResult["missingImages"] = []
  const total = opts.items.length
  for (const item of opts.items) {
    if (opts.isCancelled()) throw new ExportCancelled()
    opts.onProgress(dressed.length, total, `Rendering ${item.label}`)
    let picture: CaptureResult
    try {
      picture = await renderScreen(item.route, opts)
    } catch (err) {
      if (err instanceof ExportCancelled || opts.isCancelled()) throw new ExportCancelled()
      opts.onProgress(dressed.length, total, `Rendering ${item.label} (second try)`)
      picture = await renderScreen(item.route, opts)
    }
    if (opts.isCancelled()) throw new ExportCancelled()
    if (picture.missingImages.length) missingImages.push({ item, urls: picture.missingImages })
    dressed.push({ item, picture })
  }
  opts.onProgress(total, total, opts.format === "pdf" ? "Laying out the PDF" : "Packing the images")
  return { dressed, missingImages }
}

/// The whole export: capture, dress, assemble. Resolves with the file to save
/// and the assets it stands in for.
export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const { dressed, missingImages } = await captureAll(opts)
  const blob = opts.format === "pdf" ? await buildPdf(dressed, opts) : await buildZip(dressed)
  return { blob, missingImages }
}

async function buildZip(dressed: Dressed[]): Promise<Blob> {
  const { default: JSZip } = await import("jszip")
  const zip = new JSZip()
  for (const { item, picture } of dressed) {
    zip.file(screenFileName(item, dressed.length), picture.dataUrl.split(",")[1], { base64: true })
  }
  return zip.generateAsync({ type: "blob" })
}

// --- the PDF -----------------------------------------------------------------
//
// Three kinds of page: a dark COVER with a fanned hero of the first screens, an
// OVERVIEW contact sheet of every screen (the document's table of contents),
// then the SCREEN pages at 4 (phones) or 2 (larger) per page.

type Rgb = readonly [number, number, number]
const INK: Rgb = [15, 23, 42] // slate-900
const MUTED: Rgb = [100, 116, 139] // slate-500
const FAINT: Rgb = [148, 163, 184] // slate-400
const RULE: Rgb = [226, 232, 240] // slate-200
const CARD: Rgb = [248, 250, 252] // slate-50
const ACCENT: Rgb = [79, 70, 229] // indigo-600
const ACCENT_SOFT: Rgb = [224, 231, 255] // indigo-100
const NIGHT: Rgb = [11, 16, 32] // the cover
const NIGHT_TEXT: Rgb = [203, 213, 225] // slate-300
const NIGHT_CHIP: Rgb = [30, 41, 59] // slate-800

type Pdf = InstanceType<(typeof import("jspdf"))["jsPDF"]>

/// One line of text in at most `width` mm at the CURRENT font: whole if it
/// fits, otherwise cut with an ellipsis. (`splitTextToSize` would wrap at a
/// word and keep only "Components" of "Components Demo".)
function fitText(doc: Pdf, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text
  let cut = text
  while (cut.length > 1 && doc.getTextWidth(cut + "…") > width) cut = cut.slice(0, -1)
  return cut.trimEnd() + "…"
}

/// The overview's grid: tall screens four across, wide ones two.
function overviewGrid(aspect: number) {
  const cols = aspect < 1 ? 4 : 2
  const areaW = 210 - PAGE_MARGIN.side * 2
  const gap = 6
  const cardW = (areaW - gap * (cols - 1)) / cols
  const thumbW = cardW - 8
  const thumbH = Math.min(thumbW / aspect, aspect < 1 ? 78 : 60)
  const cardH = thumbH + 8 + 16
  // First overview page loses room to its title block.
  const firstTop = 52
  const nextTop = 26
  const bottom = 297 - PAGE_MARGIN.bottom - 6
  const rowsFirst = Math.max(1, Math.floor((bottom - firstTop + gap) / (cardH + gap)))
  const rowsNext = Math.max(1, Math.floor((bottom - nextTop + gap) / (cardH + gap)))
  return { cols, gap, cardW, cardH, thumbH, firstTop, nextTop, rowsFirst, rowsNext }
}

function overviewPageCount(count: number, aspect: number): number {
  const g = overviewGrid(aspect)
  const first = g.cols * g.rowsFirst
  return count <= first ? 1 : 1 + Math.ceil((count - first) / (g.cols * g.rowsNext))
}

async function buildPdf(dressed: Dressed[], opts: ExportOptions): Promise<Blob> {
  const { jsPDF, GState } = await import("jspdf")
  // Every dressed picture of one export shares a size; plan the grid from it.
  const aspect = dressed.length ? dressed[0].picture.width / dressed[0].picture.height : opts.device.width / opts.device.height
  const perPage = screensPerPage(opts.device)
  const setup = bestPageSetup(aspect, perPage)
  const screenPages = Math.ceil(dressed.length / perPage)
  const overviewPages = overviewPageCount(dressed.length, aspect)
  const firstScreenPage = 1 + overviewPages + 1
  const totalPages = firstScreenPage - 1 + screenPages
  const pageOf = (index: number) => firstScreenPage + Math.floor(index / perPage)
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
  const deviceLine = `${opts.device.label} · ${opts.device.width}×${opts.device.height}`

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true })
  doc.setProperties({ title: `${opts.projectName} — design`, subject: deviceLine, creator: "TaskFlow" })

  drawCover(doc, dressed, opts, { date, deviceLine, aspect, GState })
  drawOverview(doc, dressed, opts, { aspect, pageOf, totalPages })

  for (let page = 0; page < screenPages; page++) {
    doc.addPage("a4", setup.orientation)
    const slice = dressed.slice(page * perPage, (page + 1) * perPage)
    const groups = [...new Set(slice.map((d) => d.item.group).filter((g): g is string => !!g))]
    header(doc, opts.projectName, deviceLine, setup.pageW, groups)
    for (const [index, { item, picture }] of slice.entries()) {
      const origin = slotOrigin(setup, index)
      const x = origin.x + (setup.slotW - setup.imageW) / 2
      // The image and its caption are ONE block, centred in the slot — a
      // caption pinned to the slot's foot drifts away from a short image.
      const yImg = origin.y + (setup.slotH - (setup.imageH + CAPTION_H)) / 2
      doc.addImage(picture.dataUrl, "PNG", x, yImg, setup.imageW, setup.imageH, undefined, "FAST")
      const cx = origin.x + setup.slotW / 2
      const cy = yImg + setup.imageH + 5.5
      // "03" in the accent, then the name — the number is how the overview
      // and a conversation about the document refer to a screen.
      const num = String(item.n).padStart(2, "0")
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9.5)
      const name = fitText(doc, item.label, setup.slotW - 12)
      const numW = doc.getTextWidth(num + "  ")
      const nameW = doc.getTextWidth(name)
      const start = cx - (numW + nameW) / 2
      doc.setTextColor(...ACCENT)
      doc.text(num, start, cy)
      doc.setTextColor(...INK)
      doc.text(name, start + numW, cy)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7.8)
      doc.setTextColor(...MUTED)
      const sub = item.group ? `${item.route}  ·  ${item.group}` : item.route
      doc.text(fitText(doc, sub, setup.slotW), cx, cy + 4.3, { align: "center" })
    }
    footer(doc, firstScreenPage + page, totalPages, setup.pageW, setup.pageH)
  }
  return doc.output("blob")
}

/// The cover: a full-bleed night page, soft colour glows, the title, a row of
/// fact chips, and the first screens fanned out as the hero.
function drawCover(
  doc: Pdf,
  dressed: Dressed[],
  opts: ExportOptions,
  meta: { date: string; deviceLine: string; aspect: number; GState: (typeof import("jspdf"))["GState"] },
) {
  const W = 210
  const H = 297
  doc.setFillColor(...NIGHT)
  doc.rect(0, 0, W, H, "F")
  // Glows: big translucent discs, layered, for depth without an image.
  const glow = (x: number, y: number, r: number, rgb: Rgb, opacity: number) => {
    doc.saveGraphicsState()
    doc.setGState(new meta.GState({ opacity }))
    doc.setFillColor(...rgb)
    doc.circle(x, y, r, "F")
    doc.restoreGraphicsState()
  }
  glow(186, 24, 70, [99, 102, 241], 0.22)
  glow(200, 60, 40, [168, 85, 247], 0.18)
  glow(10, 250, 90, [14, 165, 233], 0.12)
  glow(110, 300, 60, [99, 102, 241], 0.14)

  // Wordmark.
  doc.setFillColor(...ACCENT)
  doc.roundedRect(20, 22, 7, 7, 1.6, 1.6, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.setTextColor(255, 255, 255)
  doc.text("TaskFlow", 30, 27.4)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(...FAINT)
  doc.text("Design review", W - 20, 27.4, { align: "right" })

  // Title block.
  doc.setFontSize(9)
  doc.setTextColor(165, 180, 252) // indigo-300
  doc.text("DESIGN SCREENS", 20, 52, { charSpace: 1.2 })
  doc.setFont("helvetica", "bold")
  doc.setFontSize(34)
  doc.setTextColor(255, 255, 255)
  const title = doc.splitTextToSize(opts.projectName, W - 40) as string[]
  doc.text(title.slice(0, 2), 20, 66)
  let y = 66 + Math.min(title.length, 2) * 13
  doc.setFont("helvetica", "normal")
  doc.setFontSize(12.5)
  doc.setTextColor(...NIGHT_TEXT)
  doc.text(`${dressed.length} screen${dressed.length === 1 ? "" : "s"}, shown on ${opts.device.label}.`, 20, y)
  y += 9

  // Fact chips.
  let x = 20
  doc.setFontSize(8.5)
  for (const chip of [meta.deviceLine, opts.scopeLabel, meta.date]) {
    const w = doc.getTextWidth(chip) + 8
    if (x + w > W - 20) break
    doc.setFillColor(...NIGHT_CHIP)
    doc.roundedRect(x, y, w, 7, 3.5, 3.5, "F")
    doc.setTextColor(...NIGHT_TEXT)
    doc.text(chip, x + 4, y + 4.8)
    x += w + 3
  }

  // Hero: up to three screens, the middle one forward and larger.
  const hero = dressed.slice(0, 3).map((d) => d.picture)
  const top = y + 20
  const bottom = H - 24
  const boxH = bottom - top
  const tall = meta.aspect < 1
  const centreH = tall ? boxH : Math.min(boxH * 0.72, (W - 40) / meta.aspect)
  const centreW = centreH * meta.aspect
  const sideScale = 0.8
  const place = (pic: Picture, cx: number, cy: number, scale: number) => {
    const w = centreW * scale
    const h = centreH * scale
    doc.addImage(pic.dataUrl, "PNG", cx - w / 2, cy - h / 2, w, h, undefined, "FAST")
  }
  const midY = top + boxH / 2
  const spread = tall ? centreW * 0.78 : centreW * 0.34
  if (hero.length >= 3) {
    place(hero[1], W / 2 - spread, midY + (tall ? 10 : 18), sideScale)
    place(hero[2], W / 2 + spread, midY + (tall ? 10 : 18), sideScale)
  } else if (hero.length === 2) {
    place(hero[1], W / 2 + spread * 0.6, midY + 10, sideScale)
  }
  if (hero[0]) place(hero[0], hero.length === 2 ? W / 2 - spread * 0.4 : W / 2, midY, 1)

  doc.setFontSize(8)
  doc.setTextColor(...FAINT)
  doc.text("Made with TaskFlow", 20, H - 10)
  doc.text(`1`, W - 20, H - 10, { align: "right" })
}

/// The overview: every screen as a card — thumbnail, number, name, route and
/// the page it is printed on. This is the document's table of contents.
function drawOverview(
  doc: Pdf,
  dressed: Dressed[],
  opts: ExportOptions,
  ctx: { aspect: number; pageOf: (index: number) => number; totalPages: number },
) {
  const g = overviewGrid(ctx.aspect)
  let index = 0
  let pageNo = 2
  let first = true
  while (index < dressed.length || first) {
    doc.addPage("a4", "portrait")
    let top = g.nextTop
    if (first) {
      doc.setFillColor(...ACCENT)
      doc.rect(0, 0, 210, 3, "F")
      doc.setFont("helvetica", "bold")
      doc.setFontSize(22)
      doc.setTextColor(...INK)
      doc.text("Overview", PAGE_MARGIN.side, 26)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(10)
      doc.setTextColor(...MUTED)
      doc.text(`Every screen in this document, in order. ${opts.device.label}.`, PAGE_MARGIN.side, 34)
      top = g.firstTop
    } else {
      header(doc, opts.projectName, "Overview", 210, [])
    }
    const rows = first ? g.rowsFirst : g.rowsNext
    for (let slot = 0; slot < g.cols * rows && index < dressed.length; slot++, index++) {
      const { item, picture } = dressed[index]
      const col = slot % g.cols
      const row = Math.floor(slot / g.cols)
      const x = PAGE_MARGIN.side + col * (g.cardW + g.gap)
      const y = top + row * (g.cardH + g.gap)
      doc.setFillColor(...CARD)
      doc.setDrawColor(...RULE)
      doc.roundedRect(x, y, g.cardW, g.cardH, 3, 3, "FD")
      // Thumbnail, fitted and centred in its well.
      const wellW = g.cardW - 8
      const scale = Math.min(wellW / picture.width, g.thumbH / picture.height)
      const tw = picture.width * scale
      const th = picture.height * scale
      doc.addImage(picture.dataUrl, "PNG", x + 4 + (wellW - tw) / 2, y + 4 + (g.thumbH - th) / 2, tw, th, undefined, "FAST")
      // Number chip + page.
      const ty = y + 4 + g.thumbH + 5.5
      doc.setFillColor(...ACCENT_SOFT)
      doc.roundedRect(x + 4, ty - 3.6, 8, 5, 1.5, 1.5, "F")
      doc.setFont("helvetica", "bold")
      doc.setFontSize(7)
      doc.setTextColor(...ACCENT)
      doc.text(String(item.n).padStart(2, "0"), x + 8, ty, { align: "center" })
      // The name gets the card's width; the page reference rides on the
      // route line below it, where a long name cannot squeeze it out.
      doc.setFont("helvetica", "bold")
      doc.setFontSize(8.5)
      doc.setTextColor(...INK)
      doc.text(fitText(doc, item.label, g.cardW - 18), x + 14, ty)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7)
      const pageRef = `p. ${ctx.pageOf(index)}`
      doc.setTextColor(...FAINT)
      doc.text(pageRef, x + g.cardW - 4, ty + 5.5, { align: "right" })
      doc.setTextColor(...MUTED)
      const sub = item.group ? `${item.route} · ${item.group}` : item.route
      doc.text(fitText(doc, sub, g.cardW - 12 - doc.getTextWidth(pageRef)), x + 4, ty + 5.5)
    }
    footer(doc, pageNo, ctx.totalPages, 210, 297)
    pageNo++
    first = false
  }
}

function header(doc: Pdf, project: string, right: string, pageW: number, groups: string[]) {
  doc.setFillColor(...ACCENT)
  doc.roundedRect(PAGE_MARGIN.side, 8.6, 4, 4, 1, 1, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.setTextColor(...INK)
  doc.text(project, PAGE_MARGIN.side + 6.5, 12)
  // The groups on this page, as chips beside the title.
  let x = PAGE_MARGIN.side + 6.5 + doc.getTextWidth(project) + 5
  doc.setFont("helvetica", "normal")
  doc.setFontSize(7.5)
  for (const group of groups) {
    const w = doc.getTextWidth(group) + 6
    if (x + w > pageW / 2 + 40) break
    doc.setFillColor(...ACCENT_SOFT)
    doc.roundedRect(x, 8.3, w, 5, 2.5, 2.5, "F")
    doc.setTextColor(...ACCENT)
    doc.text(group, x + 3, 11.8)
    x += w + 2
  }
  doc.setFontSize(8.5)
  doc.setTextColor(...MUTED)
  doc.text(right, pageW - PAGE_MARGIN.side, 12, { align: "right" })
  doc.setDrawColor(...RULE)
  doc.line(PAGE_MARGIN.side, 16, pageW - PAGE_MARGIN.side, 16)
}

function footer(doc: Pdf, page: number, total: number, pageW: number, pageH: number) {
  doc.setDrawColor(...RULE)
  doc.line(PAGE_MARGIN.side, pageH - 13, pageW - PAGE_MARGIN.side, pageH - 13)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(7.5)
  doc.setTextColor(...FAINT)
  doc.text("Made with TaskFlow", PAGE_MARGIN.side, pageH - 8)
  doc.text(`${page} / ${total}`, pageW - PAGE_MARGIN.side, pageH - 8, { align: "right" })
}

/// Hand the finished file to the browser as a download.
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
