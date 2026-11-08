/// #5988: "X is writing". The server publishes `typing` events on
/// `project:{p}:typing` (backend/plugins/taskflow-agents/src/typing.rs); App's
/// ONE stream forwards them here, and surfaces read who is writing where.
///
/// `TYPING_LIVE` gates both the subscription and the sends: a realtime group
/// joins the stream only once the backend that serves it is deployed. Flip it
/// with that deploy (dev: VITE_TYPING_LIVE=1 against a server that has it).
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export const TYPING_LIVE = import.meta.env.VITE_TYPING_LIVE === "1"

/// The group suffix, a contract with backend/src/realtime.rs (`TYPING`).
export const typingGroup = (projectId: number | string) => `project:${projectId}:typing`

export type TypingContext = { kind: "design_page"; route: string } | { kind: "design_comment"; id: number }
export type TypingEvent = { channel: number; who: { kind: "user" | "agent"; id: number }; label: string; context: TypingContext | null; until: string }
export type Typer = { key: string; label: string; until: number; context: TypingContext | null }

const SEND_EVERY_MS = 3_000

// ------------------------------------------------------------------ the bus

const rooms = new Map<number, Map<string, Typer>>()
const listeners = new Set<() => void>()

function isTypingEvent(d: unknown): d is TypingEvent {
  const e = d as TypingEvent | null
  return !!e && typeof e.channel === "number" && !!e.who && (e.who.kind === "user" || e.who.kind === "agent") && typeof e.who.id === "number" && typeof e.label === "string" && typeof e.until === "string"
}

/// From App's stream. Ignores anything that isn't a well-formed typing event.
export function publishTyping(d: unknown): void {
  if (!isTypingEvent(d)) return
  const until = Date.parse(d.until)
  if (!Number.isFinite(until)) return
  const key = `${d.who.kind}:${d.who.id}`
  const room = rooms.get(d.channel) ?? new Map<string, Typer>()
  room.set(key, { key, label: d.label, until, context: d.context ?? null })
  rooms.set(d.channel, room)
  for (const l of listeners) l()
}

/// They sent the message: stop showing them as writing in that room.
export function clearTyper(channel: number, key: string): void {
  if (rooms.get(channel)?.delete(key)) for (const l of listeners) l()
}

export function subscribeTyping(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/// Everyone writing now, per room, minus me; also the soonest expiry.
export function typersNow(now: number, me: string | null): { byRoom: Map<number, Typer[]>; nextExpiry: number | null } {
  const byRoom = new Map<number, Typer[]>()
  let nextExpiry: number | null = null
  for (const [channel, room] of rooms) {
    const live = [...room.values()].filter((t) => t.until > now && t.key !== me)
    if (live.length) byRoom.set(channel, live)
    for (const t of live) nextExpiry = nextExpiry == null ? t.until : Math.min(nextExpiry, t.until)
  }
  return { byRoom, nextExpiry }
}

/// Test hook.
export function resetTyping(): void {
  rooms.clear()
  lastSent.clear()
  unsupported = false
}

// ------------------------------------------------------------------ text

const short = (label: string) => label.split(" (")[0]

/// "Ann is writing", "Ann and Bo are writing", "Ann, Bo and 2 others are writing".
export function typingText(typers: Pick<Typer, "label">[]): string | null {
  const names = typers.map((t) => short(t.label))
  if (!names.length) return null
  if (names.length === 1) return `${names[0]} is writing`
  if (names.length === 2) return `${names[0]} and ${names[1]} are writing`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? "other" : "others"} are writing`
}

// ------------------------------------------------------------------ sending

const lastSent = new Map<number, number>()
let unsupported = false

/// Say I'm writing in `channel`, at most every 3 s. Best effort and silent:
/// the server drops it for private rooms; an older server stops the sends.
export function sendTyping(channel: number, context?: TypingContext, now = Date.now()): boolean {
  if (!TYPING_LIVE || unsupported) return false
  if (now - (lastSent.get(channel) ?? 0) < SEND_EVERY_MS) return false
  lastSent.set(channel, now)
  void fetch(
    `${API_BASE_URL}/api/taskflow/channels/${channel}/typing`,
    withBearer({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context ? { context } : {}) }),
  )
    .then(async (res) => {
      if (res.status === 404 || res.status === 405) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        if (body?.error !== "not_found") unsupported = true
      }
    })
    .catch(() => undefined)
  return true
}
