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

/// Chat message attachment renderer. Inline shows only lightweight content: an
/// image gallery at natural size, full-width file cards, and inline video/audio
/// players. Every rich preview (image zoom, PDF, spreadsheet, Shiki code, text)
/// lives in a single popup carousel that pages across ALL of the message's
/// attachments in their original order.
export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachmentItem[]
}) {
  const items = React.useMemo(() => attachments ?? [], [attachments])
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)

  if (!items.length) return null

  const images = items
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => kindOf(attachment) === "image")
  const others = items
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => kindOf(attachment) !== "image")

  return (
    <>
      <div className="grid gap-2">
        {images.length ? (
          <ImageAttachmentGrid images={images} onOpen={setActiveIndex} />
        ) : null}

        {others.length ? (
          <div className="grid gap-2">
            {others.map(({ attachment, index }) => (
              <InlineAttachment
                key={attachment.id}
                attachment={attachment}
                onOpen={() => setActiveIndex(index)}
              />
            ))}
          </div>
        ) : null}
      </div>

      <AttachmentPreviewDialog
        attachments={items}
        activeIndex={activeIndex ?? 0}
        open={activeIndex !== null}
        onIndexChange={setActiveIndex}
        onOpenChange={(open) => {
          if (!open) setActiveIndex(null)
        }}
      />
    </>
  )
}

function kindOf(attachment: MessageAttachmentItem): AttachmentKind {
  return getAttachmentKind(attachment.contentType, attachment.name)
}

// ---------------------------------------------------------------------------
// Inline dispatch for non-image attachments
// ---------------------------------------------------------------------------

function InlineAttachment({
  attachment,
  onOpen,
}: {
  attachment: MessageAttachmentItem
  onOpen: () => void
}) {
  const kind = kindOf(attachment)

  // Optimistic (not-yet-stored) non-image attachment: no reachable URL to fetch
  // or embed, so show a lightweight uploading card instead of a broken preview.
  if (attachment.pending || !attachment.url) {
    return <PendingCard attachment={attachment} kind={kind} />
  }

  if (kind === "video") return <VideoInline attachment={attachment} onOpen={onOpen} />
  if (kind === "audio") return <AudioInline attachment={attachment} onOpen={onOpen} />

  return <FileCard attachment={attachment} kind={kind} onOpen={onOpen} />
}

// ---------------------------------------------------------------------------
// Images: inline gallery
// ---------------------------------------------------------------------------

// The gallery is capped so images never dominate the bubble. A lone image shows
// at its own aspect ratio (contained, not cropped); several images tile into a
// compact grid of cropped thumbnails with a "+N" overflow. Either way, clicking
// opens the full-size popup.
const GALLERY_MAX_WIDTH = "min(22rem, 100%)"
// How many thumbnails a multi-image gallery shows before collapsing the rest
// into a "+N" tile.
const GALLERY_VISIBLE_TILES = 4

