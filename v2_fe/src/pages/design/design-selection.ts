/// Selection sanitizing + pin numbering — shared by the canvas, inspector and
/// tests (kept out of component files so fast refresh stays happy).

import type { Artboard } from "@/lib/design-devices"

export type SelectionState = {
  /** Validated fields of the sandbox `design:select` message. */
  component: string | null
  elementPath: string
  srcRef: string | null
  tag: string
  text: string
  snippet: string
  rect: { x: number; y: number; w: number; h: number }
  ancestors: string[]
  route: string
  viewport: string
}

/** Shape-check + clamp one postMessage selection before it touches state.
 *  Everything inbound came through postMessage — hostile until proven else. */
export function sanitizeSelection(
  raw: Record<string, unknown>,
  route: string,
  viewport: string,
): SelectionState | null {
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : ""
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0
  const rectRaw = (raw.rect ?? {}) as Record<string, unknown>
  return {
    component: typeof raw.component === "string" ? raw.component.slice(0, 120) : null,
    elementPath: str(raw.elementPath, 500),
    srcRef: typeof raw.src === "string" ? raw.src.slice(0, 200) : null,
    tag: str(raw.tag, 40),
    text: str(raw.text, 80),
    snippet: str(raw.snippet, 600),
    rect: {
      x: num(rectRaw.x),
      y: num(rectRaw.y),
      w: Math.max(0, num(rectRaw.w)),
      h: Math.max(0, num(rectRaw.h)),
    },
    ancestors: Array.isArray(raw.ancestors)
      ? raw.ancestors.filter((a): a is string => typeof a === "string").slice(-6)
      : [],
    route,
    viewport,
  }
}

const PIN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Stable small badge label per comment row id for the pin. */
export function pinNumber(id: number): string {
  const n = ((id - 1) % PIN_ALPHABET.length + PIN_ALPHABET.length) % PIN_ALPHABET.length
  return PIN_ALPHABET[n]
}

export function boardForRoute(boards: Artboard[], route: string): Artboard | undefined {
  return boards.find((b) => b.route === route)
}
