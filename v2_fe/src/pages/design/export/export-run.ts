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

import "devices.css/dist/devices.min.css"

import { sandboxUrl } from "@/lib/design-api"
import type { DevicePreset } from "@/lib/design-devices"
import {
  CAPTION_H,
  PAGE_MARGIN,
  bestPageSetup,
  screenFileName,
  screensPerPage,
  slotOrigin,
  type ExportItem,
} from "./export-plan"

export type ExportOptions = {
  items: ExportItem[]
  device: DevicePreset
  sandboxToken: string
  theme: "light" | "dark"
  /// devices.css frame class (e.g. `iphone-14-pro`), or null for a bare,
  /// rounded screenshot.
  frame: string | null
  /// Corner radius in CSS px for a frameless screenshot.
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

export class ExportCancelled extends Error {}

const CAPTURE_TIMEOUT_MS = 45_000

/// Load `route` in a hidden iframe at the device's viewport and ask the page to
/// picture itself. Resolves with a PNG data URL at up to 2× (a phone's 3× is
/// more pixels than any PDF shows, and each one costs memory).
function capturePage(route: string, opts: ExportOptions): Promise<Picture> {
  const { device } = opts
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
      width: `${device.width}px`,
      height: `${device.height}px`,
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    })
    const id = `cap-${Math.random().toString(36).slice(2)}`
    let asked = false
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
      const data = event.data as { type?: string; id?: string; dataUrl?: string; error?: string; width?: number; height?: number }
      if (!data || typeof data !== "object") return
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
          const picture = { dataUrl: data.dataUrl, width: data.width ?? device.width, height: data.height ?? device.height }
          done(() => resolve(picture))
        }
      }
    }
    window.addEventListener("message", onMessage)
    frame.src = sandboxUrl(opts.sandboxToken, route)
    document.body.appendChild(frame)
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

