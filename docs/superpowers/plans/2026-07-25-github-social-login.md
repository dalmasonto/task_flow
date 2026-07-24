# GitHub Social Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person sign IN to TaskFlow with GitHub — wire the decorative social buttons to the OAuth login flow that the backend already serves, and consume the bearer token it returns.

**Architecture:** Frontend-only. The `umbral-oauth` backend flow already works (`/oauth/github/login?next=…` → GitHub → callback mints a token → redirects to `<next>#token=…&token_type=Bearer`). Three pieces: URL/discovery helpers beside the existing `githubConnectUrl` in `taskflow-api.ts`; a pre-render token consumer in `main.tsx` (the auth gate reads its state synchronously, so a `useEffect` would be too late); and a provider-driven `SocialAuthButtons` bearing the inline GitHub mark. The connect flow and Account Settings are untouched.

**Tech Stack:** React + TypeScript (Vite), vitest (**node env — no jsdom, no component-test infra**), existing `auth-api.ts` / `taskflow-api.ts` helpers.

**Spec:** `docs/superpowers/specs/2026-07-25-github-social-login-design.md`

## Global Constraints

- All paths are relative to `/home/dalmas/E/projects/local_task_tracker/v2_fe` unless stated. Run all commands from there.
- **No backend changes.** The flow, token minting, and provider registration all exist. Do not touch `backend/`, `main.rs`, or the vendored `umbral-oauth` crate.
- **Do not touch, duplicate, or regress the CONNECT flow**: `githubConnectUrl` (`taskflow-api.ts:1334`), its use in `SettingsPage.tsx:274`, or anything in Account Settings. This plan adds the LOGIN half only.
- **vitest runs in `node` environment** (`vite.config.ts:39`), and there is **no jsdom, happy-dom, or @testing-library** installed. Do NOT add them. Test pure logic in node; extract DOM-touching logic into pure functions or inject seams; verify React components manually.
- The token slot is `AUTH_TOKEN_KEY = "taskflow.auth.token"` in `auth-api.ts` — the exact slot password login uses. The OAuth token must land there and nowhere else.
- The OAuth return target is **`/dashboard/board`**, never `/login`: `App.tsx:2726` renders `<AuthPage>` for any auth-route path *before* the auth check, so an authenticated user landing on `/login` would be stuck on the login form.
- Icons are inline SVG (no external asset), consistent with the rest of the SPA.
- Run tests with `npm test` (vitest, single run). Typecheck/build with `npm run build` (runs `tsc -b` then vite). The eslint baseline is already dirty (10 errors, pre-existing) — compare against that, never 0.
- Follow existing style: `githubConnectUrl` guards `typeof window !== "undefined"` and returns origin `""` when absent; mirror that.

---

### Task 1: OAuth login URL + provider discovery helpers

The sign-in counterpart to `githubConnectUrl`, in the same module, plus a discovery call so only configured providers render.

**Files:**
- Modify: `src/lib/taskflow-api.ts` (add to the GitHub/OAuth section near `githubConnectUrl`, ~line 1334)
- Test: `src/lib/github-api.test.ts` (already imports from `./taskflow-api`; append)

**Interfaces:**
- Consumes: `API_BASE_URL` (already in scope in `taskflow-api.ts`).
- Produces:
  - `oauthLoginUrl(provider: string, returnPath?: string): string`
  - `type OAuthProvider = { key: string; label: string }`
  - `fetchOAuthProviders(): Promise<OAuthProvider[]>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/github-api.test.ts`:

