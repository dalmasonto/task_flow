import { describe, expect, it } from "vitest"

import { readJson } from "@/lib/auth-api"
import { makeArtboard, type Artboard } from "@/lib/design-devices"
import type { DesignComment } from "@/lib/design-api"
import {
  boardForComment,
  boardsForComment,
  commentResolutionNote,
  commentRoute,
} from "./design-comments"

// The screen these helpers exist for is the comment list, and what it can
// silently get wrong: a blank route label, a resolution note that never
// appears, and a click on a comment that focuses nothing at all. None of the
// three throws — each is a key the inspector reads that the server never sent.
//
// So the fixtures below are the WIRE, deliberately. `models::DesignComment`
// derives `Serialize` with no `rename_all` and `views::list_comments` returns
// the ORM rows untouched, so a comment arrives carrying its COLUMN names —
// `page_path`, `resolution_note` — and `readJson` hands the inspector exactly
// that decoded body. A hand-typed `DesignComment` literal cannot stand in for
// it: TypeScript would check that literal against the very type under test, so
// it could only fail to compile or be silently re-spelled to match. That
// asymmetry IS the defect — the type and the wire disagreed and `tsc` was
// perfectly happy — so these rows are JSON, parsed by the real `readJson`
// (a `Response` body in, a `DesignComment` out, no cast at the call site), and
// every assertion below is about what the inspector DOES with them.

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

/// One comment as `/api/design/{id}/comments` sends it. `resolution_note` is
/// the backend's own spelling, read straight off that endpoint by its phase3
/// test (`backend/plugins/taskflow-design/tests/phase3_agent_surface.rs:294`).
async function fetchComments(overrides: Record<string, unknown> = {}): Promise<DesignComment[]> {
  return readJson<DesignComment[]>(
    jsonRes([
      {
        id: 7,
        project: 2,
        page_path: "/settings",
        component_name: "app-header",
        element_path: "app-header > img.avatar",
        src_ref: "Header.tsx:42",
        viewport: "desktop",
        rect: '{"x":1,"y":2,"w":3,"h":4}',
        snippet: '<img class="avatar">',
        body: "the avatar is too big",
        scope: "instance",
        status: "addressed",
        thread_id: null,
        author: "dalmas",
        resolution_note: "the avatar is now h-6 w-6",
        orphaned: false,
        created_at: "2026-09-25T07:00:00Z",
        ...overrides,
      },
    ]),
  )
}

/// Two device views of one route plus an unrelated one, the way the canvas is
/// arranged: a comment pins on EVERY device view of its route, and a click
/// focuses the first.
const boards: Artboard[] = [
  makeArtboard("/settings", "desktop", 0, 0),
  makeArtboard("/settings", "phone", 0, 600),
  makeArtboard("/dashboard/board", "desktop", 900, 0),
]

describe("commentRoute", () => {
  // The list prints this as the comment's label, and every board lookup in the
  // inspector and on the surface matches on it.
  it("reads the route off the row's `page_path`", async () => {
    const [comment] = await fetchComments()
    expect(commentRoute(comment)).toBe("/settings")
  })

  // The route comes from the row, never from a default: a second row answering
  // the first row's route would put the label and the focused board on the
  // wrong page while looking entirely correct.
  it("follows the row rather than a fixed route", async () => {
    const [comment] = await fetchComments({ page_path: "/dashboard/board" })
    expect(commentRoute(comment)).toBe("/dashboard/board")
  })
})

describe("commentResolutionNote", () => {
  it("gives back the note a resolved comment carries", async () => {
    const [comment] = await fetchComments()
    expect(commentResolutionNote(comment)).toBe("the avatar is now h-6 w-6")
  })

  it("answers null for an unresolved comment, never `undefined`", async () => {
    const [comment] = await fetchComments({ resolution_note: null })
    expect(commentResolutionNote(comment)).toBeNull()
  })

  // A note that is only whitespace draws an empty italic block — a paragraph
  // the reader cannot distinguish from a rendering bug. It is not a note.
  it("answers null for a blank note", async () => {
    const [comment] = await fetchComments({ resolution_note: "   " })
    expect(commentResolutionNote(comment)).toBeNull()
  })
})

describe("boardsForComment", () => {
  it("finds every device view of the comment's route", async () => {
    const [comment] = await fetchComments()
    expect(boardsForComment(boards, comment).map((b) => b.key)).toEqual([
      "/settings@desktop",
      "/settings@phone",
    ])
  })

  // A route with no board open matches nothing. Returning the whole canvas
  // instead (a comparison dropped) would pin the comment to a page it is not
  // about.
  it("matches nothing for a route that is not on the canvas", async () => {
    const [comment] = await fetchComments({ page_path: "/pricing" })
    expect(boardsForComment(boards, comment)).toEqual([])
  })
})

describe("boardForComment", () => {
  it("picks the route's first board, which is what a click zooms to", async () => {
    const [comment] = await fetchComments()
    expect(boardForComment(boards, comment)?.key).toBe("/settings@desktop")
  })

  // The silent one: `undefined` here is a click that does nothing at all — no
  // error, no movement, nothing to notice.
  it("answers undefined for a route that is not on the canvas", async () => {
    const [comment] = await fetchComments({ page_path: "/pricing" })
    expect(boardForComment(boards, comment)).toBeUndefined()
  })
})
