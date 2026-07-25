import { describe, it, expect } from "vitest"
import {
  mediaUrlFromKey,
  messageRowToMediaItem,
  taskRowToMediaItem,
  matchesMediaFilter,
  type MediaItem,
} from "./media-items"

const imageRow = {
  id: 7, name: "shot.png", content_type: "image/png", size_bytes: 1234,
  file: "abc-shot.png", created_at: "2026-07-20T00:00:00Z", channel: 3,
} as never
const pdfTaskRow = {
  id: 9, name: "spec.pdf", content_type: "application/pdf", size_bytes: 5000,
  file: "def-spec.pdf", created_at: "2026-07-21T00:00:00Z", task: 42,
} as never

describe("mediaUrlFromKey", () => {
  it("prefixes a bare storage key with /media/", () => {
    expect(mediaUrlFromKey("abc-shot.png")).toBe("/media/abc-shot.png")
  })
  it("leaves an already-resolved url or blob untouched", () => {
    expect(mediaUrlFromKey("/media/x")).toBe("/media/x")
    expect(mediaUrlFromKey("blob:xyz")).toBe("blob:xyz")
    expect(mediaUrlFromKey("http://h/x")).toBe("http://h/x")
  })
})

describe("row → MediaItem", () => {
  it("maps a chat image row", () => {
    const item = messageRowToMediaItem(imageRow, "#general", "/dashboard/agents")
    expect(item).toMatchObject({
      id: "7", name: "shot.png", contentType: "image/png", sizeBytes: 1234,
      url: "/media/abc-shot.png", createdAt: "2026-07-20T00:00:00Z",
      source: { kind: "chat", channelId: 3, label: "#general", href: "/dashboard/agents" },
    })
  })
  it("maps a task pdf row", () => {
    const item = taskRowToMediaItem(pdfTaskRow, "task #42", "/dashboard/board")
    expect(item).toMatchObject({
      id: "9", name: "spec.pdf", contentType: "application/pdf", sizeBytes: 5000,
      url: "/media/def-spec.pdf",
      source: { kind: "task", taskId: 42, label: "task #42", href: "/dashboard/board" },
    })
  })
})

describe("matchesMediaFilter", () => {
  const img = messageRowToMediaItem(imageRow, "#general", "/x") as MediaItem
  const pdf = taskRowToMediaItem(pdfTaskRow, "task #42", "/y") as MediaItem
  it("all matches everything", () => {
    expect(matchesMediaFilter(img, "all")).toBe(true)
    expect(matchesMediaFilter(pdf, "all")).toBe(true)
  })
  it("images matches images only", () => {
    expect(matchesMediaFilter(img, "images")).toBe(true)
    expect(matchesMediaFilter(pdf, "images")).toBe(false)
  })
  it("files matches non-images only", () => {
    expect(matchesMediaFilter(pdf, "files")).toBe(true)
    expect(matchesMediaFilter(img, "files")).toBe(false)
  })
  it("chat / tasks partition by source", () => {
    expect(matchesMediaFilter(img, "chat")).toBe(true)
    expect(matchesMediaFilter(img, "tasks")).toBe(false)
    expect(matchesMediaFilter(pdf, "tasks")).toBe(true)
    expect(matchesMediaFilter(pdf, "chat")).toBe(false)
  })
})
