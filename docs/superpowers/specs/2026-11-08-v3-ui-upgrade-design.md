# v3 UI upgrade: foundation and screen port

Date: 2026-11-08. Owner: Claude (main), lead. Builder alongside: reviewer (codex).
Channel: project 2, #63 (UI upgrade and new features). Approved order: #MSG5640, approved in #MSG5643.

## Why

The design project (about 95 routes and 23 `tf-*` components) is now well ahead of the
shipped v2 UI. Dalmas wants the design moved into real code as **v3**: a new shell under
`/v3/*` built on the latest shadcn, which eventually replaces v2 completely.

Success means Dalmas only ever sees v3. Every daily-use screen looks like the design and
behaves like v2 or better, and nothing relied on in v2 is missing.

## Scope of this document

The approved programme has three stages. This document covers stages 1 and 2. Stage 3
features each get their own short design before work starts.

1. **Foundation.** Branch, tokens, shadcn components, design snapshot, v3 shell, routing,
   realtime wiring.
2. **Screen port.** Every screen v2 already has, rebuilt in v3. This also covers the file
   viewer rewrite, typed reference tags, the six #TSK886 gaps, and the reviewer's chat-focus
   and UX smoothness tasks.
3. *(Separate designs, not covered here.)* New features with backend, one at a time:
   decisions → event subscriptions → leases → approvals → evidence → daily update →
   usage/cost → database browser → licence. The reviewer builds the decisions backend in
   parallel with stage 2.

## Goals

- v3 lives at `/v3/*` with its **own shell**: sidebar, header, rail and command palette from
  the design's `tf-shell`. It covers everything from the landing page onwards: public pages,
  auth, onboarding and the app.
- **Dalmas sees only v3.** `/` goes to the v3 landing page. Login, signup, logout and every
  in-app link land in `/v3`. v2 routes stay in the code, unlinked, until the migration is
  done, then get deleted.
- Each design page's HTML is **downloaded once** into the repo as the visual reference, then
  rebuilt as React with **shadcn components everywhere**, at the latest shadcn version.
- **Same data underneath.** v3 reuses v2's API client, auth, mappers and realtime. Only the
  UI is new.

## Non-goals

- No new backend features in stage 2, apart from the small pieces the #TSK886 gaps need
  (listed below).
- No change to the design project itself. Where the design is missing something v2 has, v3
  keeps it, styled to match.
- No pixel-perfect copy of the design's hand-written HTML. The design shows *what and
  where*; shadcn components decide *how*.

## Anti-goals (a failure even if it "works")

- A second realtime EventSource. Today only `App.tsx` opens one, and a second one stalls
  realtime across the whole app.
- Any v3 page losing a v2 capability: drag and drop on the board, chat attachments, mentions,
  structured questions, prompt answering, file preview, task chips, design surface, and so on.
- Hand-rolled controls where a shadcn component exists, or raw palette colours (`bg-blue-500`)
  instead of tokens.
- Dalmas landing on a v2 screen through any link.
- `App.tsx` crossing the 200 KB HMR full-reload line (see the warning at its top).

## Constraints and hard rules

### Frontend
- **One realtime stream.** v3 consumes the stream `App.tsx` already opens, through a context
  or bus. It never calls `openTaskflowRealtimeStream` itself.
- **Fetches carry the bearer.** Use `withBearer()`. Cookie-only fetches 401 after the 14-day
  session expires.
- **Base UI, not Radix.** The shadcn style is `base-nova`. Select needs an `items`
  value→label map on its root or it shows the raw value.
- **Size limit.** `App.tsx` is about 2/3 of the way to the reload threshold. v3 code goes in
  `v2_fe/src/v3/`. `App.tsx` gets only a thin hand-off.
- **Builds are deploys.** Dalmas views the built app, so run `npm run build` after a
  meaningful change or it looks like the code reverted. Any branch build will show v3 once
  `/` redirects there.
- Per-surface loading stays as v2 does it: heavy lists are deferred slices gated by
  `…Needed` flags. v3 pages set the same flags instead of adding their own loaders.

### Backend (every branch that touches `backend/`; reviewer-enforced)
1. **Auto-REST is deny by default.** Every new model is either on `include_only` with
   permissions checked, or excluded.
2. **Migrations don't run on boot.** Commit the migration and run `cargo run -- migrate`.
   Never regenerate an applied migration under the same name.
3. **Side effects listen on both save paths:** `post_save` (Manager::save) and
   `bulk_post_save` (REST PATCH, ids only).
