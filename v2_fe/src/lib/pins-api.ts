/// #5949: pinned messages and reactions. Shapes mirror
/// backend/plugins/taskflow-agents/src/pins.rs. Neither touches the message
/// row, so nothing is re-typed into an agent's pane.
///
/// The reads answer `null` on a server that predates them (a 404 without the
/// handlers' `error: "not_found"`), remembered for the session.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type Pin = { message: number; excerpt: string; sender_label: string; created_at: string | null; pinned_by_label: string; pinned_at: string | null }
export type Reaction = { emoji: string; count: number; mine: boolean; by: string[] }

let unsupported = false

async function adminError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
  if (body?.error === "archived") return new Error("This room is archived.")
  if (body?.error === "too_many_pins") return new Error("This room has the most pins it can hold. Unpin one first.")
  return new Error(body?.detail || fallback)
}

async function readOrNull<T>(res: Response, what: string): Promise<T | null> {
  if (res.status === 404 || res.status === 405) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (body?.error !== "not_found") unsupported = true
    return null
  }
  if (!res.ok) throw new Error(`Couldn't load ${what} (${res.status}).`)
  return (await res.json()) as T
}

export async function fetchPins(channel: number, signal?: AbortSignal): Promise<Pin[] | null> {
  if (unsupported) return null
  return readOrNull<Pin[]>(await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/pins`, withBearer({ signal })), "pins")
}

/// At most 100 ids per call (the server's cap).
export async function fetchReactions(channel: number, messages: number[], signal?: AbortSignal): Promise<Record<string, Reaction[]> | null> {
  if (unsupported) return null
  const ids = [...new Set(messages.filter((n) => Number.isInteger(n) && n > 0))].slice(-100)
  if (!ids.length) return {}
  return readOrNull<Record<string, Reaction[]>>(await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/reactions?messages=${ids.join(",")}`, withBearer({ signal })), "reactions")
}

export async function setPinned(channel: number, message: number, pinned: boolean): Promise<void> {
  const res = pinned
    ? await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/pins`, withBearer({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) }))
    : await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/pins/${message}`, withBearer({ method: "DELETE" }))
  if (!res.ok) throw await adminError(res, pinned ? "Couldn't pin the message." : "Couldn't unpin the message.")
}

/// A toggle: answers that message's reactions after the change.
export async function toggleReaction(channel: number, message: number, emoji: string): Promise<Reaction[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/taskflow/channels/${channel}/messages/${message}/reactions`,
    withBearer({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emoji }) }),
  )
  if (!res.ok) throw await adminError(res, "Couldn't react to the message.")
  return ((await res.json()) as { reactions: Reaction[] }).reactions
}
