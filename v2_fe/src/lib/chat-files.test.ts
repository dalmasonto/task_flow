import { describe, expect, it } from "vitest"

import {
  channelFileFromRow,
  chatFilesFromMessages,
  groupChatFiles,
  mergeChatFiles,
  type ChannelAttachmentRow,
  type ChatFile,
} from "./chat-files"
import type { AgentMessage } from "./workspace-view"

/// A wire row as the endpoint returns it (#660): snake_case, with the sender
/// of the message the file arrived on.
const row = (overrides: Partial<ChannelAttachmentRow> = {}): ChannelAttachmentRow => ({
  id: 10,
  name: "deck.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  url: "/media/abc/deck.pdf",
  file: "abc/deck.pdf",
  channel: 7,
  message_id: 42,
  created_at: "2026-10-10T09:00:00Z",
  sender: { kind: "agent", id: 3, display_name: "Claude (main)" },
  ...overrides,
})

const file = (overrides: Partial<ChatFile> = {}): ChatFile => ({
  id: 10,
  name: "deck.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  url: "/media/abc/deck.pdf",
  messageId: 42,
  createdAt: "2026-10-10T09:00:00Z",
  senderKind: "agent",
  senderId: 3,
  senderName: "Claude (main)",
  ...overrides,
})

describe("channelFileFromRow", () => {
  it("maps the wire row onto the view model", () => {
    expect(channelFileFromRow(row())).toEqual(file())
  })

  it("falls back to the storage key when the row carries no url", () => {
    // API_BASE_URL is "" in tests, so a bare key resolves to the media mount.
    const mapped = channelFileFromRow(row({ url: null, file: "abc/deck.pdf" }))
    expect(mapped.url).toBe("/media/abc/deck.pdf")
  })

  it("keeps an unattributable file rather than dropping it", () => {
    const mapped = channelFileFromRow(
      row({ sender: { kind: "unknown", id: null, display_name: "" }, created_at: null })
    )
    expect(mapped.senderKind).toBe("unknown")
    expect(mapped.senderId).toBeNull()
    expect(mapped.createdAt).toBeNull()
  })
})

describe("mergeChatFiles", () => {
  it("prepends newer files and keeps the list newest-first", () => {
    const merged = mergeChatFiles([file({ id: 5 }), file({ id: 4 })], [file({ id: 9 }), file({ id: 4 })])
    expect(merged.map((f) => f.id)).toEqual([9, 5, 4])
  })

  it("returns the SAME array when nothing is new, so a caller can setState on the identity", () => {
    const current = [file({ id: 5 }), file({ id: 4 })]
    expect(mergeChatFiles(current, [file({ id: 4 })])).toBe(current)
    expect(mergeChatFiles(current, [])).toBe(current)
  })
})

describe("chatFilesFromMessages", () => {
  const message = (overrides: Partial<AgentMessage> & { id: string }): AgentMessage =>
    ({ from: "Claude", body: "", status: "posted", time: "", ...overrides }) as AgentMessage

  it("derives stored attachments of saved messages, newest message last", () => {
    const files = chatFilesFromMessages(
      [
        message({
          id: "4",
          createdAt: "2026-10-10T10:00:00Z",
          attachments: [{ id: "12", name: "a.png", contentType: "image/png", sizeBytes: 5, url: "/media/a" }],
        }),
        message({
          id: "5",
          from: "Bear",
          createdAt: "2026-10-11T10:00:00Z",
          attachments: [{ id: "13", name: "b.zip", contentType: "application/zip", sizeBytes: 9, url: "/media/b" }],
        }),
      ],
      { currentUserId: 1 }
    )
    expect(files.map((f) => f.id)).toEqual([13, 12])
    expect(files[0]).toMatchObject({ name: "b.zip", messageId: 5, senderName: "Bear", senderKind: "unknown" })
  })

  it("labels the reader's own files 'You' and gives them a user identity to group by", () => {
    const files = chatFilesFromMessages(
      [
        message({
          id: "5",
          from: "user",
          createdAt: "2026-10-11T10:00:00Z",
          attachments: [{ id: "13", name: "b.zip", contentType: "application/zip", sizeBytes: 9, url: "/media/b" }],
        }),
      ],
      { currentUserId: 7 }
    )
    expect(files[0]).toMatchObject({ senderName: "You", senderKind: "user", senderId: 7 })
  })

  it("skips pending messages and staged attachments — they have no server id yet", () => {
    const files = chatFilesFromMessages(
      [
        message({
          id: "pending:abc",
          attachments: [{ id: "staged:1:a.png", name: "a.png", contentType: "image/png", sizeBytes: 5, url: "blob:x" }],
        }),
        message({
          id: "9",
          attachments: [
            { id: "staged:1:b.png", name: "b.png", contentType: "image/png", sizeBytes: 5, url: "blob:y" },
            { id: "20", name: "real.png", contentType: "image/png", sizeBytes: 5, url: "/media/real" },
          ],
        }),
      ],
      { currentUserId: 1 }
    )
    expect(files.map((f) => f.id)).toEqual([20])
  })
})

