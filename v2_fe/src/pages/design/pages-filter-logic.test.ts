import { describe, expect, it } from "vitest"

import type { DesignComment } from "@/lib/design-api"

import { beingEdited, commentCountsByRoute } from "./pages-filter-logic"

describe("pages filters", () => {
  it("counts comments still waiting per page", () => {
    const c = (page_path: string, status: string) => ({ page_path, status }) as unknown as DesignComment
    expect([...commentCountsByRoute([c("/a", "open"), c("/a", "sent"), c("/a", "dismissed"), c("/b", "addressed")])]).toEqual([["/a", 2], ["/b", 1]])
  })
  it("finds pages an agent wrote in the last two minutes", () => {
    const now = Date.parse("2026-11-08T12:00:00Z")
    const routes = [{ path: "/a", file: "pages/a.html" }, { path: "/b", file: "pages/b.html" }, { path: "/c", file: "pages/c.html" }]
    const files = [
      { path: "pages/a.html", updated_by: "Claude (main)", updated_at: "2026-11-08T11:59:00Z" },
      { path: "pages/b.html", updated_by: "dalmas", updated_at: "2026-11-08T11:59:30Z" },
      { path: "pages/c.html", updated_by: "Claude (main)", updated_at: "2026-11-08T11:50:00Z" },
    ]
    expect([...beingEdited(routes, files, new Set(["Claude (main)"]), now)]).toEqual([["/a", "Claude (main)"]])
  })
})
