import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  Loader2Icon,
  Maximize2Icon,
  RotateCcwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  formatBytes,
  getAttachmentKind,
  getCodeLanguage,
  getFileExtension,
  INLINE_TEXT_MAX_BYTES,
  removeFileExtension,
  type AttachmentKind,
} from "@/lib/attachment-kind"
import { highlightCode } from "@/lib/shiki-highlighter"

export type MessageAttachmentItem = {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  url: string
  pending?: boolean
}

const minPreviewZoom = 1
const maxPreviewZoom = 3
const previewZoomStep = 0.25

/// Rich inline renderer for a chat message's attachments. Images lay out as a
/// wrapping thumbnail grid with a zoomable/carousel lightbox; every other kind
/// renders inline (PDF iframe, spreadsheet table, code/text blocks, media
/// players) with a download card as the last-resort fallback.
export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachmentItem[]
}) {
  const items = React.useMemo(() => attachments ?? [], [attachments])
  const [activeImageIndex, setActiveImageIndex] = React.useState<number | null>(null)

  if (!items.length) return null

  const images = items.filter((item) => kindOf(item) === "image")
  const others = items.filter((item) => kindOf(item) !== "image")

  return (
    <>
      <div className="grid gap-2">
        {images.length ? (
          <ImageAttachmentGrid
            images={images}
            onOpen={(index) => setActiveImageIndex(index)}
          />
        ) : null}

        {others.map((item) => (
          <InlineAttachment key={item.id} attachment={item} />
        ))}
      </div>

      {images.length ? (
        <ImageLightbox
          images={images}
          activeIndex={activeImageIndex ?? 0}
          open={activeImageIndex !== null}
          onIndexChange={setActiveImageIndex}
          onClose={() => setActiveImageIndex(null)}
        />
      ) : null}
    </>
  )
}

function kindOf(attachment: MessageAttachmentItem): AttachmentKind {
  return getAttachmentKind(attachment.contentType, attachment.name)
}

// ---------------------------------------------------------------------------
// Dispatch for non-image attachments
// ---------------------------------------------------------------------------

function InlineAttachment({ attachment }: { attachment: MessageAttachmentItem }) {
  const kind = kindOf(attachment)

  // Optimistic (not-yet-stored) non-image attachment: no reachable URL to fetch
  // or embed, so show a lightweight uploading card instead of a broken preview.
  if (attachment.pending || !attachment.url) {
    return <PendingCard attachment={attachment} kind={kind} />
  }

  if (kind === "pdf") return <PdfInline attachment={attachment} />
  if (kind === "spreadsheet") return <SpreadsheetPreview attachment={attachment} />
  if (kind === "video") return <VideoInline attachment={attachment} />
  if (kind === "audio") return <AudioInline attachment={attachment} />

  if (kind === "code" && attachment.sizeBytes <= INLINE_TEXT_MAX_BYTES) {
    return <CodePreview attachment={attachment} />
  }
  if (kind === "text" && attachment.sizeBytes <= INLINE_TEXT_MAX_BYTES) {
    return <TextPreview attachment={attachment} />
  }

  return <FileCard attachment={attachment} kind={kind} />
}

// ---------------------------------------------------------------------------
// Images: thumbnail grid + lightbox
// ---------------------------------------------------------------------------

function ImageAttachmentGrid({
  images,
  onOpen,
}: {
  images: MessageAttachmentItem[]
  onOpen: (index: number) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((attachment, index) =>
        attachment.url ? (
          <button
            key={attachment.id}
            type="button"
            className="group relative block overflow-hidden rounded-lg border bg-muted text-left outline-none transition-[border-color,box-shadow] hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/40"
            title={attachment.name}
            onClick={() => onOpen(index)}
          >
            <AttachmentImage
              attachment={attachment}
              className="max-h-64 w-auto max-w-full rounded-lg object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          </button>
        ) : (
          <span
            key={attachment.id}
            className="flex h-32 w-32 items-center justify-center rounded-lg border bg-muted text-muted-foreground"
            title={attachment.name}
          >
            <ImageIcon className="size-6 animate-pulse" />
          </span>
        )
      )}
    </div>
  )
}

