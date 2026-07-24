# GitHub social login (frontend wiring)

**Status:** approved design, ready for planning
**Date:** 2026-07-25
**Area:** `v2_fe/` only. No backend changes.

## Problem

A person with a GitHub account cannot sign IN to TaskFlow with it. The login and
signup screens show two social buttons (`SocialAuthButtons`, `App.tsx:4576`) that
are pure decoration — text badges, no `onClick`. Nothing in the SPA consumes the
bearer token the OAuth callback hands back.

## What already exists — do NOT rebuild it

The `umbral-oauth` plugin is wired and GitHub is configured and live:

- `backend/.env` holds `UMBRAL_OAUTH_GITHUB_CLIENT_ID` / `_SECRET`; `GET
  /oauth/providers` returns `github` right now.
- **The CONNECT flow is fully implemented**: a logged-in user links GitHub from
  Account Settings. `taskflow-api.ts:1334` `githubConnectUrl(returnPath?)` builds
  the `/oauth/github/connect?next=…` URL, `SettingsPage.tsx:274` uses it, and
  `taskflow-github` reads the linked token to publish issues as the user. This
  spec must not touch, duplicate, or regress any of it.

This feature is only the missing **LOGIN** half, and it is **frontend-only**. The
backend login flow already works end to end:

```
/oauth/github/login?next=<spa-url>  →  GitHub  →  /oauth/github/callback
   →  backend resolves-or-creates the AuthUser, mints a bearer token
   →  redirects to  <spa-url>#token=<...>&token_type=Bearer
```

(`umbral-oauth-0.0.10/src/routes.rs`: a login flow with an allowlisted
`return_to` mints a token and appends it to the URL fragment; connect flows never
mint one. The redirect base is `UMBRAL_OAUTH_REDIRECT_BASE`, defaulting to the
Vite origin `http://localhost:5173`, which is the `allow_return` allowlist.)

## Goals

- A real "Sign in with GitHub" button, bearing the GitHub mark, on the login and
  signup screens.
- The token the callback returns is consumed and the user lands in the dashboard,
  authenticated exactly as a password login leaves them.
- Google (and any future provider) appears automatically once configured, with no
  code change — driven by `/oauth/providers`.

## Non-goals

- No backend changes. The flow, token minting, and provider registration all
  exist.
- Not touching the connect flow or Account Settings.

## Design

Three pieces, each small.

### 1. Two helpers in `taskflow-api.ts`'s existing OAuth section

Add beside `githubConnectUrl`, mirroring its shape (SSR/vitest-safe `window`
guard, `next` built from the SPA's own origin so it is correct in dev and prod
and satisfies the backend allowlist). No new file — this is the established home
for OAuth URL helpers.

```ts
/**
 * Full-page LOGIN url for a social provider — the sign-in counterpart to
 * `githubConnectUrl`. The backend mints a bearer token on a login flow with an
 * allowlisted `next` and returns it in the URL fragment; `returnPath` is where
 * it lands (default `/dashboard/board`). The token is consumed pre-render;
 * the target must NOT be an auth route (`/login` short-circuits to the login
 * form BEFORE the auth check, so an authed user would be stuck there). Safe under
 * SSR/vitest where `window` is absent.
 */
export function oauthLoginUrl(provider: string, returnPath = "/dashboard/board"): string {
  const base = `${API_BASE_URL}/oauth/${provider}/login`
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  return `${base}?next=${encodeURIComponent(`${origin}${returnPath}`)}`
}

/** The providers the backend has configured, for rendering only real buttons. */
export type OAuthProvider = { key: string; label: string }

export async function fetchOAuthProviders(): Promise<OAuthProvider[]> {
  const res = await fetch(`${API_BASE_URL}/oauth/providers`)
  if (!res.ok) return []
  const data = (await res.json().catch(() => null)) as
    | { providers?: Array<{ key?: string; label?: string }> }
    | null
  return (data?.providers ?? [])
    .filter((p): p is { key: string; label: string } =>
      typeof p.key === "string" && typeof p.label === "string")
    .map((p) => ({ key: p.key, label: p.label }))
}
```

