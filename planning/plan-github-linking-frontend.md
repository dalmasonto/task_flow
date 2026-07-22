# GitHub Linking (frontend) Implementation Plan

> **For agentic workers:** the backend for #25 is complete and merged on branch `feat/github-linking-25`. This plan wires the `v2_fe` React UI to it, making the feature usable end-to-end. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user connect their GitHub account, an owner/admin link a project to a repo, publish a task as an issue (surfacing `#N`), post an issue comment as themselves, and toggle their per-project opt-in — all from the existing UI, with correct disabled/connect-prompt states.

**Architecture:** `v2_fe` is a monolith (`src/App.tsx`, ~9.4k lines) + a hand-written API layer (`src/lib/taskflow-api.ts`) + `react-router`. No toast system — feedback is inline state (error text / status pills / `AuthNotice` banner). UI kit is **Base UI** (not Radix). There is no FE test runner for components, so verification is `tsc -b` (strict) + `vitest` for the pure API-layer logic + a live smoke test.

**Tech Stack:** React, react-router-dom, Base UI, Tailwind, lucide-react, Vite, Vitest.

## Global Constraints

- **Backend endpoints (all live, tested):**
  - `GET  /api/taskflow/github/me` → `{ connected: bool }`
  - `GET  /api/taskflow/github/projects/{project}/status` → `{ user_connected, project_linked, github_repo, can_publish, post_as_me }`
  - `POST /api/taskflow/github/projects/{project}/link` `{ repo }` → `{ github_repo, github_linked_by }` (owner/admin; `409 {error:"needs_connect"}` if the caller isn't connected; `403` non-admin; `400 {error:"bad_repo"}`)
  - `POST /api/taskflow/github/projects/{project}/tasks/{task}/publish` → `{ issue_number, issue_url }` (`409 needs_connect`, `404 not_linked`)
  - `POST /api/taskflow/github/projects/{project}/tasks/{task}/comment` `{ body }` → `204` (`409 needs_connect`, `409 not_published`)
  - `GET/POST /api/taskflow/github/projects/{project}/pref` → `{ post_as_me }`
  - OAuth connect (full-page nav, **session-cookie** authed): `GET /oauth/github/connect`.
- **The `409 {error:"needs_connect", connect_url}` contract** is what every disabled/connect-prompt state keys on. The API layer must surface it as a typed, catchable result — never a generic error.
- **Auth:** API calls use `bearerHeaders()` (localStorage token) + `credentials:"include"`. The connect flow is a **full-page navigation** (`window.location.href`) so it carries the `umbral_session` cookie the login set — NOT an `Authorization` header.
- **Follow existing patterns exactly:** copy `reviewTask` (`taskflow-api.ts:552`) for fetch+error shape; copy the `ToggleSwitch` (`SettingsPage.tsx:219`) for the opt-in; feedback via inline state like `SettingsPage`'s `status: idle|saving|saved`.
- **Env:** `API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ""` (same-origin by default). Dev uses a Vite proxy.

## File Structure

- **Modify** `v2_fe/src/lib/taskflow-api.ts` — add the GitHub API helpers + a typed `GithubNeedsConnectError`.
- **Create** `v2_fe/src/lib/github-api.test.ts` — vitest for the needs-connect parsing + repo normalization display helper.
- **Modify** `v2_fe/vite.config.ts` — proxy `/oauth` to the backend (dev).
- **Modify** `backend/src/main.rs` — `OAuthPlugin::login_redirect("/account/settings?github=connected")` so connect returns to Settings.
- **Modify** `v2_fe/src/pages/account/SettingsPage.tsx` — "Connect GitHub" section.
- **Modify** `v2_fe/src/App.tsx`:
  - `ApiBasePage` (`:8347`) — per-project repo link + "post as me" toggle.
  - `TaskDetailSheet` (`:4586`) — "Publish as issue" button + `#N` link; thread `github_issue_number`/`github_issue_url` from `liveWorkspace.tasks` into the `Task` view-model (`:374`).
  - `TaskDetailSheet` activity map (`:4991`) — "Post to issue as me" button.

---

## Task 1: API layer — GitHub helpers + typed needs-connect error

**Files:** Modify `v2_fe/src/lib/taskflow-api.ts`; Create `v2_fe/src/lib/github-api.test.ts`.

**Interfaces produced (exact signatures later tasks call):**
```ts
export type GithubProjectStatus = {
  user_connected: boolean; project_linked: boolean;
  github_repo: string | null; can_publish: boolean; post_as_me: boolean;
}
export class GithubNeedsConnectError extends Error { connectUrl: string }
export function githubConnectUrl(returnPath?: string): string
export async function fetchGithubMe(): Promise<{ connected: boolean }>
export async function fetchGithubProjectStatus(projectId: number): Promise<GithubProjectStatus>
export async function linkGithubProject(projectId: number, repo: string): Promise<{ github_repo: string }>
export async function publishTaskAsIssue(projectId: number, taskId: number): Promise<{ issue_number: number; issue_url: string }>
export async function commentOnIssueAsMe(projectId: number, taskId: number, body: string): Promise<void>
export async function setGithubPostAsMe(projectId: number, postAsMe: boolean): Promise<{ post_as_me: boolean }>
export function issueRefFromUrl(url: string | null): string | null // "…/issues/7" -> "#7"
```

- [ ] **Step 1: Write the failing vitest** — `github-api.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { issueRefFromUrl, githubConnectUrl } from "./taskflow-api"

describe("issueRefFromUrl", () => {
  it("renders #N from a github issue url", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets/issues/7")).toBe("#7")
  })
  it("returns null for no url", () => {
    expect(issueRefFromUrl(null)).toBeNull()
  })
})

describe("githubConnectUrl", () => {
  it("targets the backend connect route and passes an allowlisted next", () => {
    const url = githubConnectUrl("/account/settings?github=connected")
    expect(url).toContain("/oauth/github/connect")
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd v2_fe && npx vitest run src/lib/github-api.test.ts`
Expected: FAIL — `issueRefFromUrl` / `githubConnectUrl` are not exported.

- [ ] **Step 3: Implement the helpers** — append to `taskflow-api.ts` (uses the existing `API_BASE_URL`, `bearerHeaders`, `readErrorDetail`). For each mutating call, detect the `needs_connect` body and throw `GithubNeedsConnectError`:

```ts
// --- GitHub integration -----------------------------------------------------
export type GithubProjectStatus = {
  user_connected: boolean
  project_linked: boolean
  github_repo: string | null
  can_publish: boolean
  post_as_me: boolean
}

export class GithubNeedsConnectError extends Error {
  connectUrl: string
  constructor(connectUrl: string) {
    super("Connect your GitHub account to continue.")
    this.name = "GithubNeedsConnectError"
    this.connectUrl = connectUrl
  }
}

/** Full-page connect URL. `returnPath` becomes the post-connect landing (must be
 * an allowlisted return URL on the backend; login_redirect is the fallback). */
export function githubConnectUrl(returnPath?: string): string {
  const base = `${API_BASE_URL}/oauth/github/connect`
  if (!returnPath) return base
  const next = `${window.location.origin}${returnPath}`
  return `${base}?next=${encodeURIComponent(next)}`
}

/** "https://github.com/acme/widgets/issues/7" -> "#7". */
export function issueRefFromUrl(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/\/issues\/(\d+)/)
  return m ? `#${m[1]}` : null
}

