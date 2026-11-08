/// #5988 item 8: the tools an agent ran while writing each message. Shape
/// mirrors the backend's GET /api/taskflow/channels/{c}/tools: only messages an
/// agent sent get a key. `null` on a server without the route (a 404 without
/// the handlers' `error: "not_found"`), remembered for the session.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type MessageTools = { count: number; names: string[] }

let unsupported = false

export async function fetchMessageTools(channel: number, messages: number[], signal?: AbortSignal): Promise<Record<string, MessageTools> | null> {
  if (unsupported) return null
  const ids = [...new Set(messages.filter((n) => Number.isInteger(n) && n > 0))].slice(-100)
  if (!ids.length) return {}
  const res = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/tools?messages=${ids.join(",")}`, withBearer({ signal }))
  if (res.status === 404 || res.status === 405) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (body?.error !== "not_found") unsupported = true
    return null
  }
  if (!res.ok) throw new Error(`Couldn't load the tools (${res.status}).`)
  return (await res.json()) as Record<string, MessageTools>
}