Note the login URL is BUILT locally (like `githubConnectUrl`) rather than taken
from the discovery endpoint's `login.url`, so the `next`/origin logic lives in
one tested place. The discovery endpoint is used only to learn WHICH providers
exist.

### 2. Consume the token before React renders — in `main.tsx`

**This is the one real subtlety.** The auth gate initializes its state
*synchronously* during first render:

```ts
// App.tsx:1878
const [currentUser, setCurrentUser] = useState(() =>
  hasStoredAuthSession() ? getStoredUser() : null)
const [authGateStatus, setAuthGateStatus] = useState(() =>
  hasStoredAuthSession() ? "checking" : "anonymous")
```

A `useEffect` runs *after* that, so storing the token in an effect would leave the
gate already decided "anonymous" — the user would sit on the login page with a
valid token until a manual refresh. The token must therefore be in `localStorage`
**before React mounts**. `main.tsx` already establishes this exact pattern with
`bootstrapTheme()`.

New function in `auth-api.ts` (which already owns the token slot and
`storeSession`):

```ts
const OAUTH_ERROR_KEY = "taskflow.oauth.error"

/**
 * If this page load is an OAuth callback landing (`#token=…` in the fragment),
 * store the token in the same slot password login uses and strip the fragment so
 * a refresh can't replay it. If instead it carries `#error=…` (or `?error=…`),
 * stash a message for the login screen. Idempotent and safe to call once at
 * startup, before React renders — the auth gate reads the token synchronously.
 */
export function consumeOAuthRedirect(): void {
  if (typeof window === "undefined") return
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""))
  const query = new URLSearchParams(window.location.search)
  const token = hash.get("token")
  const error = hash.get("error") ?? query.get("error")

  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token)
    // Fragment carried a bearer token — strip it so it never lingers in history
    // or a shared/copied URL. Keep the path; drop hash and any oauth query.
    window.history.replaceState(null, "", window.location.pathname)
    return
  }
  if (error) {
    window.sessionStorage.setItem(OAUTH_ERROR_KEY, error)
    window.history.replaceState(null, "", window.location.pathname)
  }
}

/** Read and clear a stored OAuth error (one-shot), for the login screen. */
export function takeOAuthError(): string | null {
  if (typeof window === "undefined") return null
  const v = window.sessionStorage.getItem(OAUTH_ERROR_KEY)
  if (v) window.sessionStorage.removeItem(OAUTH_ERROR_KEY)
  return v
}
```

`main.tsx`, next to the existing bootstrap:

```ts
bootstrapTheme()
consumeOAuthRedirect()   // must precede createRoot: the auth gate reads the token synchronously
```

The token lands in storage; `hasStoredAuthSession()` then returns true; the gate
starts `checking`; the existing `fetchCurrentUser()` validates it against
`/api/auth/me` and the app transitions to the dashboard — the same path a
password login already takes. No new auth state, no new route.

### 3. `SocialAuthButtons` becomes real

Replace the decorative component (`App.tsx:4576`). It:

- Fetches `fetchOAuthProviders()` once on mount.
- Renders one `Button` per configured provider, each navigating via
  `window.location.href = oauthLoginUrl(provider.key)` with a brief pending state.
- Renders **nothing** while loading or if the list is empty (a backend with no
  OAuth configured shows no dead buttons) — degrading the current always-two-
  buttons layout to "only what works".
- Uses a real inline **GitHub mark SVG** (no external asset — consistent with the
  SPA's other icons and any CSP). A small `key → icon` map; unknown providers
  fall back to the first letter of the label. Google's mark can be added with its
  key when Google is configured; out of scope now.

The login screen reads `takeOAuthError()` on mount and, if set, shows the existing
`AuthNotice` error styling ("Couldn't sign in with GitHub — please try again.").

## How the OAuth flow actually behaves

Verified against the `umbral-oauth-0.0.10` source (`routes.rs::oauth_callback`),
which is the deployed version — the ground truth over the older published docs.
Every path either returns the user to the SPA or fails closed with a safe
message; there is no gap that needs a crate fork or a backend change.

**Start.** Full-page navigation to `/oauth/github/login?next=<origin>/dashboard/board`. The
`next` must be prefix-allowlisted via the plugin's `allow_return` — `main.rs`
already allowlists the app's base origin (the Vite origin in dev,
`UMBRAL_OAUTH_REDIRECT_BASE` in prod), so `<origin>/dashboard/board` passes. An
un-allowlisted `next` is a 400 (we never send one).

**Success.** The callback mints a bearer token and 302-redirects to
`<next>#token=<…>&token_type=Bearer` (fragment, so the token is never sent to a
server or logged by a proxy). The SPA consumes it pre-render (§2).