async function githubMutate(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 409) {
    const data = await response.clone().json().catch(() => null) as
      | { error?: string; connect_url?: string } | null
    if (data?.error === "needs_connect") {
      throw new GithubNeedsConnectError(data.connect_url ?? "/oauth/github/connect")
    }
  }
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `GitHub request failed (${response.status}).`))
  }
  return response
}

export async function fetchGithubMe(): Promise<{ connected: boolean }> {
  const r = await fetch(`${API_BASE_URL}/api/taskflow/github/me`, {
    credentials: "include", headers: bearerHeaders(),
  })
  if (!r.ok) throw new Error(await readErrorDetail(r, "Could not check GitHub status."))
  return r.json()
}

export async function fetchGithubProjectStatus(projectId: number): Promise<GithubProjectStatus> {
  const r = await fetch(`${API_BASE_URL}/api/taskflow/github/projects/${projectId}/status`, {
    credentials: "include", headers: bearerHeaders(),
  })
  if (!r.ok) throw new Error(await readErrorDetail(r, "Could not load GitHub status."))
  return r.json()
}

export async function linkGithubProject(projectId: number, repo: string): Promise<{ github_repo: string }> {
  const r = await githubMutate(`/api/taskflow/github/projects/${projectId}/link`, { repo })
  return r.json()
}

