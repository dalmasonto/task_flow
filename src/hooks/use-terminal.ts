import { useState, useCallback, useRef, useEffect } from 'react'

interface CaptureResult {
  agent: string
  pane: string
  content: string
}

interface SendKeysResult {
  agent: string
  pane: string
  keys: string
  enter: boolean
  sent: boolean
}

export async function captureTerminal(agentName: string, port: number): Promise<CaptureResult> {
  const res = await fetch(`http://localhost:${port}/api/terminal/${encodeURIComponent(agentName)}/capture`)
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to capture terminal')
  }
  return res.json()
}

export async function sendKeys(agentName: string, keys: string, port: number, enter = true): Promise<SendKeysResult> {
  const res = await fetch(`http://localhost:${port}/api/terminal/${encodeURIComponent(agentName)}/send-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys, enter }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to send keys')
  }
  return res.json()
}

export async function fetchTerminalAgents(port: number) {
  const res = await fetch(`http://localhost:${port}/api/terminal/agents`)
  if (!res.ok) return []
  return res.json() as Promise<Array<{ name: string; tmux_pane: string; status: string; pid: number }>>
}

/** Auto-refreshing terminal capture hook */
export function useTerminalCapture(agentName: string | null, port: number, intervalMs = 3000) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!agentName || !port) return
    try {
      const result = await captureTerminal(agentName, port)
      setContent(result.content)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [agentName, port])

  useEffect(() => {
    if (!agentName) {
      setContent(null)
      return
    }
    refresh()
    timerRef.current = setInterval(refresh, intervalMs)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [agentName, refresh, intervalMs])

  return { content, error, refresh }
}