describe("groupChatFiles", () => {
  const file = (overrides: Partial<ChatFile> = {}): ChatFile => ({
    id: 10,
    name: "deck.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    url: "/media/abc/deck.pdf",
    messageId: 42,
    createdAt: new Date().toISOString(),
    senderKind: "agent",
    senderId: 3,
    senderName: "Claude (main)",
    ...overrides,
  })

  /// An ISO instant `daysAgo` calendar days back, at `hours` local time. Dates
  /// are built relative to the real clock because the labels ("Today") are, and
  /// a fixed date would pass today and fail tomorrow.
  const at = (daysAgo: number, hours: number, overrides: Partial<ChatFile> = {}) => {
    const day = new Date()
    day.setDate(day.getDate() - daysAgo)
    day.setHours(hours, 0, 0, 0)
    return file({ createdAt: day.toISOString(), ...overrides })
  }

  it("groups by calendar day with Today / Yesterday labels, newest group first", () => {
    const groups = groupChatFiles(
      [at(0, 9, { id: 30 }), at(0, 8, { id: 29 }), at(1, 22, { id: 28 }), at(6, 10, { id: 27 })],
      "date"
    )
    const older = new Date()
    older.setDate(older.getDate() - 6)
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      older.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    ])
    expect(groups[0].files.map((f) => f.id)).toEqual([30, 29])
    expect(groups[1].files.map((f) => f.id)).toEqual([28])
  })

  it("groups by sender — one group per member, ordered by their newest file", () => {
    const groups = groupChatFiles(
      [
        at(0, 9, { id: 30, senderName: "You", senderKind: "user", senderId: 7 }),
        at(0, 8, { id: 29, senderName: "Bear", senderKind: "agent", senderId: 2 }),
        at(1, 8, { id: 28, senderName: "You", senderKind: "user", senderId: 7 }),
      ],
      "sender"
    )
    expect(groups.map((g) => g.label)).toEqual(["You", "Bear"])
    expect(groups[0].files.map((f) => f.id)).toEqual([30, 28])
  })

  it("keeps same-named senders with no identity apart, and returns nothing for no files", () => {
    const groups = groupChatFiles(
      [
        at(0, 9, { id: 30, senderName: "Claude", senderKind: "unknown", senderId: null }),
        at(0, 8, { id: 29, senderName: "Claude", senderKind: "agent", senderId: 2 }),
      ],
      "sender"
    )
    expect(groups.map((g) => g.label)).toEqual(["Claude", "Claude"])
    expect(groups.map((g) => g.files[0].id)).toEqual([30, 29])
    expect(groupChatFiles([], "date")).toEqual([])
  })

  it("groups one sender by WHO they are, not by the label each source happened to carry", () => {
    // The reader's own file, derived from the thread, is labelled "You"; the
    // same person's file from the endpoint carries their project display name.
    const groups = groupChatFiles(
      [
        at(0, 9, { id: 30, senderName: "You", senderKind: "user", senderId: 7 }),
        at(0, 8, { id: 29, senderName: "Dalmas Ogembo", senderKind: "user", senderId: 7 }),
      ],
      "sender"
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => f.id)).toEqual([30, 29])
  })
})
