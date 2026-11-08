import { describe, expect, it } from "vitest"

import type { MediaItem } from "@/lib/media-items"

import { countTabs, filterMedia, mediaCategory, sortNewest } from "./media-logic"

function item(id: string, name: string, contentType: string, label: string, createdAt: string | null = null): MediaItem {
  return { id, name, contentType, sizeBytes: 1, url: "", createdAt, source: { kind: "chat", channelId: 1, label, href: "" } }
}

const ITEMS = [
  item("1", "board.jpg", "image/jpeg", "#design-room", "2026-11-01T00:00:00Z"),
  item("2", "brief.pdf", "application/pdf", "#612 Matchday", "2026-11-03T00:00:00Z"),
  item("3", "notes.md", "text/markdown", "#project-room"),
  item("4", "plan.docx", "application/octet-stream", "#project-room"),
  item("5", "clip.mp4", "video/mp4", "#design-room", "2026-11-02T00:00:00Z"),
]

describe("mediaCategory", () => {
  it("buckets by kind", () => {
    expect(ITEMS.map(mediaCategory)).toEqual(["images", "documents", "documents", "documents", "other"])
  })
})

describe("countTabs / filterMedia", () => {
  it("counts and filters by tab and words", () => {
    expect(countTabs(ITEMS)).toEqual({ all: 5, images: 1, documents: 3, other: 1 })
    expect(filterMedia(ITEMS, "documents", "project").map((i) => i.id)).toEqual(["3", "4"])
    expect(filterMedia(ITEMS, "all", "design JPG").map((i) => i.id)).toEqual(["1"])
    expect(filterMedia(ITEMS, "all", "  ").length).toBe(5)
  })
})

describe("sortNewest", () => {
  it("puts undated last", () => {
    expect(sortNewest(ITEMS).map((i) => i.id)).toEqual(["2", "5", "1", "3", "4"])
  })
})
