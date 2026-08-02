import { getAttachmentKind } from "@/lib/attachment-kind"
import { API_BASE_URL } from "@/lib/auth-api"
import type { MessageAttachmentItem } from "@/components/message-attachments"

export type MediaSource =
  | { kind: "chat"; channelId: number | null; label: string; href: string }
  | { kind: "task"; taskId: number; label: string; href: string }

export type MediaItem = MessageAttachmentItem & {
  source: MediaSource
  createdAt: string | null
}

export type MediaFilter = "all" | "images" | "files" | "chat" | "tasks"

/** A stored attachment row's `file` is a bare key; already-resolved urls and
 *  blobs pass through. */
export function mediaUrlFromKey(key: string): string {
  if (!key) return ""
  if (key.startsWith("blob:") || key.startsWith("http")) return key
  // Media lives on the BACKEND. In prod the SPA and API are different origins,
  // so a bare key or a relative `/media/<key>` (from a REST read) must resolve
  // to the API origin — otherwise it hits the SPA's file-server and 404s to
  // index.html. API_BASE_URL is "" in dev (same origin, Vite proxies /media).
  if (key.startsWith("/media/")) return `${API_BASE_URL}${key}`
  if (key.startsWith("/")) return key
  return `${API_BASE_URL}/media/${key}`
}

/** The attachment-row fields both tables share. */
type BaseRow = {
  id: number
  name: string
  content_type: string
  size_bytes: number
  file: string
  created_at?: string | null
}

function baseItem(row: BaseRow): MessageAttachmentItem & { createdAt: string | null } {
  return {
    id: String(row.id),
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: mediaUrlFromKey(row.file),
    createdAt: row.created_at ?? null,
  }
}

export function messageRowToMediaItem(
  row: BaseRow & { channel?: number | null },
  channelLabel: string,
  href: string,
): MediaItem {
  return {
    ...baseItem(row),
    source: { kind: "chat", channelId: row.channel ?? null, label: channelLabel, href },
  }
}

export function taskRowToMediaItem(
  row: BaseRow & { task: number },
  taskLabel: string,
  href: string,
): MediaItem {
  return {
    ...baseItem(row),
    source: { kind: "task", taskId: row.task, label: taskLabel, href },
  }
}

/** Image vs file uses the same classifier chat uses. */
export function matchesMediaFilter(item: MediaItem, filter: MediaFilter): boolean {
  const isImage = getAttachmentKind(item.contentType, item.name) === "image"
  switch (filter) {
    case "all": return true
    case "images": return isImage
    case "files": return !isImage
    case "chat": return item.source.kind === "chat"
    case "tasks": return item.source.kind === "task"
  }
}