```ts
import { oauthLoginUrl, fetchOAuthProviders } from "./taskflow-api"
import { afterEach, vi } from "vitest"

describe("oauthLoginUrl", () => {
  it("targets the backend login route for the given provider", () => {
    expect(oauthLoginUrl("github")).toContain("/oauth/github/login")
  })
  it("passes an encoded next return url", () => {
    const url = oauthLoginUrl("github")
    expect(url).toContain("next=")
    // returnPath is encoded, so the raw slash is percent-escaped
    expect(url).toContain(encodeURIComponent("/dashboard/board"))
  })
  it("honours a custom returnPath", () => {
    expect(oauthLoginUrl("github", "/dashboard/agents")).toContain(
      encodeURIComponent("/dashboard/agents"),
    )
  })
  it("does not throw when window is absent (SSR/node)", () => {
    // In the node test env `window` is undefined; origin resolves to "".
    expect(() => oauthLoginUrl("google")).not.toThrow()
    expect(oauthLoginUrl("google")).toContain("/oauth/google/login")
  })
})

describe("fetchOAuthProviders", () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubFetch = (impl: () => Promise<Response> | Response) =>
    vi.stubGlobal("fetch", vi.fn(impl))

  it("maps a well-formed providers payload", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ providers: [{ key: "github", label: "GitHub" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(await fetchOAuthProviders()).toEqual([{ key: "github", label: "GitHub" }])
  })

  it("drops malformed entries", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ providers: [{ key: "github", label: "GitHub" }, { key: 5 }, {}] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    expect(await fetchOAuthProviders()).toEqual([{ key: "github", label: "GitHub" }])
  })

  it("returns [] on a non-ok response rather than throwing", async () => {
    stubFetch(() => new Response("nope", { status: 500 }))
    expect(await fetchOAuthProviders()).toEqual([])
  })

  it("returns [] on unparseable JSON", async () => {
    stubFetch(() => new Response("{ not json", { status: 200 }))
    expect(await fetchOAuthProviders()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- github-api`
Expected: FAIL — `oauthLoginUrl`/`fetchOAuthProviders` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/taskflow-api.ts`, immediately after `githubConnectUrl` (the function ending near line 1342), add:

```ts
/**
 * Full-page LOGIN url for a social provider — the sign-in counterpart to
 * `githubConnectUrl`. The backend mints a bearer token on a login flow with an
 * allowlisted `next` and returns it in the URL fragment; `returnPath` is where
 * the browser lands (default `/dashboard/board`).
 *
 * The target must NOT be an auth route: `App.tsx` renders the login form for
 * `/login` BEFORE the auth check, so an already-authenticated user would be
 * stuck there. `/dashboard/board` is the same landing a password login uses.
 *
 * Safe under SSR/vitest where `window` is absent (origin resolves to "").
 */
export function oauthLoginUrl(provider: string, returnPath = "/dashboard/board"): string {
  const base = `${API_BASE_URL}/oauth/${provider}/login`
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  return `${base}?next=${encodeURIComponent(`${origin}${returnPath}`)}`
}

/** A social provider the backend has configured, for rendering only real buttons. */
export type OAuthProvider = { key: string; label: string }

/**
 * The providers the backend has actually configured (`GET /oauth/providers`).
 * Used to render a button only for a provider that will work — GitHub today,
 * Google automatically once its env credentials are added. Never throws: a
 * discovery failure must not break the login page, so it degrades to [].
 */