function ImageAttachmentGrid({
  images,
  onOpen,
}: {
  images: { attachment: MessageAttachmentItem; index: number }[]
  onOpen: (index: number) => void
}) {
  // Single image: render contained at its natural aspect ratio (no crop, no
  // upscale past its own size), capped so a large image can't fill the bubble.
  if (images.length === 1) {
    const { attachment, index } = images[0]
    return (
      <div style={{ maxWidth: GALLERY_MAX_WIDTH }}>
        <button
          type="button"
          className="group relative block overflow-hidden rounded-xl border bg-muted outline-none transition-[border-color,box-shadow] hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/40"
          title={attachment.name}
          onClick={() => onOpen(index)}
        >
          {attachment.url ? (
            <AttachmentImage
              attachment={attachment}
              className="max-h-72 w-auto max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <span className="flex h-40 w-40 items-center justify-center text-muted-foreground">
              <ImageIcon className="size-6 animate-pulse" />
            </span>
          )}
        </button>
      </div>
    )
  }

  // Several images: a compact tiled gallery. Two columns, square thumbnails
  // (cropped just for the tile; the popup shows the whole image), with the
  // overflow past GALLERY_VISIBLE_TILES collapsed into a "+N" last tile.
  const visible = images.slice(0, GALLERY_VISIBLE_TILES)
  const overflow = images.length - visible.length

  return (
    <div className="grid grid-cols-2 gap-1.5" style={{ maxWidth: GALLERY_MAX_WIDTH }}>
      {visible.map(({ attachment, index }, tileIndex) => {
        const isLastVisible = tileIndex === visible.length - 1
        return (
          <button
            key={attachment.id}
            type="button"
            className="group relative block aspect-square overflow-hidden rounded-lg border bg-muted outline-none transition-[border-color,box-shadow] hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/40"
            title={attachment.name}
            onClick={() => onOpen(index)}
          >
            {attachment.url ? (
              <AttachmentImage
                attachment={attachment}
                className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
              />
            ) : (
              <span className="flex size-full items-center justify-center text-muted-foreground">
                <ImageIcon className="size-6 animate-pulse" />
              </span>
            )}
            {isLastVisible && overflow > 0 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-semibold text-white">
                +{overflow}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline media players
// ---------------------------------------------------------------------------

function VideoInline({
  attachment,
  onOpen,
}: {
  attachment: MessageAttachmentItem
  onOpen: () => void
}) {
  return (
    <div className="w-full overflow-hidden rounded-xl border bg-background/90 shadow-sm">
      <video
        src={attachment.url}
        controls
        preload="metadata"
        className="aspect-video w-full bg-[oklch(0.12_0.003_255)]"
      />
      <div className="flex items-center gap-2 px-3 py-2">
        <FileVideoIcon className="size-4 shrink-0 text-primary" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left outline-none"
          onClick={onOpen}
        >
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Video{attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </span>
        </button>
        <DownloadButton attachment={attachment} compact />
      </div>
    </div>
  )
}

function AudioInline({
  attachment,
  onOpen,
}: {
  attachment: MessageAttachmentItem
  onOpen: () => void
}) {
  return (
    <div className="w-full rounded-xl border bg-background/90 p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
          <FileAudioIcon className="size-4" />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left outline-none"
          onClick={onOpen}
        >
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Audio{attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </span>
        </button>
        <DownloadButton attachment={attachment} compact />
      </div>
      <audio src={attachment.url} controls preload="metadata" className="w-full" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Full-width file card (non-image, non-media)
// ---------------------------------------------------------------------------

function FileCard({
  attachment,
  kind,
  onOpen,
}: {
  attachment: MessageAttachmentItem
  kind: AttachmentKind
  onOpen?: () => void
}) {
  return (
    <div className="flex w-full items-center gap-3 overflow-hidden rounded-lg border bg-background/90 p-2.5">
      {onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
          onClick={onOpen}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
            <KindIcon kind={kind} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{attachment.name}</span>
            <span className="block text-xs text-muted-foreground">
              {getFileExtension(attachment.name).toUpperCase() || "FILE"}
              {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
            </span>
          </span>
        </button>
      ) : (
        <>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
            <KindIcon kind={kind} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{attachment.name}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(attachment.sizeBytes)}</p>
          </div>
        </>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        render={
          <a href={attachment.url} target="_blank" rel="noreferrer" download={attachment.name} />
        }
        onClick={(event) => event.stopPropagation()}
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
    <div className="flex w-full items-center gap-3 overflow-hidden rounded-lg border bg-background/90 p-2.5">
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

// ---------------------------------------------------------------------------
// Popup carousel — hosts ALL rich content
// ---------------------------------------------------------------------------

function AttachmentPreviewDialog({
  attachments,
  activeIndex,
  open,
  onIndexChange,
  onOpenChange,
}: {
  attachments: MessageAttachmentItem[]
  activeIndex: number
  open: boolean
  onIndexChange: (index: number) => void
  onOpenChange: (open: boolean) => void
}) {
  const [zoomState, setZoomState] = React.useState<{ id: string; value: number } | null>(
    null
  )
  const previewRef = React.useRef<HTMLDivElement>(null)
  const active = attachments[activeIndex]
  const kind = active ? kindOf(active) : "file"
  const canZoom = kind === "image" || kind === "pdf"
  const canNavigate = attachments.length > 1
  const zoomKey = active?.id ?? ""
  const zoom = zoomState?.id === zoomKey ? zoomState.value : 1

  if (!active) return null

  function updateZoom(value: number | ((current: number) => number)) {
    const next = typeof value === "function" ? value(zoom) : value
    setZoomState({ id: zoomKey, value: clampZoom(next) })
  }

  function goTo(offset: number) {
    onIndexChange((activeIndex + offset + attachments.length) % attachments.length)
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
    if (!nextOpen) setZoomState(null)
    onOpenChange(nextOpen)
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
                {kindLabel(active)}
                {active.sizeBytes ? ` · ${formatBytes(active.sizeBytes)}` : ""}
                {canNavigate ? ` · ${activeIndex + 1} of ${attachments.length}` : ""}
              </span>
            </DialogPrimitive.Title>

            {canZoom ? (
              <div className="hidden items-center gap-1 sm:flex">
                <PreviewZoomControls zoom={zoom} onZoomChange={updateZoom} />
              </div>
            ) : null}

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
                  <span className="sr-only">Previous attachment</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 rounded-full bg-background/90 shadow-lg sm:inline-flex"
                  onClick={() => goTo(1)}
                >
                  <ChevronRightIcon />
                  <span className="sr-only">Next attachment</span>
                </Button>
              </>
            ) : null}

            <AttachmentPreviewContent attachment={active} zoom={zoom} />

            {canZoom ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3 sm:hidden">
                <div className="pointer-events-auto rounded-xl border border-border/70 bg-background/95 p-1 shadow-2xl backdrop-blur">
                  <PreviewZoomControls zoom={zoom} onZoomChange={updateZoom} />
                </div>
              </div>
            ) : null}
          </div>

          {canNavigate ? (
            <div className="flex h-12 shrink-0 items-center justify-between border-t border-border/70 bg-card/95 px-3 sm:hidden">
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => goTo(-1)}>
                <ChevronLeftIcon />
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {activeIndex + 1} / {attachments.length}
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

function AttachmentPreviewContent({
  attachment,
  zoom,
}: {
  attachment: MessageAttachmentItem
  zoom: number
}) {
  const kind = kindOf(attachment)

  if (attachment.pending || !attachment.url) {
    return <GenericFilePreview attachment={attachment} kind={kind} pending />
  }

  if (kind === "image") {
    return (
      <div className="h-full min-h-0 overflow-auto p-3 overscroll-contain [touch-action:pan-x_pan-y] sm:p-6">
        <div
          className="flex min-h-full min-w-full items-center justify-center"
          style={{ height: `${zoom * 100}%`, width: `${zoom * 100}%` }}
        >
          <AttachmentImage
            attachment={attachment}
            className="h-full w-full rounded-xl object-contain shadow-2xl transition-[height,width] duration-150"
          />
        </div>
      </div>
    )
  }

  if (kind === "pdf") return <PdfPreview attachment={attachment} zoom={zoom} />
  if (kind === "spreadsheet") return <ScrollPanel><SpreadsheetPreview attachment={attachment} /></ScrollPanel>

  if (kind === "code" && attachment.sizeBytes <= INLINE_TEXT_MAX_BYTES) {
    return <ScrollPanel><CodePreview attachment={attachment} /></ScrollPanel>
  }
  if (kind === "text" && attachment.sizeBytes <= INLINE_TEXT_MAX_BYTES) {
    return <ScrollPanel><TextPreview attachment={attachment} /></ScrollPanel>
  }

  if (kind === "video") {
    return (
      <div className="flex h-full items-center justify-center p-3 sm:p-6">
        <video
          src={attachment.url}
          controls
          className="max-h-full max-w-full rounded-xl bg-[oklch(0.12_0.003_255)] shadow-2xl"
        />
      </div>
    )
  }

  if (kind === "audio") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-4 shadow-xl">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300">
              <FileAudioIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{attachment.name}</div>
              <div className="text-xs text-muted-foreground">
                {attachment.sizeBytes ? formatBytes(attachment.sizeBytes) : "Audio"}
              </div>
            </div>
          </div>
          <audio src={attachment.url} controls className="w-full" />
        </div>
      </div>
    )
  }

  return <GenericFilePreview attachment={attachment} kind={kind} />
}

/// Scrollable host for the card-shaped renderers (spreadsheet/code/text) reused
/// from the inline path — centers the card and lets its own scroll regions work.
function ScrollPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-auto p-3 overscroll-contain [scrollbar-width:thin] sm:p-6">
      <div className="mx-auto max-w-4xl">{children}</div>
    </div>
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
// PDF (blob-URL embed — bypasses the media backend's X-Frame-Options: DENY)
// ---------------------------------------------------------------------------

// Cap on how large a PDF we'll pull into memory to embed. Bigger ones fall
// back to Open/Download so a huge file never stalls the popup.
const PDF_EMBED_MAX_BYTES = 20 * 1024 * 1024

type PdfState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "error" }
  | { status: "too-large" }

/// Fetch the PDF bytes and expose a same-document `blob:` URL. Blob URLs aren't
/// subject to `X-Frame-Options`, so the embed works regardless of that header
/// or cross-origin media hosting. This is the load-bearing approach — keep it.
function usePdfObjectUrl(attachment: MessageAttachmentItem): PdfState {
  const [state, setState] = React.useState<PdfState>(() =>
    canEmbedUrl(attachment.url) ? { status: "loading" } : { status: "error" }
  )

  React.useEffect(() => {
    if (!canEmbedUrl(attachment.url)) {
      setState({ status: "error" })
      return
    }
    if (attachment.pending) return
    if (attachment.sizeBytes && attachment.sizeBytes > PDF_EMBED_MAX_BYTES) {
      setState({ status: "too-large" })
      return
    }

    const controller = new AbortController()
    let objectUrl: string | null = null
    setState({ status: "loading" })

    fetch(attachment.url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setState({ status: "ready", src: objectUrl })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setState({ status: "error" })
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.url, attachment.pending, attachment.sizeBytes])

  return state
}

function PdfPreview({
  attachment,
  zoom,
}: {
  attachment: MessageAttachmentItem
  zoom: number
}) {
  const state = usePdfObjectUrl(attachment)

  if (state.status === "ready") {
    return (
      <div className="h-full min-h-0 overflow-auto p-2 overscroll-contain [touch-action:pan-x_pan-y] sm:p-4">
        <div
          className="min-h-full min-w-full"
          style={{ height: `${zoom * 100}%`, width: `${zoom * 100}%` }}
        >
          <iframe
            src={state.src}
            title={attachment.name}
            className="h-full w-full rounded-xl border border-border bg-background"
          />
        </div>
      </div>
    )
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 text-center shadow-xl">
        <span className="mx-auto flex size-14 items-center justify-center rounded-xl bg-red-500/10 text-red-700 dark:text-red-300">
          <FileTextIcon className="size-6" />
        </span>
        <h3 className="mt-4 truncate text-sm font-semibold">{attachment.name}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {state.status === "too-large"
            ? "This PDF is too large to preview here."
            : "This PDF can't be embedded here."}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "rounded-lg")}
          >
            Open PDF
          </a>
          <a
            href={attachment.url}
            download={attachment.name}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "rounded-lg")}
          >
            Download
          </a>
        </div>
      </div>
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
        <div className="max-h-[60vh] overflow-auto overscroll-contain [scrollbar-width:thin] [touch-action:pan-x_pan-y]">
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
// Code + text
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
          className="shiki-scroll max-h-[60vh] overflow-auto overscroll-contain [scrollbar-width:thin] [touch-action:pan-x_pan-y]"
          // Shiki output is generated from the file text on the client; safe to inject.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 text-[13px] leading-6 [scrollbar-width:thin]">
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
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 text-[13px] leading-6 [scrollbar-width:thin] [touch-action:pan-x_pan-y]">
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
// Generic / fallback popup preview
// ---------------------------------------------------------------------------

function GenericFilePreview({
  attachment,
  kind,
  pending = false,
}: {
  attachment: MessageAttachmentItem
  kind: AttachmentKind
  pending?: boolean
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="max-w-sm rounded-2xl border border-border bg-card p-5 text-center shadow-xl">
        <span className="mx-auto flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <KindIcon kind={kind} large />
        </span>
        <h3 className="mt-4 truncate text-sm font-semibold">{attachment.name}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {pending
            ? "This attachment is still uploading."
            : "A preview is not available for this file type. Download remains available from the header."}
        </p>
        {!pending ? (
          <a
            href={attachment.url}
            download={attachment.name}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4 rounded-lg")}
          >
            <DownloadIcon className="size-4" />
            Download
          </a>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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

function KindIcon({ kind, large = false }: { kind: AttachmentKind; large?: boolean }) {
  const className = large ? "size-6" : "size-4"
  if (kind === "image") return <ImageIcon className={className} />
  if (kind === "pdf") return <FileTextIcon className={className} />
  if (kind === "spreadsheet") return <FileSpreadsheetIcon className={className} />
  if (kind === "video") return <FileVideoIcon className={className} />
  if (kind === "audio") return <FileAudioIcon className={className} />
  if (kind === "code") return <FileCodeIcon className={className} />
  if (kind === "text") return <FileTextIcon className={className} />
  return <FileIcon className={className} />
}

function kindLabel(attachment: MessageAttachmentItem): string {
  const extension = getFileExtension(attachment.name).toUpperCase()
  if (extension) return extension
  const kind = kindOf(attachment)
  if (kind === "image") return "Image"
  if (kind === "pdf") return "PDF"
  if (kind === "spreadsheet") return "Spreadsheet"
  if (kind === "video") return "Video"
  if (kind === "audio") return "Audio"
  if (kind === "code") return "Code"
  if (kind === "text") return "Text"
  return "File"
}

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