export async function publishTaskAsIssue(projectId: number, taskId: number): Promise<{ issue_number: number; issue_url: string }> {
  const r = await githubMutate(`/api/taskflow/github/projects/${projectId}/tasks/${taskId}/publish`)
  return r.json()
}

export async function commentOnIssueAsMe(projectId: number, taskId: number, body: string): Promise<void> {
  await githubMutate(`/api/taskflow/github/projects/${projectId}/tasks/${taskId}/comment`, { body })
}

export async function setGithubPostAsMe(projectId: number, postAsMe: boolean): Promise<{ post_as_me: boolean }> {
  const r = await githubMutate(`/api/taskflow/github/projects/${projectId}/pref`, { post_as_me: postAsMe })
  return r.json()
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd v2_fe && npx vitest run src/lib/github-api.test.ts && npx tsc -b`
Expected: test PASS; `tsc` clean. (If `bearerHeaders`/`readErrorDetail` are not in scope at the append point, move the block above their definitions or export them — they are module-local functions near the file end.)

- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/lib/taskflow-api.ts v2_fe/src/lib/github-api.test.ts
git commit -m "feat(#25): frontend GitHub API helpers + needs-connect error"
```

---

## Task 2: Connect-flow plumbing (vite proxy + login_redirect)

**Files:** Modify `v2_fe/vite.config.ts`, `backend/src/main.rs`.

- [ ] **Step 1: Proxy `/oauth` in dev**

In `vite.config.ts` `server.proxy`, add alongside `/api`:

```ts
      '/oauth': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
```

- [ ] **Step 2: Return to Settings after connect**

In `backend/src/main.rs`, change the OAuth block to set a login redirect:

```rust
        .plugin({
            let mut oauth = OAuthPlugin::new("http://localhost:8100")
                .login_redirect("/account/settings?github=connected");
            if let Some(gh) = GitHubProvider::from_env() {
                oauth = oauth.provider(gh.scopes("repo"));
            }
            oauth
        })
```

- [ ] **Step 3: Verify backend still builds**

Run: `cd backend && cargo build --bin backend 2>&1 | tail -3`
Expected: Finished.

- [ ] **Step 4: Commit**

```bash
git add v2_fe/vite.config.ts backend/src/main.rs
git commit -m "feat(#25): proxy /oauth in dev + return to settings after connect"
```

---

## Task 3: "Connect GitHub" in Settings

**Files:** Modify `v2_fe/src/pages/account/SettingsPage.tsx`.

**Behavior:** A new card shows connection state (`fetchGithubMe`). If disconnected: a "Connect GitHub" button → `window.location.href = githubConnectUrl("/account/settings?github=connected")`. On mount, if `?github=connected` is present, show a success banner and refetch. If connected: show "Connected" with a muted note.

- [ ] **Step 1: Add state + effect** near the top of the `SettingsPage` component:

```tsx
const [githubConnected, setGithubConnected] = useState<boolean | null>(null)
const [githubJustConnected, setGithubJustConnected] = useState(false)
useEffect(() => {
  const p = new URLSearchParams(window.location.search)
  if (p.get("github") === "connected") setGithubJustConnected(true)
  fetchGithubMe().then((r) => setGithubConnected(r.connected)).catch(() => setGithubConnected(false))
}, [])
```

- [ ] **Step 2: Add the card** in the returned JSX, mirroring an existing `<section>` card (Appearance card is the template). Use `Button` from `@/components/ui/button`:

```tsx
<section className="rounded-xl border border-border bg-card p-5">
  <h2 className="text-sm font-semibold">GitHub</h2>
  <p className="mt-1 text-xs text-muted-foreground">
    Connect your GitHub account so the app can open issues and post comments as you.
  </p>
  {githubJustConnected && (
    <p className="mt-2 text-xs text-emerald-600">GitHub connected.</p>
  )}
  <div className="mt-3">
    {githubConnected === null ? (
      <span className="text-xs text-muted-foreground">Checking…</span>
    ) : githubConnected ? (
      <span className="inline-flex items-center gap-2 text-xs text-emerald-600">
        <Check className="size-4" /> Connected
      </span>
    ) : (
      <Button
        variant="outline"
        onClick={() => { window.location.href = githubConnectUrl("/account/settings?github=connected") }}
      >
        Connect GitHub
      </Button>
    )}
  </div>
</section>
```

- [ ] **Step 3: Imports** — add `fetchGithubMe, githubConnectUrl` from `@/lib/taskflow-api`, `Button` from `@/components/ui/button`, `Check` from `lucide-react` (check existing imports first; `useState`/`useEffect` likely already imported).

- [ ] **Step 4: Typecheck**

Run: `cd v2_fe && npx tsc -b`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/pages/account/SettingsPage.tsx
git commit -m "feat(#25): Connect GitHub section in account settings"
```

---

## Task 4: Per-project repo link + "post as me" toggle (ApiBasePage)

**Files:** Modify `v2_fe/src/App.tsx` (`ApiBasePage`, ~`:8347`).

**Behavior:** A "GitHub" card loads `fetchGithubProjectStatus(project.id)`. Shows the linked repo or an input + "Link repo" button (owner/admin — a non-admin gets `403`, surfaced as an error). If the caller isn't connected, "Link repo" is disabled with a "Connect GitHub first" hint linking to Settings. A `ToggleSwitch` (copied from `SettingsPage:219`) drives `setGithubPostAsMe`.

- [ ] **Step 1: Read the current `ApiBasePage`** to find its props (`project`, `workspace`, `onUpdateProject`) and JSX card layout. `sed -n '8347,8460p' src/App.tsx`.

- [ ] **Step 2: Add local state + loader** inside `ApiBasePage`:

```tsx
const [ghStatus, setGhStatus] = useState<GithubProjectStatus | null>(null)
const [repoInput, setRepoInput] = useState("")
const [ghBusy, setGhBusy] = useState(false)
const [ghError, setGhError] = useState<string | null>(null)
useEffect(() => {
  fetchGithubProjectStatus(project.id)
    .then((s) => { setGhStatus(s); setRepoInput(s.github_repo ?? "") })
    .catch(() => setGhStatus(null))
}, [project.id])
```

- [ ] **Step 3: Add the card JSX** (place after the existing API-base card). Uses `Input`, `Button`, and a local `ToggleSwitch`:

```tsx
<section className="rounded-xl border border-border bg-card p-5">
  <h2 className="text-sm font-semibold">GitHub</h2>
  {!ghStatus ? (
    <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
  ) : (
    <>
      {!ghStatus.user_connected && (
        <p className="mt-2 text-xs text-amber-600">
          <Link to="/account/settings" className="underline">Connect your GitHub</Link> to link a repo.
        </p>
      )}
      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1 text-xs">
          <span className="text-muted-foreground">Repository (owner/name)</span>
          <Input value={repoInput} onChange={(e) => setRepoInput(e.target.value)}
                 placeholder="acme/widgets" className="mt-1" />
        </label>
        <Button
          disabled={ghBusy || !ghStatus.user_connected || !repoInput.trim()}
          onClick={async () => {
            setGhBusy(true); setGhError(null)
            try {
              const r = await linkGithubProject(project.id, repoInput.trim())
              setGhStatus({ ...ghStatus, project_linked: true, github_repo: r.github_repo, can_publish: true })
            } catch (e) {
              setGhError(e instanceof GithubNeedsConnectError ? "Connect your GitHub first." : (e as Error).message)
            } finally { setGhBusy(false) }
          }}
        >{ghStatus.project_linked ? "Update repo" : "Link repo"}</Button>
      </div>
      {ghStatus.project_linked && ghStatus.github_repo && (
        <p className="mt-2 text-xs text-muted-foreground">Linked to <span className="font-mono">{ghStatus.github_repo}</span>.</p>
      )}
      {ghError && <p className="mt-2 text-xs text-destructive">{ghError}</p>}
      <label className="mt-4 flex items-center justify-between">
        <span className="text-xs">Let the app post issue comments as me</span>
        <ToggleSwitch
          checked={ghStatus.post_as_me}
          onChange={async (on) => {
            setGhStatus({ ...ghStatus, post_as_me: on })
            try { await setGithubPostAsMe(project.id, on) }
            catch { setGhStatus({ ...ghStatus, post_as_me: !on }) }
          }}
        />
      </label>
    </>
  )}
</section>
```

- [ ] **Step 4: Add a local `ToggleSwitch`** — copy the one from `SettingsPage.tsx:219` (role="switch") either as a shared import or inline near `ApiBasePage`. Prefer extracting it to `@/components/ui/toggle-switch.tsx` and importing in both places (DRY); if that risks churn, inline a copy with a comment pointing at the original.

- [ ] **Step 5: Imports** — `fetchGithubProjectStatus, linkGithubProject, setGithubPostAsMe, GithubNeedsConnectError, type GithubProjectStatus` from `@/lib/taskflow-api`; `Input`, `Button`, `Link` (react-router) if not already imported in App.tsx (they are).

- [ ] **Step 6: Typecheck + commit**

Run: `cd v2_fe && npx tsc -b`
```bash
git add v2_fe/src/App.tsx v2_fe/src/components/ui/toggle-switch.tsx v2_fe/src/pages/account/SettingsPage.tsx
git commit -m "feat(#25): per-project GitHub repo link + post-as-me toggle"
```

---

## Task 5: "Publish as issue" button + `#N` in the task sheet

**Files:** Modify `v2_fe/src/App.tsx` (`TaskDetailSheet` `:4586`, `Task` view-model `:374`, the view-model builder).

**Behavior:** The task header shows the issue link (`#N` → `issue_url`) if published, with a copy button. If not published: a "Publish as GitHub issue" button (disabled unless `status.can_publish`; if `!can_publish` show a hint). On success, store the returned number/url locally (realtime will also refresh the row). A `needs_connect` error routes the user to connect.

- [ ] **Step 1: Thread the issue fields into the view-model.** Read the `Task` type (`:374`) and its builder (search `githubIssue`/the fn that maps `TaskflowTask` → `Task`). Add `githubIssueNumber: number | null` and `githubIssueUrl: string | null` to the `Task` type and populate from the raw row (`liveWorkspace.tasks`). If the sheet already has `liveWorkspace`, read the raw row directly instead:

```ts
const rawTask = liveWorkspace?.tasks.find((t) => t.id === task.id)
const issueNumber = rawTask?.github_issue_number ?? null
const issueUrl = rawTask?.github_issue_url ?? null
```

- [ ] **Step 2: Load project GitHub status** in `TaskDetailSheet`:

```tsx
const [ghStatus, setGhStatus] = useState<GithubProjectStatus | null>(null)
useEffect(() => {
  if (!project?.id) return
  fetchGithubProjectStatus(project.id).then(setGhStatus).catch(() => setGhStatus(null))
}, [project?.id])
const [publishing, setPublishing] = useState(false)
const [ghError, setGhError] = useState<string | null>(null)
const [localIssue, setLocalIssue] = useState<{ number: number; url: string } | null>(null)
```

- [ ] **Step 3: Add the header UI** near the id badge (`:4698`) / action cluster (`:4716`). Show the link if `issueNumber ?? localIssue`, else the button:

```tsx
{(localIssue || issueNumber) ? (
  <a href={localIssue?.url ?? issueUrl ?? "#"} target="_blank" rel="noreferrer"
     className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
    <Github className="size-3.5" /> {`#${localIssue?.number ?? issueNumber}`}
  </a>
) : ghStatus?.project_linked ? (
  <Button size="sm" variant="outline" disabled={publishing || !ghStatus.can_publish}
    onClick={async () => {
      setPublishing(true); setGhError(null)
      try {
        const r = await publishTaskAsIssue(project.id, task.id)
        setLocalIssue({ number: r.issue_number, url: r.issue_url })
      } catch (e) {
        setGhError(e instanceof GithubNeedsConnectError ? "Connect GitHub to publish." : (e as Error).message)
      } finally { setPublishing(false) }
    }}>
    <Github className="size-3.5" /> {publishing ? "Publishing…" : "Publish as issue"}
  </Button>
) : null}
{ghError && <span className="text-xs text-destructive">{ghError}</span>}
```

- [ ] **Step 4: Imports** — `fetchGithubProjectStatus, publishTaskAsIssue, GithubNeedsConnectError, type GithubProjectStatus` from `@/lib/taskflow-api`; `Github` from `lucide-react`.

- [ ] **Step 5: Typecheck + commit**

Run: `cd v2_fe && npx tsc -b`
```bash
git add v2_fe/src/App.tsx
git commit -m "feat(#25): publish task as GitHub issue + surface #N in the task sheet"
```

---

## Task 6: "Post to issue as me" in the activity feed

**Files:** Modify `v2_fe/src/App.tsx` (activity map in `TaskDetailSheet` `:4991`).

**Behavior:** When the task has an issue (`issueNumber`/`localIssue`), each activity row gets a small "Post to issue" button that sends that activity's text as a comment via `commentOnIssueAsMe`. Disabled with a connect prompt when `!ghStatus.post_as_me` or `!ghStatus.user_connected`; a `needs_connect` error routes to connect. Shows a transient "Posted" state per row.

- [ ] **Step 1: Add per-row posting state** near the activity render:

```tsx
const [postedActivityIds, setPostedActivityIds] = useState<Set<string>>(new Set())
const [postingActivityId, setPostingActivityId] = useState<string | null>(null)
const canComment = Boolean((localIssue || issueNumber) && ghStatus?.user_connected && ghStatus?.post_as_me)
```

- [ ] **Step 2: Add the button inside the activity `.map`** (`:4991`), using the event's detail/body as the comment:

```tsx
{(localIssue || issueNumber) && (
  postedActivityIds.has(event.id) ? (
    <span className="text-[11px] text-emerald-600">Posted</span>
  ) : (
    <button
      className="text-[11px] text-muted-foreground hover:text-primary disabled:opacity-50"
      disabled={!canComment || postingActivityId === event.id}
      title={canComment ? "Post this to the issue as you" : "Enable ‘post as me’ in project settings and connect GitHub"}
      onClick={async () => {
        setPostingActivityId(event.id); setGhError(null)
        try {
          await commentOnIssueAsMe(project.id, task.id, event.detail ?? event.action ?? "")
          setPostedActivityIds((s) => new Set(s).add(event.id))
        } catch (e) {
          setGhError(e instanceof GithubNeedsConnectError ? "Connect GitHub / enable post-as-me." : (e as Error).message)
        } finally { setPostingActivityId(null) }
      }}
    >Post to issue</button>
  )
)}
```

(Adjust `event.detail`/`event.action`/`event.id` to the real fields of the activity view-model returned by `getLiveTaskActivity` — read `:4667`/`:4991` first.)

- [ ] **Step 2b: Imports** — add `commentOnIssueAsMe` from `@/lib/taskflow-api`.

- [ ] **Step 3: Typecheck + commit**

Run: `cd v2_fe && npx tsc -b`
```bash
git add v2_fe/src/App.tsx
git commit -m "feat(#25): post a task activity to its GitHub issue as the acting user"
```

---

## Task 7: Full build + live smoke

- [ ] **Step 1: Build the frontend**

Run: `cd v2_fe && npm run build`
Expected: `tsc -b` clean + `vite build` succeeds.

- [ ] **Step 2: Run the FE unit tests**

Run: `cd v2_fe && npx vitest run`
Expected: all green (existing + new `github-api.test.ts`).

- [ ] **Step 3: Live smoke (manual/observed)** — start backend (`cargo run -- serve`) and `npm run dev`, then:
  - Settings → "Connect GitHub" is visible (requires `UMBRAL_OAUTH_GITHUB_CLIENT_ID/SECRET` to actually complete the OAuth round-trip; without them the button still renders and `/oauth/providers` is empty).
  - Project → API/settings page shows the GitHub card; linking with an unconnected account shows the connect hint.
  - Open a task → "Publish as issue" appears when the project is linked and `can_publish`.
  - Verify the disabled/connect-prompt states with a disconnected account.

- [ ] **Step 4: Final commit / summary** — nothing to commit if prior tasks committed; report status.

---

## Self-Review

- **Spec coverage:** connect (T3), project link (T4), publish + `#N` (T5), comment-as-me (T6), opt-in toggle (T4), disabled/connect-prompt states everywhere via `status`/`needs_connect` (T1 error type consumed in T3–T6). ✓
- **Backend contract:** every helper in T1 maps to a live, tested endpoint; `needs_connect` is a typed error consumed by all four action surfaces. ✓
- **No FE component test runner** → verification is `tsc -b` (strict) + `vitest` for the API layer + a live smoke; called out explicitly rather than pretending component TDD exists. ✓
- **Risk:** exact line numbers in the 9.4k-line `App.tsx` drift; every App.tsx task starts by reading the current region before editing. The activity/event field names (`event.detail/id`) must be confirmed against `getLiveTaskActivity` before Task 6. ✓
- **Connect-flow caveat:** relies on the `umbral_session` cookie from login (confirmed set by `/api/auth/login`) + the `/oauth` dev proxy; cross-origin `VITE_API_BASE_URL` deployments need the cookie to be SameSite-compatible and the `next` URL allowlisted — noted, out of scope for the default same-origin setup.