/// How far below a frame's top edge a page starts, in the frame's own CSS px:
/// the status-bar strip that a notch or Dynamic Island sits in. A real phone
/// keeps it clear, and a screenshot laid under the island loses its header.
const STATUS_BAR: Record<string, number> = {
  "iphone-14-pro": 44,
  "iphone-14": 40,
  "iphone-x": 40,
  "google-pixel-6-pro": 26,
  "galaxy-s8": 20,
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

/// A screenshot inside an open-source device frame (devices.css, MIT). The
/// frame is real DOM in THIS document, rasterised with the screenshot as its
/// screen, at a scale that keeps the screenshot's own resolution.
async function inDeviceFrame(shot: Picture, frame: string): Promise<Picture> {
  const { domToPng } = await import("modern-screenshot")
  const holder = document.createElement("div")
  Object.assign(holder.style, { position: "fixed", left: "-20000px", top: "0", padding: "24px", background: "transparent" })
  holder.innerHTML = `
    <div class="device device-${frame}">
      <div class="device-frame"><img class="device-screen" alt="" /></div>
      <div class="device-stripe"></div><div class="device-header"></div>
      <div class="device-sensors"></div><div class="device-btns"></div>
      <div class="device-power"></div><div class="device-home"></div>
    </div>`
  const img = holder.querySelector("img")!
  // The frame's screen has its own proportions; cover it from the top, the
  // part of a page a viewer looks at first.
  Object.assign(img.style, {
    objectFit: "cover",
    objectPosition: "top",
    boxSizing: "border-box",
    paddingTop: `${STATUS_BAR[frame] ?? 0}px`,
    background: await topColor(shot.dataUrl),
  })
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

type Dressed = { item: ExportItem; picture: Picture }

async function captureAll(opts: ExportOptions): Promise<Dressed[]> {
  const out: Dressed[] = []
  const total = opts.items.length
  for (const item of opts.items) {
    if (opts.isCancelled()) throw new ExportCancelled()
    opts.onProgress(out.length, total, `Rendering ${item.label}`)
    const shot = await capturePage(item.route, opts)
    if (opts.isCancelled()) throw new ExportCancelled()
    const picture = opts.frame ? await inDeviceFrame(shot, opts.frame) : await roundAndShadow(shot, opts.radius)
    out.push({ item, picture })
  }
  opts.onProgress(total, total, opts.format === "pdf" ? "Laying out the PDF" : "Packing the images")
  return out
}

/// The whole export: capture, dress, assemble. Resolves with the file to save.
export async function runExport(opts: ExportOptions): Promise<Blob> {
  const dressed = await captureAll(opts)
  return opts.format === "pdf" ? buildPdf(dressed, opts) : buildZip(dressed)
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

const INK = [15, 23, 42] as const // slate-900
const MUTED = [100, 116, 139] as const // slate-500
const RULE = [226, 232, 240] as const // slate-200
const ACCENT = [37, 99, 235] as const // blue-600

async function buildPdf(dressed: Dressed[], opts: ExportOptions): Promise<Blob> {
  const { jsPDF } = await import("jspdf")
  // Every dressed picture of one export shares a size; plan the grid from it.
  const aspect = dressed.length ? dressed[0].picture.width / dressed[0].picture.height : opts.device.width / opts.device.height
  const perPage = screensPerPage(opts.device)
  const setup = bestPageSetup(aspect, perPage)
  const pages = Math.ceil(dressed.length / perPage)
  const totalPages = pages + 1 // + the cover
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
  const deviceLine = `${opts.device.label} · ${opts.device.width}×${opts.device.height}`

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true })
  doc.setProperties({ title: `${opts.projectName} — design`, subject: deviceLine, creator: "TaskFlow" })

  // Cover: what this is, for which device, and a contents list that says on
  // which page each screen is.
  const coverW = 210
  doc.setFillColor(...ACCENT)
  doc.rect(0, 0, coverW, 6, "F")
  doc.setTextColor(...MUTED)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text("DESIGN SCREENS", 20, 34, { charSpace: 0.6 })
  doc.setTextColor(...INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(28)
  const title = doc.splitTextToSize(opts.projectName, coverW - 40) as string[]
  doc.text(title, 20, 48)
  let y = 48 + title.length * 11
  doc.setFont("helvetica", "normal")
  doc.setFontSize(12)
  doc.setTextColor(...MUTED)
  doc.text(`${deviceLine}   ·   ${dressed.length} screen${dressed.length === 1 ? "" : "s"}   ·   ${opts.scopeLabel}`, 20, y)
  doc.text(date, 20, y + 7)
  y += 20
  doc.setDrawColor(...RULE)
  doc.line(20, y, coverW - 20, y)
  y += 10
  doc.setFontSize(10)
  let lastGroup: string | null | undefined
  for (const [index, { item }] of dressed.entries()) {
    if (y > 280) {
      doc.setTextColor(...MUTED)
      doc.text(`… and ${dressed.length - index} more`, 20, y)
      break
    }
    if (item.group !== lastGroup) {
      lastGroup = item.group
      doc.setFont("helvetica", "bold")
      doc.setTextColor(...MUTED)
      doc.text((item.group ?? "Ungrouped").toUpperCase(), 20, y, { charSpace: 0.4 })
      y += 6
    }
    doc.setFont("helvetica", "normal")
    doc.setTextColor(...INK)
    doc.text(`${item.n}.  ${item.label}`, 24, y)
    doc.setTextColor(...MUTED)
    doc.text(item.route, 120, y)
    doc.text(String(2 + Math.floor(index / perPage)), coverW - 20, y, { align: "right" })
    y += 6
  }
  footer(doc, 1, totalPages, coverW, 297)

  // Screen pages.
  for (let page = 0; page < pages; page++) {
    doc.addPage("a4", setup.orientation)
    const slice = dressed.slice(page * perPage, (page + 1) * perPage)
    header(doc, opts.projectName, deviceLine, setup.pageW)
    for (const [index, { item, picture }] of slice.entries()) {
      const origin = slotOrigin(setup, index)
      const x = origin.x + (setup.slotW - setup.imageW) / 2
      // The image and its caption are ONE block, centred in the slot — a
      // caption pinned to the slot's foot drifts away from a short image.
      const yImg = origin.y + (setup.slotH - (setup.imageH + CAPTION_H)) / 2
      doc.addImage(picture.dataUrl, "PNG", x, yImg, setup.imageW, setup.imageH, undefined, "FAST")
      // Caption: number and name, then the route, centred under the image.
      const cx = origin.x + setup.slotW / 2
      const cy = yImg + setup.imageH + 5
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9.5)
      doc.setTextColor(...INK)
      const name = doc.splitTextToSize(`${item.n}. ${item.label}`, setup.slotW)[0] as string
      doc.text(name, cx, cy, { align: "center" })
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...MUTED)
      const sub = item.group ? `${item.route}  ·  ${item.group}` : item.route
      doc.text(doc.splitTextToSize(sub, setup.slotW)[0] as string, cx, cy + 4.2, { align: "center" })
    }
    footer(doc, page + 2, totalPages, setup.pageW, setup.pageH)
  }
  return doc.output("blob")
}

type Pdf = InstanceType<(typeof import("jspdf"))["jsPDF"]>

function header(doc: Pdf, project: string, device: string, pageW: number) {
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.setTextColor(...INK)
  doc.text(project, PAGE_MARGIN.side, 12)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(...MUTED)
  doc.text(device, pageW - PAGE_MARGIN.side, 12, { align: "right" })
  doc.setDrawColor(...RULE)
  doc.line(PAGE_MARGIN.side, 15, pageW - PAGE_MARGIN.side, 15)
}

function footer(doc: Pdf, page: number, total: number, pageW: number, pageH: number) {
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
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