export async function fetchOAuthProviders(): Promise<OAuthProvider[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/oauth/providers`)
    if (!res.ok) return []
    const data = (await res.json()) as
      | { providers?: Array<{ key?: unknown; label?: unknown }> }
      | null
    return (data?.providers ?? [])
      .filter(
        (p): p is { key: string; label: string } =>
          typeof p?.key === "string" && typeof p?.label === "string",
      )
      .map((p) => ({ key: p.key, label: p.label }))
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- github-api`
Expected: PASS — the existing `githubConnectUrl`/`issueRefFromUrl` tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/taskflow-api.ts src/lib/github-api.test.ts
git commit -m "feat(v2_fe): add oauthLoginUrl + fetchOAuthProviders beside githubConnectUrl"
```

---

### Task 2: Consume the OAuth token before React renders

The token comes back in the URL fragment. The auth gate reads `hasStoredAuthSession()` synchronously in a `useState` initializer, so the token must be stored *before* React mounts. The parsing logic is extracted into a pure, node-testable function.

**Files:**
- Modify: `src/lib/auth-api.ts` (add exports; `AUTH_TOKEN_KEY` already exists at line 1)
- Modify: `src/main.tsx` (call the consumer before `createRoot`)
- Test: `src/lib/auth-api.test.ts` (new)

**Interfaces:**
- Consumes: `AUTH_TOKEN_KEY` (module-local in `auth-api.ts`).
- Produces:
  - `type OAuthRedirect = { kind: "token"; token: string } | { kind: "error"; message: string } | { kind: "none" }`
  - `parseOAuthRedirect(hash: string, search: string): OAuthRedirect`
  - `consumeOAuthRedirect(): void`
  - `takeOAuthError(storage?: Pick<Storage, "getItem" | "removeItem">): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/auth-api.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { parseOAuthRedirect, takeOAuthError } from "./auth-api"

describe("parseOAuthRedirect", () => {
  it("extracts a bearer token from the fragment", () => {
    expect(parseOAuthRedirect("#token=abc123&token_type=Bearer", "")).toEqual({
      kind: "token",
      token: "abc123",
    })
  })
  it("tolerates a fragment with no leading #", () => {
    expect(parseOAuthRedirect("token=abc123", "")).toEqual({ kind: "token", token: "abc123" })
  })
  it("surfaces an error from the fragment", () => {
    expect(parseOAuthRedirect("#error=access_denied", "")).toEqual({
      kind: "error",
      message: "access_denied",
    })
  })
  it("surfaces an error from the query string too", () => {
    expect(parseOAuthRedirect("", "?error=access_denied")).toEqual({
      kind: "error",
      message: "access_denied",
    })
  })
  it("prefers a token over a stray error param", () => {
    expect(parseOAuthRedirect("#token=abc&error=whatever", "")).toEqual({
      kind: "token",
      token: "abc",
    })
  })
  it("reports none for an ordinary page load", () => {
    expect(parseOAuthRedirect("", "")).toEqual({ kind: "none" })
    expect(parseOAuthRedirect("#section=1", "?page=2")).toEqual({ kind: "none" })
  })
})

describe("takeOAuthError", () => {
  it("reads and clears the stored error exactly once", () => {
    const store = new Map<string, string>([["taskflow.oauth.error", "access_denied"]])
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    }
    expect(takeOAuthError(storage)).toBe("access_denied")
    expect(takeOAuthError(storage)).toBeNull()
  })
  it("returns null when there is nothing stored", () => {
    const storage = { getItem: () => null, removeItem: () => {} }
    expect(takeOAuthError(storage)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- auth-api`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `auth-api.ts`**

Add after the existing storage helpers (after `clearStoredSession`, ~line 58):

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- auth-api`
Expected: PASS.

- [ ] **Step 5: Wire it into `main.tsx`**

In `src/main.tsx`, import the consumer and call it right after `bootstrapTheme()`, before `createRoot`:

```ts
import { bootstrapTheme } from "@/lib/theme"
import { consumeOAuthRedirect } from "@/lib/auth-api"

bootstrapTheme()
// Must precede createRoot: an OAuth callback returns the bearer token in the URL
// fragment, and the auth gate reads stored auth SYNCHRONOUSLY on first render —
// a useEffect would land the token too late and strand the user on /login.
consumeOAuthRedirect()
```

- [ ] **Step 6: Verify the build and full suite**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc -b` + vite build clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth-api.ts src/lib/auth-api.test.ts src/main.tsx
git commit -m "feat(v2_fe): consume the OAuth callback token before React renders"
```

---

### Task 3: Make `SocialAuthButtons` real, with the GitHub mark and the error notice

Replace the decorative component and surface any stashed OAuth error on the login screen.

**Files:**
- Modify: `src/App.tsx` (rewrite `SocialAuthButtons` at ~line 4576; add an error-notice effect in the auth form component at ~line 4343)

**Interfaces:**
- Consumes: `oauthLoginUrl`, `fetchOAuthProviders`, `OAuthProvider` (Task 1); `takeOAuthError` (Task 2); the existing `Button` (`App.tsx:61`), `AuthNotice`, `AuthResult`, and the auth form's `setAuthResult`.
- Produces: no exported interface — internal UI.

- [ ] **Step 1: Add the imports**

In `src/App.tsx`, add to the `taskflow-api` import group and the `auth-api` import group (find the existing `from "@/lib/taskflow-api"` and `from "@/lib/auth-api"` import blocks):

```ts
// from "@/lib/taskflow-api"
oauthLoginUrl,
fetchOAuthProviders,
type OAuthProvider,
// from "@/lib/auth-api"
takeOAuthError,
```

- [ ] **Step 2: Add an inline GitHub mark component**

Near the other small presentational helpers (e.g. just above `SocialAuthButtons`), add:

```tsx
/** The official GitHub mark, inline so there is no external asset or CSP concern. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** Provider key → its brand icon; unknown providers fall back to a text glyph. */
function providerIcon(key: string) {
  if (key === "github") return <GithubMark className="size-4" />
  return (
    <span className="flex size-4 items-center justify-center rounded-full border text-[0.65rem] font-bold">
      {key.charAt(0).toUpperCase()}
    </span>
  )
}
```

- [ ] **Step 3: Rewrite `SocialAuthButtons`**

Replace the whole decorative function (`App.tsx:4576-4593`) with:

```tsx
function SocialAuthButtons() {
  const [providers, setProviders] = useState<OAuthProvider[]>([])
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchOAuthProviders().then((list) => {
      if (active) setProviders(list)
    })
    return () => {
      active = false
    }
  }, [])

  // Nothing configured (or still loading) → render nothing rather than a dead
  // button. A backend with no OAuth simply shows the password form alone.
  if (providers.length === 0) return null

  return (
    <div className="mt-5 grid gap-2 sm:grid-cols-2">
      {providers.map((provider) => (
        <Button
          key={provider.key}
          type="button"
          variant="outline"
          className="w-full justify-center"
          disabled={pending !== null}
          onClick={() => {
            setPending(provider.key)
            // Full-page navigation into the backend flow; the callback returns
            // to /dashboard/board with the token in the fragment.
            window.location.href = oauthLoginUrl(provider.key)
          }}
        >
          {providerIcon(provider.key)}
          {pending === provider.key ? "Redirecting…" : `Continue with ${provider.label}`}
        </Button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Surface a stashed OAuth error on the login screen**

In the auth form component (the one with `const [authResult, setAuthResult] = useState<AuthResult | null>(null)` at ~line 4343), add an effect that runs once on mount, after that state is declared:

```tsx
  // An OAuth callback that returned an error (rare — see the spec) stashed a
  // message pre-render; surface it here in the same notice password errors use.
  useEffect(() => {
    const oauthError = takeOAuthError()
    if (oauthError) {
      setAuthResult({ ok: false, message: "Couldn't sign in with GitHub. Please try again." })
    }
  }, [])
```

- [ ] **Step 5: Typecheck, build, and confirm the lint baseline did not worsen**

Run: `npm run build`
Expected: `tsc -b` + vite build clean.

Run: `npx eslint src/App.tsx src/lib/taskflow-api.ts src/lib/auth-api.ts src/main.tsx`
Expected: no NEW errors beyond the known pre-existing baseline (the repo sits at ~10 pre-existing errors, all in `App.tsx` and other files — none from this change). If a new error is attributable to this diff, fix it.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(v2_fe): wire the GitHub sign-in button to the OAuth login flow"
```

---

### Task 4: Verify the full flow

Automated coverage plus the one path unit tests can't reach.

**Files:** none modified.

- [ ] **Step 1: Full automated verification**

Run: `npm test && npm run build`
Expected: all tests PASS (record the count); build clean. Confirm the new suites (`github-api`, `auth-api`) are among them.

- [ ] **Step 2: Confirm the button renders against the live backend**

The dev backend serves `/oauth/providers`. With the dev server running (`npm run dev`, proxying to `:8000`), load `/login` and confirm a single "Continue with GitHub" button with the GitHub mark appears (Google is not configured, so no Google button). This needs a browser; if none is available, note it for the user.

- [ ] **Step 3: Manual end-to-end (needs a browser + the real GitHub app)**

Hand these to the user if no browser is available here:
1. Click "Continue with GitHub" → GitHub consent → authorize → confirm you land on `/dashboard/board`, authenticated, and the URL has no `#token=` fragment.
2. Repeat and **cancel** on GitHub's consent screen → confirm you return to the login screen with no crash and no error page (the backend redirects a denial to `login_redirect`).
3. Confirm the **connect** flow is unaffected: while logged in, Account Settings → "Connect GitHub" still works exactly as before.

- [ ] **Step 4: Commit any fixes from the live run**

```bash
git add -u src/
git commit -m "fix(v2_fe): <whatever the live run turned up>"
```

---

## Notes for the implementer

- **Never store the OAuth token anywhere but `AUTH_TOKEN_KEY`.** A second slot would desync from `hasStoredAuthSession`/`fetchCurrentUser` and the whole gate logic.
- **Do not add jsdom / testing-library.** The React component (`SocialAuthButtons`, the notice effect) is verified manually by design — every testable decision was extracted into `oauthLoginUrl`, `fetchOAuthProviders`, `parseOAuthRedirect`, and `takeOAuthError`, which are covered in node.
- **The return target is `/dashboard/board`, not `/login`.** `/login` renders the auth form before the auth check, so an authenticated user would be stranded there.
- **The error-notice path is defensive.** A GitHub denial redirects to `login_redirect` without an `#error=`, so in practice the notice rarely fires; it exists for any flow that does hand back an error param. Do not build elaborate UX on top of it.
