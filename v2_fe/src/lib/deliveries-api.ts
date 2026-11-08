/// #5988 item 7: which agents' terminals a message was typed into. Shape
/// mirrors GET /api/taskflow/channels/{c}/deliveries. Receipts come only from
/// agents on an MCP release that reports them, so "no receipt" never means
/// "not delivered". `null` on a server without the route, for the session.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type Delivery = { agent: number; label: string; pane: string | null; delivered_at: string | null }

let unsupported = false

export async function fetchDeliveries(channel: number, messages: number[], signal?: AbortSignal): Promise<Record<string, Delivery[]> | null> {
  if (unsupported) return null
  const ids = [...new Set(messages.filter((n) => Number.isInteger(n) && n > 0))].slice(-100)
  if (!ids.length) return {}
  const res = await fetch(`${API_BASE_URL}/api/taskflow/channels/${channel}/deliveries?messages=${ids.join(",")}`, withBearer({ signal }))
  if (res.status === 404 || res.status === 405) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (body?.error !== "not_found") unsupported = true
    return null
  }
  if (!res.ok) throw new Error(`Couldn't load delivery receipts (${res.status}).`)
  return (await res.json()) as Record<string, Delivery[]>
}
