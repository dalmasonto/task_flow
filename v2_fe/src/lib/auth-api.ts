const AUTH_TOKEN_KEY = "taskflow.auth.token"
const AUTH_USER_KEY = "taskflow.auth.user"

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ""

export type AuthUser = {
  id: number
  username: string
  email: string
  is_staff: boolean
  is_superuser: boolean
}

type LoginResponse = {
  token: string
  user: AuthUser
}

type ApiErrorPayload = {
  detail?: string
  error?: string
}

export type AuthResult =
  | { ok: true; user?: AuthUser; message: string }
  | { ok: false; message: string }

function authUrl(path: string) {
  return `${API_BASE_URL}${path}`
}

export function getStoredToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY)
}

export function hasStoredAuthSession() {
  return Boolean(getStoredToken())
}

function storeSession(session: LoginResponse) {
  window.localStorage.setItem(AUTH_TOKEN_KEY, session.token)
  window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user))
}

export function getStoredUser(): AuthUser | null {
  const raw = window.localStorage.getItem(AUTH_USER_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    return null
  }
}

export function clearStoredSession() {
  window.localStorage.removeItem(AUTH_TOKEN_KEY)
  window.localStorage.removeItem(AUTH_USER_KEY)
}

const OAUTH_ERROR_KEY = "taskflow.oauth.error"

/** The meaning of an OAuth callback landing, parsed from the URL. */
export type OAuthRedirect =
  | { kind: "token"; token: string }
  | { kind: "error"; message: string }
  | { kind: "none" }

/**
 * Classify a callback landing from its URL fragment and query. Pure — no DOM —
 * so the whole token/error decision is unit-tested in node without jsdom. A
 * bearer token wins over any stray error param.
 */
export function parseOAuthRedirect(hash: string, search: string): OAuthRedirect {
  const frag = new URLSearchParams(hash.replace(/^#/, ""))
  const query = new URLSearchParams(search.replace(/^\?/, ""))
  const token = frag.get("token")
  if (token) return { kind: "token", token }
  const error = frag.get("error") ?? query.get("error")
  if (error) return { kind: "error", message: error }
  return { kind: "none" }
}

/**
 * If this page load is an OAuth callback landing, act on it BEFORE React mounts:
 * a `#token=` is stored in the same slot password login uses (so the auth gate,
 * which reads storage synchronously, sees it on first render); a `#error=` /
 * `?error=` is stashed for the login screen. Either way the fragment/query is
 * stripped so a refresh or a copied URL can't replay it. A no-op on an ordinary
 * load, and `window`-guarded so it is inert under SSR/tests.
 */
export function consumeOAuthRedirect(): void {
  if (typeof window === "undefined") return
  const result = parseOAuthRedirect(window.location.hash, window.location.search)
  if (result.kind === "none") return
  if (result.kind === "token") {
    window.localStorage.setItem(AUTH_TOKEN_KEY, result.token)
  } else {
    window.sessionStorage.setItem(OAUTH_ERROR_KEY, result.message)
  }
  // Keep the path; drop the fragment and any oauth query so nothing lingers.
  window.history.replaceState(null, "", window.location.pathname)
}

/**
 * Read and clear a stashed OAuth error (one-shot), for the login screen to show.
 * `storage` is injectable so this is node-testable; defaults to sessionStorage.
 */
export function takeOAuthError(
  storage?: Pick<Storage, "getItem" | "removeItem">,
): string | null {
  const store =
    storage ?? (typeof window !== "undefined" ? window.sessionStorage : null)
  if (!store) return null
  const value = store.getItem(OAUTH_ERROR_KEY)
  if (value) store.removeItem(OAUTH_ERROR_KEY)
  return value
}

async function readError(response: Response) {
  const fallback = response.statusText || "Request failed"
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return fallback

  try {
    const payload = (await response.json()) as ApiErrorPayload
    return payload.detail ?? payload.error ?? fallback
  } catch {
    return fallback
  }
}

async function authRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = getStoredToken()

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json")
  }

  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`)
  }

  const response = await fetch(authUrl(path), {
    ...init,
    headers,
    credentials: "include",
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function registerUser(input: { username: string; email: string; password: string }): Promise<AuthResult> {
  try {
    const user = await authRequest<AuthUser>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    })
    return {
      ok: true,
      user,
      message: "Account created. You can log in with the same username and password.",
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not create account." }
  }
}

export async function loginUser(input: { username: string; password: string }): Promise<AuthResult> {
  try {
    const session = await authRequest<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    })
    storeSession(session)
    return { ok: true, user: session.user, message: `Logged in as ${session.user.username}.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not log in." }
  }
}

export async function requestPasswordReset(email: string): Promise<AuthResult> {
  try {
    await authRequest<void>("/api/auth/password-forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    })
    return { ok: true, message: "Reset request accepted. Check the matching inbox if that account exists." }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not request password reset." }
  }
}

export async function confirmPasswordReset(input: { token: string; newPassword: string }): Promise<AuthResult> {
  try {
    await authRequest<void>("/api/auth/password-reset", {
      method: "POST",
      body: JSON.stringify({ token: input.token, new_password: input.newPassword }),
    })
    clearStoredSession()
    return { ok: true, message: "Password updated. Log in with the new password." }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not update password." }
  }
}

/// Rotate the caller's password. Backend route: `POST /api/auth/change-password`
/// with `{current_password, new_password}` (umbral-auth). 204 on success; 400
/// `invalid_credentials` (wrong current password) or `weak_password` otherwise.
export async function changePassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<AuthResult> {
  try {
    await authRequest<void>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: input.currentPassword,
        new_password: input.newPassword,
      }),
    })
    return { ok: true, message: "Password updated." }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not update password." }
  }
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    return await authRequest<AuthUser>("/api/auth/me")
  } catch {
    clearStoredSession()
    return null
  }
}

export async function logoutUser() {
  try {
    await authRequest<void>("/api/auth/logout", { method: "POST" })
  } finally {
    clearStoredSession()
  }
}
