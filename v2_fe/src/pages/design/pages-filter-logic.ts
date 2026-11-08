/// The Pages tab's quick filters (design--pages.html, #5945): pages with
/// comments still waiting, and pages an agent is writing right now (a page
/// file written by an agent in the last two minutes; the manifest's files
/// carry `updated_by` / `updated_at`, reviewer #5957). Pure, tested.
import type { DesignComment, DesignFileSummary, RouteEntry } from "@/lib/design-api"

import { bucketOf } from "./comment-flow-logic"

export const EDITING_WINDOW_MS = 2 * 60_000

/// Open or sent comments per route.
export function commentCountsByRoute(comments: Pick<DesignComment, "page_path" | "status">[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of comments) if (bucketOf(c) !== "done" && c.page_path) out.set(c.page_path, (out.get(c.page_path) ?? 0) + 1)
  return out
}

/// Routes whose page file an agent wrote within the window, with who.
export function beingEdited(routes: Pick<RouteEntry, "path" | "file">[], files: Pick<DesignFileSummary, "path" | "updated_by" | "updated_at">[], agentNames: Set<string>, now: number): Map<string, string> {
  const byFile = new Map(files.map((f) => [f.path, f]))
  const out = new Map<string, string>()
  for (const r of routes) {
    const f = byFile.get(r.file)
    if (!f?.updated_at || !agentNames.has(f.updated_by)) continue
    if (now - Date.parse(f.updated_at) <= EDITING_WINDOW_MS) out.set(r.path, f.updated_by)
  }
  return out
}
