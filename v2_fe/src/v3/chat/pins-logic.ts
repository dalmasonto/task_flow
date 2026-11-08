/// #5949: the pin bar and reaction rules (tested in pins-logic.test.ts).
import type { Reaction } from "@/lib/pins-api"

/// The server's allowlist (pins.rs EMOJI), in picker order, with glyphs.
export const REACTIONS: { id: string; glyph: string; label: string }[] = [
  { id: "thumbs_up", glyph: "👍", label: "Thumbs up" },
  { id: "eyes", glyph: "👀", label: "Looking" },
  { id: "check", glyph: "✅", label: "Done" },
  { id: "heart", glyph: "❤️", label: "Heart" },
  { id: "tada", glyph: "🎉", label: "Celebrate" },
  { id: "rocket", glyph: "🚀", label: "Rocket" },
  { id: "thinking", glyph: "🤔", label: "Thinking" },
  { id: "x", glyph: "❌", label: "No" },
]

export function glyphOf(id: string): string {
  return REACTIONS.find((r) => r.id === id)?.glyph ?? id
}

/// "Looking, 4: Ann, Bo, Cy and 1 more", for the chip's label and tooltip.
export function reactionLabel(r: Reaction): string {
  const name = REACTIONS.find((x) => x.id === r.emoji)?.label ?? r.emoji
  const shown = r.by.slice(0, 3)
  const more = r.count - shown.length
  const who = shown.length ? `: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""
  return `${name}, ${r.count}${who}`
}

/// Pin bar position, wrapping both ways; stays valid as pins come and go.
export function stepPin(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

/// The ids whose reactions to load: posted, server-backed messages, newest 100.
export function reactionIds(messages: { id: string; status?: string }[]): number[] {
  return messages
    .filter((m) => m.status === "posted")
    .map((m) => Number(m.id))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(-100)
}