4. **Run tests with `cargo test --workspace`.** Plain `cargo test` skips the plugin crates.
5. **Never patch `vendor/umbral-*`.** Work around gaps in our code and log each one in
   `umbra/planning/gaps6.md`.

### Process
- Base branch `ui_upgrade` is cut from `main`, then `security/rest-deny-by-default`
  (`cc42532`, #TSK1090) is merged into it, so every v3 model lands on deny-by-default REST.
  That fix reaches `main` separately, on Dalmas's say. Each slice is its own branch or worktree off
  `ui_upgrade`, reviewed by the other agent, and merged back into `ui_upgrade`.
- **One open backend branch per plugin at a time.** Before merging, rebase onto
  `ui_upgrade`. If the migration needs remaking, regenerate it under a new name, or drop
  the unmerged one and re-make it. Never re-make a migration under the same name in place:
  a dev database that already applied it would silently never run the new version.
- **One shared `CARGO_TARGET_DIR`** across worktrees, because each `backend/target` is a
  full Rust build and the disk hit 0 MB on 2026-11-05. Prune any per-worktree `target/`
  when its slice merges.
- **Who does what:** the reviewer owns backend (decisions, then the four #TSK886 backend
  pieces). Claude owns the foundation and most of the UI port. The claim-a-message MCP
  changes ship in the same MCP release as the decisions tools, with one version bump.
- Commit with explicit paths (`git commit -- <paths>`), because worktrees share the index.
- No subagents. Each agent does its own work (Dalmas's rule).
- Every slice is a TaskFlow task. Move it to `in_progress` on start and to `done` when it is
  verified and reviewed.

## Architecture (decided)

### How v3 gets the data
`App.tsx` already owns all workspace state: the active project, tasks, chat, presence,
reviews, the realtime stream and the task sheet. Extracting that into a provider now would
mean rewriting the biggest file in the repo before any UI exists.

Instead, `App.tsx` builds a **`WorkspaceContext` value** from the state and handlers it
already has, and renders an early branch:

```
if (pathname starts with "/v3") return <WorkspaceContext.Provider value={ws}><V3App/></…>
```

This branch sits *after* the hooks that open the realtime stream and *before* v2's chrome.
v3 never renders v2's `SidebarProvider` or header.

- `V3App` (in `src/v3/`) owns v3 routing, the v3 shell and all v3 pages. Pages read through
  hooks such as `useWorkspace()`, `useTasks()` and `useChat()` in `src/v3/hooks/`.
- The context value is assembled with `useMemo` in one place. If it grows past about 60
  lines, move the assembly into `src/v3/workspace-value.ts` as a helper that takes App's state.
- Once v2 is deleted, the state moves out of `App.tsx` into a real provider. That is a later
  cleanup, not stage 1.
- The public and auth early returns (`LandingPage` and `AuthPage` around App.tsx:1541) get a
  v3 path too, so `/v3`, `/v3/login` and the rest render v3 public pages.

### Routing
- **The switch is one flag, `V3_DEFAULT`** (reviewer, #MSG5649). While it's off, v3 is
  reachable at `/v3` and v2 stays home, so a half-finished port never locks Dalmas out.
  Turn it on once board, task and chat are ported. With the flag on:
- `/` → `/v3`. Logout goes to `/v3/login`. A successful login goes to `/v3/board`, or the
  `?next=` target.
- **Builder's call:** the post-login landing is `/v3/home` if the home page is built in
  stage 2 (it shows approvals and agent status), otherwise `/v3/board`. Default to board.
- v2 paths (`/dashboard/*`, `/account/*`, `/login`) keep working when typed. No v3 page links
  to them.
- The active project stays in app state as in v2 (not in the URL), so v2 and v3 agree on the
  current project.
- Route map from design routes to v3 routes, with flat design names nested properly. Stage 3
  pages are not linked from the shell until they're built.

| Design route(s) | v3 route | Stage |
|---|---|---|
| `/` (index) | `/v3` | 2 |
| `/login`, `/signup`, `/forgot-password` (+ `--error`, `--sent`) | `/v3/login`, `/v3/signup`, `/v3/forgot-password` | 2 |
| `/server-picker`, `/server-accounts` | `/v3/server`, `/v3/server/accounts` | 2 |
| `/pricing`, `/docs`, `/docs-article` | `/v3/pricing`, `/v3/docs`, `/v3/docs/:slug` | 3 (content) |
| `/onboarding*` | `/v3/onboarding/{welcome,team,agents,connect,handshake}` | 2 |
| `/overview`, `/home`, `/shell-rail` | `/v3/overview`, `/v3/home` | 2 |
| `/board`, `/board-list`, `/board-filters` (+ states) | `/v3/board` (board/list toggle, filter sheet) | 2 |
| `/task`, `/task-new` | `/v3/tasks/:id`, new-task dialog | 2 |
| `/chat`, `/chat-thread`, `/chat-inbox`, `/inbox` | `/v3/chat/:channel`, thread dialog, `/v3/inbox` | 2 |
| `/agents`, `/agent-*` | `/v3/agents`, `/v3/agents/:id`, `/v3/agents/:id/terminal`, `/v3/agents/new` | 2 |
| `/reviews`, `/activity`, `/toolbox`, `/media`, `/invites`, `/api-keys`, `/sessions` | `/v3/<same>` | 2 |
| `/design*` | `/v3/design` (tabs for pages/comments/tokens/components) | 2 |
| `/project-*` | `/v3/project/{settings,workflow,repos,github,endpoints,instructions}`, new-project dialog | 2 (workflow columns: 3) |
| `/org*` | `/v3/org/{,members,agents,audit,settings}` | 2 if v2 has it, else 3 |
| `/account-*` | `/v3/account/{profile,settings,security,connections,invitations}` | 2 |
| `/command-palette` | ⌘K overlay (shadcn Command) | 2 |
| `/decisions`, `/subscriptions`, `/daily-update`, `/usage`, `/database*`, `/org-licence` | `/v3/<same>` | 3 |
| `/not-found`, `/offline`, `/error`, `*--empty`, `*--loading` | shared states used by every page | 2 |

**Stage 2 rule:** a page is in stage 2 when v2 already has the data behind it. A part of a
stage-2 page that shows a stage-3 concept (a lease badge, "blocked on decision") renders
only when the data exists, and is hidden otherwise. No fake data in v3.

### Design snapshot
- A one-off script, `scripts/snapshot-design.mjs`, pulls every page, component, token and
  resource through the design API into `docs/v3-design/` (`pages/*.html`,
  `components/*.js`, `tokens.json`, `tokens.css`). The output is committed.
- This is reference only and never shipped. Pages are rebuilt from it. When the design
  changes later, re-run the script and commit the diff, so the change shows up in review.

### Tokens and shadcn
- Merge the design's `tokens_css` into `v2_fe/src/index.css`: `:root`, `.dark`,
  `@theme inline`, including the status colours `running/blocked/done/failed/review/idle`,
  `terminal`, `link` and the sidebar set. Geist and Geist Mono stay. Radius base stays
  `0.625rem`. "Larger radius" in rewritten surfaces uses `rounded-2xl` and above, from the
  same scale.
- Check the current `shadcn` CLI release at build time and update the dev dependency.
  `components.json` stays `base-nova`.
- Add, at least: card, badge, table, command, popover, hover-card, scroll-area, toggle,
  toggle-group, switch, radio-group, label, field, alert, alert-dialog, progress, sonner,
  context-menu, resizable, kbd, empty, spinner, input-group, item, button-group, chart.
  Re-add the existing primitives only if the CLI shows upstream changes worth taking, and
  review each diff.
- `tf-*` design components map to shared v3 components in `src/v3/components/`:
  `tf-shell`→`V3Shell`, `tf-task-card`→`TaskCard`, `tf-message`→`Message`,
  `tf-composer`→`Composer` (wrapping v2's composer logic), `tf-avatar`→`ActorAvatar`,
  `tf-status`→`StatusBadge`, `tf-terminal`→`Terminal` (reusing v2's terminal),
  `tf-bar-chart`→shadcn Chart, and so on. Icons use lucide directly, not `tf-icon`.

### Typed reference tags (new)
The grammar lives in one module, replacing `src/lib/task-refs.ts`, and applies everywhere
markdown renders, in v2 and v3 alike:

| Tag | Meaning | Click |
|---|---|---|
| `#TSK123` | task | open the task |
| `#MSG3456` | chat message | if loaded in the visible chat, scroll to it and highlight it; otherwise fetch it and open the thread dialog on it |
| `#GHI12`, `#GHI12@owner/name` | GitHub issue | open on GitHub; without `@repo`, use the project's default repo |
| `#GHP44`, `#GHP44@owner/name` | GitHub pull request | same as issues |

- Case-insensitive on input, rendered as written. The chip's tooltip names the target, and
  for GitHub tags, the repo it resolved to.
- **A bare `#123` is plain text.** It no longer triggers a task fetch (Dalmas: "Tasks
  currently takes everything up, so expensive").
- The old prefixed forms (`TASK#12`, `#gh12`, `owner/repo#gh12`, `#msg12`) keep resolving,
  because they are unambiguous and old messages use them. New text uses the new forms.
- Matching runs over parsed markdown text nodes only. Inline code, code blocks, link URLs
  and URL fragments are never parsed.
- A `#MSG` the viewer can't read (another project, or a DM they aren't on) shows a "can't
  open this message" notice, not an error.
- **Builder to check:** whether a fetch-one-message endpoint exists. If not, add it under
  the backend rules: read-only, scoped to the caller's projects and channel membership.
- Update `mcp/src/instructions.ts` (the reference section around line 142) to teach the new
  tags. Publish the MCP per the usual flow, which needs a separate version-bump decision
  with Dalmas.

### #TSK886 gaps (approved in #MSG5631)
My #MSG5630 called three of these "missing". That was against the design. Checking the
code: **edit message (#107) and message→task already exist in v2**, so they are ports.

| Gap | v2 today | Stage 2 work |
|---|---|---|
| Edit or supersede own message | exists (`use-agent-chat.ts` edit, `edited_at`) | port to v3 `Message` actions, with an "edited" label |
| Message → task | exists (`lib/message-to-task.ts`) | port as a message action ("Make a task") |
| Claim a message ("answering…") | missing | small backend piece: a claim on a message, cleared when the claimer replies or after a timeout. Realtime event, MCP surface, v3 marker |
| Channel "current state" pin | missing (single-message pin only) | backend: one pinned state per channel. v3 header panel, MCP read/write |
| Toolbox facts show their age | partial ("updated 2h ago") | backend: `checked_at` per entry, set on save or re-check. v3 shows "stale" past a threshold (builder's call: 14 days). Rules vs status as an entry kind |
| Review request with context | partial | backend: a request record (who, diff link, focus), answered by `report_review`. v3 "Request review" on the task page |

The four backend pieces follow the backend rules. Each is its own small slice, specified in
the plan.

### Kept components, rewritten
The file viewer dialog (`message-attachments.tsx` preview, plus the media page) is rebuilt
in v3 with shadcn Dialog: larger radius (`rounded-2xl`), a bigger viewport, polished header
and controls. Everything v2's viewer does today is kept (the builder lists it before
rewriting). PDFs still go through a blob URL, never raw `/media` in an iframe, because
`/media` is served with X-Frame-Options DENY. The
same treatment applies to the task sheet → task page, the board dialog, and the composer.

### Reviewer's assigned tasks (from #MSG5643)
- Tapping a chat focuses its input, as in social apps. In v3 from the start, ported to v2
  only if trivial.
- UX smoothness tweaks: transitions, optimistic updates, skeletons instead of layout jumps.
  The reviewer opens these tasks and scopes them. v3 builds them in as a baseline.

## Testing and verification
- Vitest for logic: the tag grammar (including code-span exclusion, and one test per
  legacy form: `TASK#12`, `#gh12`, `owner/repo#gh12`, `#msg12`/`#MSG12`), route
  redirects, context value mapping. Follow v2's `*.test.ts` style.
- `npx tsc -b` and `npm run build` must pass on every slice.
- Before merging into `ui_upgrade`, the author compares each ported page in the browser with
  its design page (`design_compare` or a screenshot) in light and dark themes, at desktop and
  phone widths.
- Realtime check per slice: a task moved by an agent shows up live in v3 without reloading,
  and there is only one EventSource in the network panel.
- Backend slices: `cargo test --workspace`, migration applied locally, REST exposure checked.

## Left to the builder
- Slice boundaries and their order within stage 2. Suggested: foundation → shell and public
  pages → board and task → chat (tags, gaps) → agents and terminal → remaining pages →
  settings.
- Which v2 component internals to reuse as-is behind a new skin and which to rewrite.
- Empty, loading and error components shared across pages.
- Exact stale threshold and claim timeout, inside the bounds above.

## Open (decide later, not blocking)
- When `ui_upgrade` merges to `main` and ships to prod. **My call:** not before stage 2 is
  complete and Dalmas says so. Until then, prod stays v2.