**Every failure mode, from the source:**

| Case | Backend behavior (`oauth_callback`) | What the user experiences |
|---|---|---|
| User denies consent / GitHub returns `?error=` | 302 → `login_redirect` (this app: `/account/settings?github=connected`); **not** an error page | Anonymous, so the auth gate routes them to the login screen. No token; they can retry. |
| Account-link conflict (GitHub email already on another account) | `resolve_user_client_error` → a **client-safe** `(status, message)`; full detail logged server-side, never echoed | The crate's minimal safe message. Rare, and a deliberate secure default — no info leak. |
| Invalid / missing CSRF `state`, no flow in session, missing code | plain `400` | Rare; a stale or tampered flow. Retrying from the login screen starts a clean flow. |
| Token exchange / identity fetch / mint failure | `500` (safe text) | Transient provider/backend fault; retry. |

So the two common paths (success, denial) both return the user to the SPA, and
the rare hard-failures fail closed with a safe message. The SPA's job is only to
consume the success token and, defensively, to surface any `#error=`/`?error=`
that a flow does hand back (harmless if none ever does):

| SPA-side | Behavior |
|---|---|
| `#token=` present | stored pre-render → lands on `/dashboard/board`, authenticated |
| `#error=` / `?error=` present | message stashed → login screen shows an `AuthNotice` |
| neither (normal page load, or a denial that redirected to `login_redirect`) | no-op; the auth gate shows login as usual |

## Testing

- **`github-api.test.ts`** (already tests `githubConnectUrl`) — add `oauthLoginUrl`
  cases: targets `/oauth/<provider>/login`, includes an encoded `next` built from
  the origin, defaults `returnPath` to `/dashboard/board`, and is safe when
  `window` is absent.
- **`fetchOAuthProviders`** — a fetch-mocked test: maps a well-formed
  `{providers:[…]}`, drops malformed entries, returns `[]` on a non-ok response or
  bad JSON (never throws — a discovery failure must not break the login page).
- **`parseOAuthRedirect`** (new test file) — vitest runs in `node` env with no
  jsdom, so the token/error LOGIC is extracted into a pure function
  `parseOAuthRedirect(hash, search)` returning a tagged result, fully tested in
  node: `#token=` → `{kind:"token"}`; `#error=` and `?error=` → `{kind:"error"}`;
  neither → `{kind:"none"}`. `consumeOAuthRedirect` becomes a thin `window`-guarded
  wrapper around it (glue, verified manually). `takeOAuthError(storage?)` takes an
  injectable storage so its read-and-clear-once behavior is node-testable with a
  fake `Storage`.
- **Manual** (needs a browser + the real GitHub app): click "Sign in with
  GitHub", authorize, confirm landing in the dashboard authenticated and that the
  URL fragment is gone. Also verify the denial path — cancel on GitHub's consent
  screen and confirm you return to the login screen (no crash, no error page).
  This is the one path unit tests can't cover, like the MCP cold-restart.

## Migration & compatibility

No schema, no backend, no config change. The connect flow, Account Settings, and
the password-login path are untouched. A backend without OAuth configured renders
no social buttons rather than broken ones. `consumeOAuthRedirect` is a no-op on
every normal (non-callback) page load.
