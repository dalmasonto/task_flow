/// #660: the Files tab's data — a conversation's attachments as a flat,
/// newest-first list, plus the two groupings the tab offers.
///
/// The page itself comes from `GET /api/taskflow/channels/{id}/attachments`
/// (newest first, keyset cursor). Everything here is pure so the interesting
/// parts — dedupe/merge when realtime prepends, and the date/sender grouping —
/// are testable without a DOM (this project's vitest runs in node).
///
/// One list serves two sources: the endpoint's pages and the attachments of
/// the messages already loaded in the thread (which is how a file arriving
/// over the EXISTING SSE stream reaches the tab — no second EventSource).

import { resolveAttachmentUrl, formatDateSeparatorLabel, messageDayKey } from "@/lib/live-mappers"
import type { AgentMessage } from "@/lib/workspace-view"

/// One row of the endpoint's `attachments` array.
export type ChannelAttachmentRow = {
  id: number
  name: string
  content_type: string
  size_bytes: number
  url?: string | null
  file?: string | null
  channel: number | null
  message_id: number
  created_at: string | null
  sender: { kind: string; id: number | null; display_name: string }
}

export type ChatFileSenderKind = "user" | "agent" | "unknown"

export type ChatFile = {
  id: number
  name: string
  contentType: string
  sizeBytes: number
  url: string
  /// The message the file arrived on — what "jump to message" targets.
  messageId: number
  createdAt: string | null
  senderKind: ChatFileSenderKind
  /// The sender's id WITHIN its kind (user id or agent id); null when the
  /// source could not say (an attachment derived from a thread message whose
  /// sender this view only knows by name).
  senderId: number | null
  senderName: string
}

/// A wire row → the view model. The url falls back to the storage key, the
/// same three shapes `resolveAttachmentUrl` already normalizes everywhere else.
export function channelFileFromRow(row: ChannelAttachmentRow): ChatFile {
  const kind = row.sender.kind === "user" || row.sender.kind === "agent" ? row.sender.kind : "unknown"
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: resolveAttachmentUrl(row.url ?? row.file),
    messageId: row.message_id,
    createdAt: row.created_at ?? null,
    senderKind: kind,
    senderId: row.sender.id ?? null,
    senderName: row.sender.display_name ?? "",
  }
}

/// Merge incoming files into the loaded list: dedupe by id, newest first.
/// Returns the SAME array when every incoming id is already known, so a caller
/// reacting to the thread's growth on every render signal cannot loop.
export function mergeChatFiles(current: ChatFile[], incoming: ChatFile[]): ChatFile[] {
  const seen = new Set(current.map((file) => file.id))
  const added = incoming.filter((file) => !seen.has(file.id))
  if (!added.length) return current
  return [...current, ...added].sort((a, b) => b.id - a.id)
}

/// The stored attachments of the thread's own loaded messages — the realtime
/// source. Pending messages and staged (object-URL) files are skipped: the
/// server has not given them ids yet, and a tab whose rows cannot dedupe or
/// link back to a message is worse than a row that appears a second later.
export function chatFilesFromMessages(
  messages: AgentMessage[],
  options: { currentUserId?: number | null }
): ChatFile[] {
  const files: ChatFile[] = []
  for (const message of messages) {
    const messageId = Number(message.id)
    if (!Number.isFinite(messageId)) continue
    for (const attachment of message.attachments ?? []) {
      const id = Number(attachment.id)
      if (!Number.isFinite(id)) continue
      const own = message.from === "user"
      files.push({
        id,
        name: attachment.name,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
        messageId,
        createdAt: message.createdAt ?? null,
        senderKind: own ? "user" : "unknown",
        senderId: own ? options.currentUserId ?? null : null,
        senderName: own ? "You" : message.from,
      })
    }
  }
  return files.sort((a, b) => b.id - a.id)
}

export type ChatFileGroupMode = "date" | "sender"

export type ChatFileGroup = {
  key: string
  label: string
  files: ChatFile[]
}

/// Group the list for display. The input is newest-first, so groups come out
/// newest-first too (by their newest file) and files keep their order inside a
/// group. Date labels are the thread's own ("Today" / "Yesterday" / "Jul 18,
/// 2026"), so the two views of the same conversation never disagree about what
/// day it is.
export function groupChatFiles(files: ChatFile[], mode: ChatFileGroupMode): ChatFileGroup[] {
  const groups: ChatFileGroup[] = []
  const byKey = new Map<string, ChatFileGroup>()
  for (const file of files) {
    // An identified sender groups by WHO they are, not by the label the row
    // happened to carry: the endpoint names a user by their project display
    // name while a thread-derived row of the reader's own file says "You", and
    // those are one person. Only an unidentified sender falls back to the name.
    const key =
      mode === "date"
        ? messageDayKey(file.createdAt)
        : file.senderId != null
          ? `${file.senderKind}:${file.senderId}`
          : `${file.senderKind}:name:${file.senderName}`
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        // An unnamed sender (a message whose label was empty) still deserves a
        // heading rather than an empty row.
        label: mode === "date" ? formatDateSeparatorLabel(file.createdAt) : file.senderName || "Unknown",
        files: [],
      }
      byKey.set(key, group)
      groups.push(group)
    }
    group.files.push(file)
  }
  return groups
}
