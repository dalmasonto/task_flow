/// Which TaskFlow server this browser talks to (the design's server picker,
/// v3 group 2).
///
/// The build sets a default (VITE_API_BASE_URL; "" means this site's own
/// origin). A person can point the app at another server, such as their own
/// self-hosted backend, and the choice is kept in localStorage. Every API call
/// reads it once at startup through auth-api's API_BASE_URL, so switching
/// reloads the page. A session belongs to one server, so switching also signs
/// you out rather than sending one server's token to another.

const SERVER_KEY = "taskflow.server"
const SAVED_KEY = "taskflow.server.saved"
const MAX_SAVED = 20

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/// A server address as the app uses it: http(s) origin plus optional path, no
/// trailing slash, no query or fragment. Returns null for anything else, so a
/// typo can never become the base of every request.
export function normalizeServer(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/// The chosen server, or null when the build default applies.
export function readServerOverride(): string | null {
  const v = storage()?.getItem(SERVER_KEY)
  return v ? normalizeServer(v) : null
}

/// Servers a person has added, with the label they gave each. Saved on this
/// device only; the build default is always listed separately.
export type SavedServer = { name: string; url: string }

export function readSavedServers(): SavedServer[] {
  try {
    const list = JSON.parse(storage()?.getItem(SAVED_KEY) ?? "[]")
    if (!Array.isArray(list)) return []
    return list
      .map((s) => ({ name: typeof s?.name === "string" ? s.name.trim().slice(0, 80) : "", url: typeof s?.url === "string" ? normalizeServer(s.url) : null }))
      .filter((s): s is SavedServer => !!s.url)
      .slice(0, MAX_SAVED)
  } catch {
    return []
  }
}

/// Add or rename a saved server (matched by address).
export function saveServer(server: SavedServer) {
  const url = normalizeServer(server.url)
  if (!url) return
  const list = [{ name: server.name.trim() || serverLabel(url), url }, ...readSavedServers().filter((s) => s.url !== url)].slice(0, MAX_SAVED)
  storage()?.setItem(SAVED_KEY, JSON.stringify(list))
}

export function forgetServer(url: string) {
  storage()?.setItem(SAVED_KEY, JSON.stringify(readSavedServers().filter((s) => s.url !== url)))
}

/// Pick a server (null = back to the build default). The caller signs out and
/// reloads, because a session belongs to one server.
export function writeServerChoice(server: string | null) {
  const s = storage()
  if (!s) return
  if (server) s.setItem(SERVER_KEY, server)
  else s.removeItem(SERVER_KEY)
}

/// What to call a server in the UI: its host, or this site's host for "".
export function serverLabel(base: string): string {
  if (!base) return typeof window === "undefined" ? "this site" : window.location.host
  try {
    const u = new URL(base)
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
  } catch {
    return base
  }
}

export type ServerProbe =
  | { ok: true; ms: number; providers: string[] }
  | { ok: false; kind: "unreachable" | "cors" | "not-taskflow" | "error"; reason: string }

/// Is there a TaskFlow server at `base`? Asks the public `/oauth/providers`
/// route, which every TaskFlow backend serves without a session. When the
/// normal request fails, a no-cors request tells "it's there but blocks this
/// site" apart from "nothing answers", which a browser otherwise can't.
export async function probeServer(base: string, signal?: AbortSignal): Promise<ServerProbe> {
  const url = `${base}/oauth/providers`
  const started = performance.now()
  try {
    const res = await fetch(url, { signal })
    const ms = Math.round(performance.now() - started)
    if (!res.ok) return { ok: false, kind: "error", reason: `It answered ${res.status}. Check the address, including any path.` }
    if (!(res.headers.get("content-type") ?? "").includes("json"))
      return { ok: false, kind: "not-taskflow", reason: "This address answers, but it isn't a TaskFlow server. It looks like a website; ask for the TaskFlow API address." }
    const data = (await res.json()) as { providers?: { label?: unknown }[] }
    return { ok: true, ms, providers: (data.providers ?? []).map((p) => String(p.label ?? "")).filter(Boolean) }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error
    try {
      await fetch(url, { mode: "no-cors", signal })
      return { ok: false, kind: "cors", reason: "The server answered but blocks this site (CORS). Ask its admin to allow this address." }
    } catch (again) {
      if ((again as Error)?.name === "AbortError") throw again
      return { ok: false, kind: "unreachable", reason: "Can't reach it. Check the address, that it's running, or your VPN." }
    }
  }
}
