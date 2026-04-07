/**
 * Central connection config — resolves base URL and auth headers
 * based on whether the app is in local or remote mode.
 *
 * Local mode:  http://localhost:{port}
 * Remote mode: {relayUrl}/proxy (with bearer token auth)
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

/** Get the base URL for API calls */
export function getApiBaseUrl(): string {
  if (mode === 'remote' && relayUrl) {
    return `${relayUrl}/proxy`
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
  return `${getApiBaseUrl()}/sync`
}

/** Get auth headers (empty for local, bearer token for remote) */
export function getAuthHeaders(): Record<string, string> {
  if (mode === 'remote' && relayAccessToken) {
    return { 'Authorization': `Bearer ${relayAccessToken}` }
  }
  return {}
}

/** Check if we're in remote mode */
export function isRemoteMode(): boolean {
  return mode === 'remote'
}

/** Get current local port */
export function getLocalPort(): number {
  return localPort
}
