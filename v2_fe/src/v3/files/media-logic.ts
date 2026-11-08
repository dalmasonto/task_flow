/// Pure rules for the v3 Media page (tested in media-logic.test.ts).
import { getAttachmentKind } from "@/lib/attachment-kind"
import type { MediaItem } from "@/lib/media-items"

export type MediaTab = "all" | "images" | "documents" | "other"

/// The design's three buckets: images; documents (PDFs, spreadsheets, text,
/// markdown, code, office files); everything else (video, audio, archives…).
export function mediaCategory(item: Pick<MediaItem, "contentType" | "name">): Exclude<MediaTab, "all"> {
  const kind = getAttachmentKind(item.contentType, item.name)
  if (kind === "image") return "images"
  if (kind === "pdf" || kind === "spreadsheet" || kind === "markdown" || kind === "text" || kind === "code") return "documents"
  if (/\.(docx?|odt|rtf|pptx?|odp|key|pages)$/i.test(item.name)) return "documents"
  return "other"
}

export function countTabs(items: MediaItem[]): Record<MediaTab, number> {
  const out: Record<MediaTab, number> = { all: items.length, images: 0, documents: 0, other: 0 }
  for (const it of items) out[mediaCategory(it)] += 1
  return out
}

/// Items in `tab` whose file name or source (room or task) contains every
/// word of `query`, case-insensitively.
export function filterMedia(items: MediaItem[], tab: MediaTab, query: string): MediaItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((it) => {
    if (tab !== "all" && mediaCategory(it) !== tab) return false
    if (!words.length) return true
    const hay = `${it.name} ${it.source.label}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/// Newest first; undated last.
export function sortNewest(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0))
}
