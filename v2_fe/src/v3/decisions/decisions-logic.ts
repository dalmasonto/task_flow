/// Pure rules for the v3 decisions page (tested in decisions-logic.test.ts).
import type { Decision, DecisionStatus } from "./decisions-api"

/// The server's key rule: 3–60 lowercase letters, digits and dashes, starting
/// with a letter, not ending in a dash.
export const KEY_PATTERN = /^[a-z][a-z0-9-]{1,58}[a-z0-9]$/

/// A key suggested from the question: "Max delay per trigger?" → "max-delay-per-trigger".
export function keyFromQuestion(q: string): string {
  let k = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  if (k.length < 3) k = k ? `${k}-decision` : ""
  return k
}

export function countByStatus(ds: Decision[]): Record<DecisionStatus, number> {
  const out: Record<DecisionStatus, number> = { open: 0, ruled: 0, superseded: 0 }
  for (const d of ds) out[d.status] += 1
  return out
}

/// Open decisions this person may rule on: named to them, or nobody named.
export function waitingOnMe(d: Decision, me: number | null): boolean {
  return d.status === "open" && me != null && (d.ruler_user == null || d.ruler_user === me)
}

/// The open list oldest-asked first (it's a queue); ruled and superseded newest first.
export function sortFor(status: DecisionStatus, ds: Decision[]): Decision[] {
  const at = (d: Decision) => (status === "open" ? (d.created_at ?? "") : (d.ruled_at ?? d.updated_at ?? d.created_at ?? ""))
  return ds.filter((d) => d.status === status).sort((a, b) => (status === "open" ? at(a).localeCompare(at(b)) : at(b).localeCompare(at(a))) || a.id - b.id)
}

export function recommended(d: Decision) {
  return d.options.find((o) => o.recommended) ?? null
}

/// Options an ask form produced: blank rows dropped, labels trimmed, at most
/// one recommended (the first one ticked wins).
export function cleanOptions(rows: { label: string; detail: string; recommended: boolean }[]) {
  let rec = false
  return rows
    .filter((r) => r.label.trim())
    .map((r) => {
      const isRec = r.recommended && !rec
      if (isRec) rec = true
      return { label: r.label.trim(), ...(r.detail.trim() ? { detail: r.detail.trim() } : {}), ...(isRec ? { recommended: true } : {}) }
    })
}