function ImageLightbox({
  images,
  activeIndex,
  open,
  onIndexChange,
  onClose,
}: {
  images: MessageAttachmentItem[]
  activeIndex: number
  open: boolean
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const [zoomState, setZoomState] = React.useState<{ id: string; value: number } | null>(
    null
  )
  const previewRef = React.useRef<HTMLDivElement>(null)
  const active = images[activeIndex]
  const canNavigate = images.length > 1
  const zoomKey = active?.id ?? ""
  const zoom = zoomState?.id === zoomKey ? zoomState.value : 1

  if (!active) return null

  function updateZoom(value: number | ((current: number) => number)) {
    const next = typeof value === "function" ? value(zoom) : value
    setZoomState({ id: zoomKey, value: clampZoom(next) })
  }

  function goTo(offset: number) {
    onIndexChange((activeIndex + offset + images.length) % images.length)
  }

  async function toggleFullscreen() {
    const element = previewRef.current
    if (!element) return
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    await element.requestFullscreen?.()
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setZoomState(null)
      onClose()
    }
  }

  return (
    <DialogPrimitive.Root open={open} modal="trap-focus" onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-80 bg-[oklch(0.08_0.004_255_/_0.92)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          ref={previewRef}
          className="fixed inset-0 z-81 flex flex-col bg-background text-foreground outline-none sm:inset-3 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-border/70 sm:shadow-2xl"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-card/95 px-3 sm:h-16 sm:px-4">
            <DialogPrimitive.Title className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{active.name}</span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {getFileExtension(active.name).toUpperCase() || "Image"}
                {active.sizeBytes ? ` · ${formatBytes(active.sizeBytes)}` : ""}
                {canNavigate ? ` · ${activeIndex + 1} of ${images.length}` : ""}
              </span>
            </DialogPrimitive.Title>

            <div className="hidden items-center gap-1 sm:flex">
              <PreviewZoomControls zoom={zoom} onZoomChange={updateZoom} />
            </div>

            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="hidden rounded-lg sm:inline-flex"
              onClick={() => void toggleFullscreen()}
            >
              <Maximize2Icon />
              <span className="sr-only">Fullscreen</span>
            </Button>
            <DownloadButton attachment={active} />
            <DialogPrimitive.Close
              render={<Button type="button" variant="outline" size="icon-sm" className="rounded-lg" />}
            >
              <XIcon />
              <span className="sr-only">Close preview</span>
            </DialogPrimitive.Close>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/35">
            {canNavigate ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="absolute top-1/2 left-2 z-10 hidden -translate-y-1/2 rounded-full bg-background/90 shadow-lg sm:inline-flex"
                  onClick={() => goTo(-1)}
                >
                  <ChevronLeftIcon />
                  <span className="sr-only">Previous image</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 rounded-full bg-background/90 shadow-lg sm:inline-flex"
                  onClick={() => goTo(1)}
                >
                  <ChevronRightIcon />
                  <span className="sr-only">Next image</span>
                </Button>
              </>
            ) : null}

            <div className="h-full min-h-0 overflow-auto p-3 overscroll-contain [touch-action:pan-x_pan-y] sm:p-6">
              <div
                className="flex min-h-full min-w-full items-center justify-center"
                style={{ height: `${zoom * 100}%`, width: `${zoom * 100}%` }}
              >
                <AttachmentImage
                  attachment={active}
                  className="h-full w-full rounded-xl object-contain shadow-2xl transition-[height,width] duration-150"
                />
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3 sm:hidden">
              <div className="pointer-events-auto rounded-xl border border-border/70 bg-background/95 p-1 shadow-2xl backdrop-blur">
                <PreviewZoomControls zoom={zoom} onZoomChange={updateZoom} />
              </div>
            </div>
          </div>

          {canNavigate ? (
            <div className="flex h-12 shrink-0 items-center justify-between border-t border-border/70 bg-card/95 px-3 sm:hidden">
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => goTo(-1)}>
                <ChevronLeftIcon />
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {activeIndex + 1} / {images.length}
              </span>
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => goTo(1)}>
                Next
                <ChevronRightIcon />
              </Button>
            </div>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function PreviewZoomControls({
  zoom,
  onZoomChange,
}: {
  zoom: number
  onZoomChange: (value: number | ((current: number) => number)) => void
}) {
  return (
    <div className="flex min-w-[13.75rem] items-center justify-between gap-1 whitespace-nowrap">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="h-9 min-w-10 rounded-lg"
        disabled={zoom <= minPreviewZoom}
        onClick={() => onZoomChange((value) => value - previewZoomStep)}
      >
        <ZoomOutIcon />
        <span className="sr-only">Zoom out</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="h-9 min-w-10 rounded-lg"
        onClick={() => onZoomChange(1)}
      >
        <RotateCcwIcon />
        <span className="sr-only">Reset zoom</span>
      </Button>
      <span className="flex min-w-14 items-center justify-center px-1 text-[11px] font-medium text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="h-9 min-w-10 rounded-lg"
        disabled={zoom >= maxPreviewZoom}
        onClick={() => onZoomChange((value) => value + previewZoomStep)}
      >
        <ZoomInIcon />
        <span className="sr-only">Zoom in</span>
      </Button>
    </div>
  )
}

function AttachmentImage({
  attachment,
  className,
}: {
  attachment: MessageAttachmentItem
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)
  const extension = getFileExtension(attachment.name).toUpperCase()

  if (failed) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-muted-foreground",
          className
        )}
      >
        <ImageIcon className="size-7" />
        <span className="text-xs font-medium">{extension || "Image"} preview unavailable</span>
      </div>
    )
  }

  return (
    <img
      src={attachment.url}
      alt={attachment.name}
      className={className}
      onError={() => setFailed(true)}
    />
  )
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function PdfInline({ attachment }: { attachment: MessageAttachmentItem }) {
  const embeddable = canEmbedUrl(attachment.url)

  return (
    <div className="overflow-hidden rounded-xl border bg-background/90 shadow-sm">
      <div className="flex items-center gap-2 border-b bg-card/70 px-3 py-2">
        <FileTextIcon className="size-4 shrink-0 text-red-700 dark:text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-xs text-muted-foreground">
            PDF{attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </p>
        </div>
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "xs" }), "rounded-lg")}
        >
          Open
        </a>
        <DownloadButton attachment={attachment} compact />
      </div>
      {embeddable ? (
        <iframe
          src={attachment.url}
          title={attachment.name}
          className="h-[70vh] max-h-[70vh] w-full bg-background"
        />
      ) : (
        <div className="p-4 text-sm text-muted-foreground">
          This PDF can't be embedded here. Use Open or Download above.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------

type SpreadsheetSheet = {
  name: string
  columns: string[]
  rows: string[][]
}

type SpreadsheetState =
  | { status: "loading" }
  | { status: "ready"; sheets: SpreadsheetSheet[] }
  | { status: "error" }

function SpreadsheetPreview({ attachment }: { attachment: MessageAttachmentItem }) {
  const [state, setState] = React.useState<SpreadsheetState>({ status: "loading" })
  const [selectedSheet, setSelectedSheet] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    let alive = true

    async function load() {
      try {
        const sheets = await parseSpreadsheet(attachment.url, controller.signal)
        if (!alive) return
        setState(sheets.length ? { status: "ready", sheets } : { status: "error" })
      } catch {
        if (!alive || controller.signal.aborted) return
        setState({ status: "error" })
      }
    }

    void load()

    return () => {
      alive = false
      controller.abort()
    }
  }, [attachment.url])

  if (state.status === "loading") {
    return (
      <SpreadsheetShell attachment={attachment}>
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Reading worksheet…
        </div>
      </SpreadsheetShell>
    )
  }

  if (state.status === "error") {
    return <FileCard attachment={attachment} kind="spreadsheet" />
  }

  const active =
    state.sheets.find((sheet) => sheet.name === selectedSheet) ??
    state.sheets.find((sheet) => sheet.rows.length) ??
    state.sheets[0]
  const columns = active?.columns ?? []
  const rows = active?.rows ?? []
  const minTableWidth = Math.max(480, columns.length * 148)

  return (
    <SpreadsheetShell attachment={attachment} rowCount={rows.length}>
      {state.sheets.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:thin]">
          {state.sheets.map((sheet) => (
            <button
              key={sheet.name}
              type="button"
              className={cn(
                "shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                sheet.name === active?.name
                  ? "border-primary/35 bg-primary/10 text-primary"
                  : "border-border/70 bg-background/70 text-muted-foreground hover:bg-muted"
              )}
              onClick={() => setSelectedSheet(sheet.name)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      {rows.length && columns.length ? (
        <div className="max-h-96 overflow-auto overscroll-contain [scrollbar-width:thin] [touch-action:pan-x_pan-y]">
          <table className="w-full text-left text-sm" style={{ minWidth: minTableWidth }}>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                {columns.map((column, columnIndex) => (
                  <th
                    key={`${column}-${columnIndex}`}
                    className="min-w-36 whitespace-nowrap px-3 py-2.5 font-medium"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="odd:bg-background even:bg-muted/25">
                  {columns.map((_, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="min-w-36 whitespace-nowrap px-3 py-2.5 text-[13px]"
                    >
                      {row[columnIndex] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">This sheet has no rows.</div>
      )}
    </SpreadsheetShell>
  )
}

function SpreadsheetShell({
  attachment,
  rowCount,
  children,
}: {
  attachment: MessageAttachmentItem
  rowCount?: number
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background/90 shadow-sm">
      <div className="flex items-center gap-2 border-b bg-card/70 px-3 py-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
          <FileSpreadsheetIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{removeFileExtension(attachment.name)}</p>
          <p className="text-xs text-muted-foreground">
            {typeof rowCount === "number"
              ? `${rowCount} ${rowCount === 1 ? "row" : "rows"} previewed`
              : "Spreadsheet"}
            {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </p>
        </div>
        <DownloadButton attachment={attachment} compact />
      </div>
      {children}
    </div>
  )
}

async function parseSpreadsheet(
  url: string,
  signal: AbortSignal
): Promise<SpreadsheetSheet[]> {
  const XLSX = await import("xlsx")
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error("Unable to load spreadsheet")

  const buffer = await response.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })

  return workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      blankrows: false,
      defval: "",
      header: 1,
      raw: false,
    })
    const normalized = matrix
      .map((row) => row.map((cell) => String(cell ?? "").trim()))
      .filter((row) => row.some(Boolean))
      .slice(0, 51)

    if (!normalized.length) return { name: sheetName, columns: [], rows: [] }

    const headerRow = normalized[0]
    const dataRows = normalized.slice(1)
    const columns = headerRow.map((value, index) => value.trim() || `Column ${index + 1}`)

    return {
      name: sheetName,
      columns,
      rows: dataRows.length ? dataRows : [headerRow],
    }
  })
}

// ---------------------------------------------------------------------------
// Code + text (net-new)
// ---------------------------------------------------------------------------

type TextFetchState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error" }

function useTextContent(url: string): TextFetchState {
  const [state, setState] = React.useState<TextFetchState>({ status: "loading" })

  React.useEffect(() => {
    const controller = new AbortController()
    let alive = true

    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error("fetch failed")
        const text = await response.text()
        if (!alive) return
        setState({ status: "ready", text })
      } catch {
        if (!alive || controller.signal.aborted) return
        setState({ status: "error" })
      }
    }

    void load()

    return () => {
      alive = false
      controller.abort()
    }
  }, [url])

  return state
}

function CodePreview({ attachment }: { attachment: MessageAttachmentItem }) {
  const content = useTextContent(attachment.url)
  const [html, setHtml] = React.useState<string | null>(null)
  const [highlightFailed, setHighlightFailed] = React.useState(false)
  const language = getCodeLanguage(attachment.name) ?? "text"

  React.useEffect(() => {
    if (content.status !== "ready") return
    let alive = true
    highlightCode(content.text, language)
      .then((result) => {
        if (alive) setHtml(result)
      })
      .catch(() => {
        if (alive) setHighlightFailed(true)
      })
    return () => {
      alive = false
    }
  }, [content, language])

  if (content.status === "error") {
    return <FileCard attachment={attachment} kind="code" />
  }

  const raw = content.status === "ready" ? content.text : ""

  return (
    <TextShell attachment={attachment} icon={<FileCodeIcon className="size-4" />} raw={raw}>
      {content.status === "loading" || (!html && !highlightFailed) ? (
        <TextSkeleton />
      ) : html && !highlightFailed ? (
        <div
          className="shiki-scroll max-h-96 overflow-auto overscroll-contain [scrollbar-width:thin] [touch-action:pan-x_pan-y]"
          // Shiki output is generated from the file text on the client; safe to inject.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 text-[13px] leading-6 [scrollbar-width:thin]">
          {raw}
        </pre>
      )}
    </TextShell>
  )
}

function TextPreview({ attachment }: { attachment: MessageAttachmentItem }) {
  const content = useTextContent(attachment.url)

  if (content.status === "error") {
    return <FileCard attachment={attachment} kind="text" />
  }

  const raw = content.status === "ready" ? content.text : ""

  return (
    <TextShell attachment={attachment} icon={<FileTextIcon className="size-4" />} raw={raw}>
      {content.status === "loading" ? (
        <TextSkeleton />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 text-[13px] leading-6 [scrollbar-width:thin] [touch-action:pan-x_pan-y]">
          {raw}
        </pre>
      )}
    </TextShell>
  )
}

function TextShell({
  attachment,
  icon,
  raw,
  children,
}: {
  attachment: MessageAttachmentItem
  icon: React.ReactNode
  raw: string
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background/90 shadow-sm">
      <div className="flex items-center gap-2 border-b bg-card/70 px-3 py-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-xs text-muted-foreground">
            {getFileExtension(attachment.name).toUpperCase() || "TEXT"}
            {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </p>
        </div>
        <CopyButton text={raw} />
        <DownloadButton attachment={attachment} compact />
      </div>
      {children}
    </div>
  )
}

function TextSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {[80, 62, 71, 45].map((width, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-muted"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (insecure context); ignore.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="rounded-lg"
      disabled={!text}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
      <span className="sr-only">{copied ? "Copied" : "Copy contents"}</span>
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function VideoInline({ attachment }: { attachment: MessageAttachmentItem }) {
  return (
    <div className="max-w-[28rem] overflow-hidden rounded-xl border bg-background/90 shadow-sm">
      <video
        src={attachment.url}
        controls
        preload="metadata"
        className="aspect-video w-full bg-[oklch(0.12_0.003_255)]"
      />
      <div className="flex items-center gap-2 px-3 py-2">
        <FileVideoIcon className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-xs text-muted-foreground">
            Video{attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </p>
        </div>
        <DownloadButton attachment={attachment} compact />
      </div>
    </div>
  )
}

function AudioInline({ attachment }: { attachment: MessageAttachmentItem }) {
  return (
    <div className="max-w-[28rem] rounded-xl border bg-background/90 p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
          <FileAudioIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-xs text-muted-foreground">
            Audio{attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </p>
        </div>
        <DownloadButton attachment={attachment} compact />
      </div>
      <audio src={attachment.url} controls preload="metadata" className="w-full" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

function FileCard({
  attachment,
  kind,
}: {
  attachment: MessageAttachmentItem
  kind: AttachmentKind
}) {
  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-lg border bg-background/90 p-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
        <KindIcon kind={kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{attachment.name}</p>
        <p className="text-xs text-muted-foreground">{formatBytes(attachment.sizeBytes)}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        render={
          <a href={attachment.url} target="_blank" rel="noreferrer" download={attachment.name} />
        }
      >
        <DownloadIcon className="size-3.5" />
        Download
      </Button>
    </div>
  )
}

function PendingCard({
  attachment,
  kind,
}: {
  attachment: MessageAttachmentItem
  kind: AttachmentKind
}) {
  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-lg border bg-background/90 p-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <KindIcon kind={kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{attachment.name}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          Uploading…
        </p>
      </div>
    </div>
  )
}

function DownloadButton({
  attachment,
  compact = false,
}: {
  attachment: MessageAttachmentItem
  compact?: boolean
}) {
  return (
    <a
      href={attachment.url}
      download={attachment.name}
      target="_blank"
      rel="noreferrer"
      className={cn(
        buttonVariants({ variant: compact ? "ghost" : "outline", size: "icon-sm" }),
        "rounded-lg"
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <DownloadIcon />
      <span className="sr-only">Download {attachment.name}</span>
    </a>
  )
}

function KindIcon({ kind }: { kind: AttachmentKind }) {
  if (kind === "image") return <ImageIcon className="size-4" />
  if (kind === "pdf") return <FileTextIcon className="size-4" />
  if (kind === "spreadsheet") return <FileSpreadsheetIcon className="size-4" />
  if (kind === "video") return <FileVideoIcon className="size-4" />
  if (kind === "audio") return <FileAudioIcon className="size-4" />
  if (kind === "code") return <FileCodeIcon className="size-4" />
  if (kind === "text") return <FileTextIcon className="size-4" />
  return <FileIcon className="size-4" />
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampZoom(value: number): number {
  return Math.min(maxPreviewZoom, Math.max(minPreviewZoom, value))
}

/// Only embed/fetch same-origin (or blob/data) URLs. Ours are always
/// `/media/<key>`, but keep the guard for safety.
function canEmbedUrl(url: string): boolean {
  if (url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:")) {
    return true
  }
  if (typeof window === "undefined") return false
  try {
    return new URL(url, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}
