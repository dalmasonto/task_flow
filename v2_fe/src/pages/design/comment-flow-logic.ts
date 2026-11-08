/// The design comments flow (design.html, design--comments, design--pin;
/// #5945), as pure rules: which bucket a comment is in, the pin's colour,
/// what its card says, and which comments sit on the selected element.
/// Tested in comment-flow-logic.test.ts.
///
/// Lifecycle (backend): open → sent (dispatched to an agent) → addressed (the
/// agent says it's done) → resolved (a person confirms), or dismissed. The
/// design's three buckets: Open, Sent (sent and addressed, "waiting for you"),
/// Done (resolved and dismissed).
import type { DesignComment } from "@/lib/design-api"

export type CommentBucket = "open" | "sent" | "done"

export function bucketOf(c: Pick<DesignComment, "status">): CommentBucket {
  const s = c.status as string
  if (s === "open") return "open"
  if (s === "sent" || s === "addressed") return "sent"
  return "done"
}

export function bucketCounts(list: Pick<DesignComment, "status">[]): Record<CommentBucket, number> {
  const out: Record<CommentBucket, number> = { open: 0, sent: 0, done: 0 }
  for (const c of list) out[bucketOf(c)] += 1
  return out
}

/// The pin's colour, as the canvas legend reads: open, sent to an agent, done.
/// An addressed comment reads as done on the canvas (the agent finished), and
/// its card asks the person to confirm.
export type PinTone = "open" | "sent" | "done" | "orphaned"
export function pinTone(c: Pick<DesignComment, "status" | "orphaned">): PinTone {
  if (c.orphaned && c.status === "open") return "orphaned"
  const s = c.status as string
  if (s === "open") return "open"
  if (s === "sent") return "sent"
  return "done"
}

export const PIN_TONE_CLASS: Record<PinTone, string> = {
  open: "bg-primary text-primary-foreground",
  sent: "bg-link text-background",
  done: "bg-running text-background",
  orphaned: "bg-muted-foreground text-background",
}

export type CardState =
  | { kind: "unsent" }
  | { kind: "working"; agent: string }
  | { kind: "sent"; agent: string | null }
  | { kind: "addressed"; note: string | null }
  | { kind: "resolved" }
  | { kind: "dismissed" }

/// What a comment's card says under its text.
export function cardState(c: Pick<DesignComment, "status" | "resolution_note">, agent: { name: string; online: boolean } | null): CardState {
  const s = c.status as string
  if (s === "open") return { kind: "unsent" }
  if (s === "sent") return agent?.online ? { kind: "working", agent: agent.name } : { kind: "sent", agent: agent?.name ?? null }
  if (s === "addressed") return { kind: "addressed", note: c.resolution_note?.trim() || null }
  if (s === "resolved") return { kind: "resolved" }
  return { kind: "dismissed" }
}

/// Comments on this exact element of this page (the Inspect tab's "Comments
/// here").
export function commentsOn(list: DesignComment[], route: string, elementPath: string): DesignComment[] {
  return list.filter((c) => c.page_path === route && c.element_path === elementPath)
}

/// The short element label a card shows: the last step of the path, e.g.
/// `main > section.board > h3.column-title` → `h3.column-title`.
export function elementLabel(path: string): string {
  const parts = path.split(">").map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/// Sort for the panel: newest first within a bucket.
export function newestFirst(list: DesignComment[]): DesignComment[] {
  return [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)
}

/// Pin numbers as the design shows them (1, 2, 3…): each comment's place in
/// the project's comments, oldest first, so a number never changes when a
/// newer comment arrives.
export function pinLabels(list: Pick<DesignComment, "id">[]): Map<number, string> {
  const ids = list.map((c) => c.id).sort((a, b) => a - b)
  return new Map(ids.map((id, i) => [id, String(i + 1)]))
}
