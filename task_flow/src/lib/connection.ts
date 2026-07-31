/**
 * Central connection config — resolves URLs and auth headers
 * based on whether the app is in local or remote mode.
 *
 * Local mode:  direct HTTP to http://localhost:{port}
 * Remote mode: commands via relay /command queue, sync from /state, SSE from /stream
 */

type ConnectionMode = 'local' | 'remote'

let mode: ConnectionMode = 'local'
let localPort = 3456
let relayUrl = ''
let relayAccessToken = ''

/** Update connection config. Called from settings hooks. */
export function setConnectionConfig(config: {
  mode: ConnectionMode
  port: number
  relayUrl: string
  relayAccessToken: string
}) {
  mode = config.mode
  localPort = config.port
  relayUrl = config.relayUrl
  relayAccessToken = config.relayAccessToken
}

/** Get the base URL for direct API calls (local mode only) */
export function getApiBaseUrl(): string {
  if (mode === 'remote' && relayUrl) {
    // In remote mode, most writes go through /command queue.
    // This is used for sync-api fire-and-forget calls which
    // still need a target. In remote mode they're no-ops.
    return `${relayUrl}/_noop`
  }
  return `http://localhost:${localPort}`
}

/** Get the SSE stream URL */
export function getStreamUrl(): string {
  if (mode === 'remote' && relayUrl) {
    return `${relayUrl}/stream`
  }
  return `http://localhost:${localPort}/events`
}

/** Get the sync URL for initial data load */
export function getSyncUrl(): string {
  if (mode === 'remote' && relayUrl) {
    return `${relayUrl}/state`
  }
  return `http://localhost:${localPort}/sync`
}

/** Get auth headers (empty for local, bearer token for remote) */
export function getAuthHeaders(): Record<string, string> {
  if (mode === 'remote' && relayAccessToken) {
    return { 'Authorization': `Bearer ${relayAccessToken}` }
  }
  return {}
}

/** Get the relay command URL (remote mode only) */
export function getCommandUrl(): string {
  return `${relayUrl}/command`
}

/** Submit a command to the relay queue (remote mode) */
export async function submitCommand(type: string, payload: unknown): Promise<{ id: number; status: string }> {
  const res = await fetch(getCommandUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ type, payload }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Check if we're in remote mode */
export function isRemoteMode(): boolean {
  return mode === 'remote'
}

/** Get current local port */
export function getLocalPort(): number {
  return localPort
}
