import { useState, useCallback, useRef, useEffect } from 'react'
import { getApiBaseUrl, getAuthHeaders } from '@/lib/connection'

interface SendKeysResult {
  agent: string
  pane: string
  keys: string
  enter: boolean
  sent: boolean
}

export async function sendKeys(agentName: string, keys: string, _port: number, enter = true, literal = true): Promise<SendKeysResult> {
  const res = await fetch(`${getApiBaseUrl()}/api/terminal/${encodeURIComponent(agentName)}/send-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ keys, enter, literal }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to send keys')
  }
  return res.json()
}

export async function fetchTerminalAgents(_port: number) {
  const res = await fetch(`${getApiBaseUrl()}/api/terminal/agents`, { headers: getAuthHeaders() })
  if (!res.ok) return []
  return res.json() as Promise<Array<{ name: string; tmux_pane: string; status: string; pid: number }>>
}

// ─── SSE-driven terminal content store ──────────────────────────────

type Listener = (content: string) => void

/** In-memory store for terminal content, updated by SSE events */
class TerminalStore {
  private content = new Map<string, string>()
  private listeners = new Map<string, Set<Listener>>()

  set(agentName: string, content: string) {
    this.content.set(agentName, content)
    const subs = this.listeners.get(agentName)
    if (subs) subs.forEach(fn => fn(content))
  }

  get(agentName: string): string | null {
    return this.content.get(agentName) ?? null
  }

  subscribe(agentName: string, fn: Listener): () => void {
    if (!this.listeners.has(agentName)) this.listeners.set(agentName, new Set())
    this.listeners.get(agentName)!.add(fn)
    return () => { this.listeners.get(agentName)?.delete(fn) }
  }
}

export const terminalStore = new TerminalStore()

/** Hook that subscribes to terminal content for an agent via SSE-driven store */
export function useTerminalCapture(agentName: string | null, _port: number, _intervalMs = 3000) {
  const [content, setContent] = useState<string | null>(
    agentName ? terminalStore.get(agentName) : null
  )
  const [error] = useState<string | null>(null)

  useEffect(() => {
    if (!agentName) {
      setContent(null)
      return
    }
    // Read current value
    const current = terminalStore.get(agentName)
    if (current) setContent(current)

    // Subscribe to updates
    return terminalStore.subscribe(agentName, setContent)
  }, [agentName])

  // Refresh is now a no-op since backend pushes content
  const refresh = useCallback(() => {}, [])

  return { content, error, refresh }
}
