# Design page Phase 4 — three canvas views, persisted state, spacing + dark-mode fixes

**Date:** 2026-09-25
**Status:** Approved for implementation planning
**Depends on:** Phases 1–3 (merged to main). Continues the design-page rework; does not revisit its decisions.

## Problem

The canvas has exactly one arrangement — one **row per page**, one column per selected device (`layoutRows`) — and it has three defects:

1. **No arrangement choice.** Listing pages across a device, or grouping related pages ("auth") into a track, is impossible. Every page and device mixes into one grid.
2. **Nothing persists.** Open pages, selected devices, zoom/pan, tool and panel tab are `useState`, so a reload rebuilds the default layout. Grouping (once it exists) must not be per-person anyway: it describes the project's pages, not one viewer's window.
3. **Headers collide.** `ArtboardHeader` is a flex row that can be **wider than a narrow device board**, so it overflows past the 80px gutter into the neighbouring column's device. The user's words: "the device top title and actions don't lie in the other device".

Plus a visual defect: in dark mode a light fringe shows around device frames.

## Goals (four workstreams)

1. **Two new canvas views** — `bands` (one band per device, its pages across, stacked per device) and `groups` (named page groups as vertical columns, ungrouped pages flowing right) — alongside today's `rows`, switchable from the toolbar.
2. **Persisted state, split by audience** — the *arrangement* (view + groups) is a shared project artifact on the server; the *viewport* (open pages, devices, zoom/pan, tool, tab) is per-user in Dexie.
3. **Spacing + header layout** — the header must be structurally unable to spill into a neighbour, and the gutters must give it room.
4. **Dark-mode frame backdrop** — the three hardcoded light surfaces behind/around frames become dark neutrals.

## Non-goals

No changes to the tokens pipeline, the chat rail, the sandbox composer, the inspector/Pick flow, or the manifest. No page *content* editing. No drag-and-drop repositioning of individual artboards (all three views remain **derived** layouts). No change to `MIN_SCALE`/`MAX_SCALE`/zoom-as-wrapper-transform — the "iframe stays at true device px" invariant is a HARD CONSTRAINT carried over from Phase 3.

## Key decisions (from brainstorming)

1. **The state split is by audience, not by convenience.** Server owns "how this project's pages are arranged" (shared — if one person groups the pages, everyone sees the grouping). Dexie owns "what I'm looking at right now" (per-user, per-browser). Explicit user ruling.
2. **Group assignment lives in the Pages panel** — a per-row group picker, not canvas drag-and-drop, not a separate dialog.
3. **`rows` is kept, not replaced.** The two new views are additive; the user called `bands` "the first second view to what we have now".
4. **Layout writes are last-write-wins.** It is a settings document, not versioned content — no optimistic-version 409 here (unlike `DesignFile`, which is content).

## Current-state anchors (verified against the working tree)

- **Layout math** — `v2_fe/src/lib/design-devices.ts:169` `layoutRows(openRoutes, deviceIds, gutter = 80)`: one row per route (`y` stacks by max device height + gutter), one column per device (`x` accumulates `device.width + gutter`). `Artboard = {key: "route@device", route, deviceId, x, y}` (`:141`).
- **Column widths ignore chrome.** `layoutRows` uses `device.width`, but `DeviceChrome` adds per-group bezel padding (`chromeStyleForGroup`, `:84` — phone 12+12, tablet 14+14, laptop/breakpoint 0) plus a 1px border each side. Phone columns are ~26px narrower than what actually renders.
- **Artboards are derived, never stored** — `DesignSurfacePage.tsx:119` `useMemo(() => layoutRows(openRoutes, deviceIds), [openRoutes, deviceIds])`. This is the seam that makes adding views cheap: `DesignCanvas`, selection, pins and `focusBoard` are all keyed on `route@device` and need no change.
- **Canvas UI state** — `DesignSurfacePage.tsx`: `transform` `:101`, `deviceIds` `:102`, `canvasTool` `:104`, `theme` `:105`, `openRoutes` `:114`, `rightTab` `:177`. Seeding effect at `:147-168` opens every manifest route once per project (`seededProjectRef`).
- **Header** — `design-canvas.tsx:325` `ArtboardHeader`, rendered per board at `:303`. It is a flex row of label + `·` + device label + dims + **8 icon buttons**. Five of those buttons are **dead placeholders with no `onClick`**: rotate `:360`, duplicate `:363`, open-in-new-tab `:382`, reload `:385`, remove `:388`. Only Copy HTML `:366` and Download `:374` work. The `EllipsisIcon` `:391` is already present as a non-interactive stub.
- **Light surfaces** — screen cut-out `design-canvas.tsx:446` (`overflow-hidden bg-white`), frame host `:518` (`relative bg-zinc-100`), lazy placeholder `:567` (`from-zinc-200 to-zinc-300`).
- **Not a defect** — the dot grid `:217-225` is a *sibling* of the transformed world layer, so it already stays at constant screen size while content scales. Do not "fix" it.
- **Backend plugin** — `backend/plugins/taskflow-design/`: models in `models.rs` registered via `lib.rs` `models()`; routes in `urls.rs`; chrome handlers in `views.rs` gated by `ensure_member` (`:48`, membership or superuser, fails closed). Migration `backend/migrations/taskflow_design/0001_auto.json` (generated by `cargo run -- makemigrations`).
- **JSON-document precedent** — `styles/tokens.json` is stored as a validated document and converted on read (`tokens.rs`: `TokensDoc`, `tokens_json_to_css`). A layout document follows this shape rather than adding normalized tables.
- **Realtime** — `backend/src/realtime.rs:67-68` consts (`DESIGN_FILES`, `DESIGN_COMMENTS`); `views.rs:542-543` builds the per-project groups for the SSE route; the FE mirrors the suffixes via `v2_fe/src/lib/taskflow-api.ts`. **The suffix strings are a cross-language contract with no drift guard** (a known logged gap) — a missed FE suffix fails silently.

## Architecture

### §A — Shared layout document (backend)

New model `DesignLayout` in `plugins/taskflow-design/src/models.rs`, registered in `lib.rs` `models()`:

- `id`, `project: ForeignKey<TaskflowProject>` (**unique** — one row per project), `view` (Choices: `rows` | `bands` | `groups`, default `rows`), `layout_json` (Text), `updated_by` (120), `created_at`, `updated_at`.

`layout_json` carries the order and grouping, which is *the document* — normalizing group membership into rows would buy nothing and cost an ordering column:

```json
{ "view": "groups",
  "routeOrder": ["/", "/settings", "/login"],
  "groups": [{ "id": "g1", "name": "Auth", "routes": ["/login", "/signup"] }] }
```

**Routes** (in `urls.rs`, handlers in `views.rs` behind `ensure_member`):

- `GET /api/design/{project}/layout` → the stored document, or the **default document with 200** when no row exists. One code path on the client; never a 404 to special-case.
- `PUT /api/design/{project}/layout` → validate, upsert, return the stored document.

**Validation** — a sibling to the existing write validator, same thesis ("inconsistency is a rejected write"). Reject: unknown `view`; more than 24 groups; a name empty, >40 chars, or duplicated case-insensitively; a route in more than one group; **a route not present in the project's manifest**. The last one matters most — a ghost route would render an empty board forever.

**Read-side self-healing:** a route can legitimately vanish when its page file is deleted. Validation rejects unknown routes on *write*, but on *read* stored routes are **filtered against the live manifest** and the survivors returned. Rejecting on read would wedge the client against a document it cannot fix.

### §B — Per-user viewport state (Dexie)

`v2_fe/src/lib/design-ui-state.ts`: a Dexie database (`taskflow_design_ui`) with one table `canvas`, keyed `[userId, projectId]` so two accounts sharing a browser never inherit each other's canvas:

```ts
{ userId, projectId,              // compound primary key [userId+projectId]
  openRoutes: string[], deviceIds: string[],
  transform: {x,y,scale}, canvasTool, rightTab, theme, updatedAt }
```

Read **once on hydration**, not via `useLiveQuery`: the surface already holds this state in React, so a live query would be a second source of truth — and because we write back with a debounce, it would feed our own writes to ourselves. `dexie-react-hooks` is still installed and available for a future store that genuinely needs reactivity. Writes are debounced (~400ms) so panning does not hammer IndexedDB.

**The seeding race (subtle, must be handled):** today `openRoutes` is seeded from the manifest once per project (`DesignSurfacePage.tsx:159`). With persistence the **stored** value must beat the manifest seed — otherwise reopening the page re-opens every route the user closed. Order: read Dexie → if a record exists, use it → else seed from the manifest and write it. A `hydrated` gate prevents the canvas painting the seeded layout and then jumping.

### §C — Three layout engines (pure, one module)

`layoutRows` stays (fixed for §D); `layoutBands` and `layoutGroups` join it. All three return `Artboard[]` keyed `route@device`, so nothing downstream changes.

- **`rows`** (today) — one row per route, one column per device.
- **`bands`** — transpose: one band per device in `deviceIds` order; that device's pages run left→right across the band; the next device's band starts below. Band height = the tallest board in it.
- **`groups`** — still banded per device. Within a device's band, each **group is a vertical column** (its pages stacked top to bottom in the order `group.routes` lists them); pages in no group **flow to the right** of the group columns. Groups render in document order.
  - **Ungrouped flow, made explicit:** ungrouped pages occupy a **single row to the right of the group columns, top-aligned, with no wrapping** — the band grows wider rather than deeper. (Balanced multi-row packing of the ungrouped tail is a deliberate follow-up, not this phase: it is the one place where a packing policy is a real design choice, and picking one blind — before seeing real page counts — is how you get a layout that has to be redone.)

**What actually fixes page order (corrected during implementation).** All three engines read the **order of the `openRoutes` array** they are handed, not `routeOrder`. That ordering is already canonical: `DesignSurfacePage.openRoute` re-sorts on every open and the manifest seed builds from `manifest.routes.map(r => r.path)`, so `openRoutes` is always in manifest order and a page's position is stable when switching views.

`routeOrder` is therefore **carried but not yet consumed** — nothing in the frontend reads it, and it stays in the document as the reserved slot for the deferred reorder work (see the plan's Deferred section). It remains part of the wire shape and so must stay in the mirrored `LayoutDoc` type; it is not a claim that any engine uses it. A future reorder feature is what would give it meaning, and that work must then decide whether it supersedes the manifest-order rule above.

### §D — Header containment + spacing

The header must be **structurally unable** to spill, not merely unlikely to:

1. Clamp the header to its board's width (`truncate` on the label) and move the five dead placeholder buttons into the existing ⋯ dropdown, leaving **Copy HTML + Download inline**. Nothing functional is lost — those five have no handlers — and the header shrinks by ~130px.
2. **Gutter 80 → 140** for breathing room.
3. Column widths must count the chrome: `boardWidth(device) = device.width + padding.left + padding.right + 2`. Today's math is ~26px optimistic on phones.

### §E — Dark-mode frame backdrop

Replace the three light hardcodes with dark neutrals: screen cut-out `:446` → `bg-zinc-950`; frame host `:518` → `bg-zinc-900`; lazy placeholder `:567` → a zinc-900/800 gradient with the icon muted. All three sit *behind* the iframe, which paints its own token background once loaded, so a dark backdrop is both more honest and eliminates the fringe at fractional zoom.

**Realtime (flagged, cuttable):** for a genuinely shared layout a second viewer should see a regrouping without reloading. That means a `DESIGN_LAYOUT` suffix in `realtime.rs`, an `Expose` for the model, the group added to `design_events` (`views.rs:542`), and the matching FE suffix. Four small edits — but it extends the unguarded cross-language suffix contract. **If this phase should stay small, cut this item; the layout then refreshes on page load only.**

## Data flow / edge cases

- A layout document references routes; the manifest owns which routes exist. The two can drift (page file deleted while it sat in a group) — resolved by read-side filtering (§A), never by a stuck client.
- Switching views is pure re-layout: no server write is required *unless* the view itself changed, which is a `view` field write.
- `groups` view with zero groups ≡ `bands` — acceptable, no special case.
- A group whose routes have all been deleted renders empty; the group itself survives until the user removes it.
- `DevicePicker` still refuses to empty, so no band can have zero columns.
- Two tabs of the same project both open: Dexie is shared per origin, so tab B adopts tab A's viewport on its next read. Last write wins; acceptable for viewport state.

## Testing

- **Frontend** `npm test` (= `vitest run`), `npm run build` (= `tsc -b && vite build`, so the typecheck comes free — the build *is* the deploy, so run it last). Unit tests for `layoutBands` and `layoutGroups` (pure in/out, matching `design-devices.test.ts`), plus `boardWidth` chrome accounting. **Repo has no RTL/jsdom**, so canvas behaviour is unit-covered and code-traced, not runtime-tested — verified visually instead (§Verification).
- **Backend** `cargo test --workspace` (**bare `cargo test` silently skips plugin crates**). New tests in `plugins/taskflow-design/tests/`: layout document validation (each rejection rule), GET-default-when-absent, read-side filtering of vanished routes, and the membership gate.
- **Migration** generated via `cargo run -- makemigrations` → a **new** `0002_*.json`. Never regenerate `0001`: an already-applied migration re-emitted under the same name silently never runs.
- **Visual verification** — run the stack locally against a **copy** of `backend/backend.db` (never the live DB) and confirm: the dark-mode fringe is gone at 100% and fractional zoom; each view lays out as specified; the header no longer overlaps a neighbouring device at the narrowest preset (`galaxy-s24`).

## Open item — the reported zoom pixelation is NOT resolved

The user reports that zooming makes canvas content "look like zoomed, in other words pixelated". **This spec does not claim to fix it, because no root cause was found.** Three hypotheses were built as minimal cross-origin (out-of-process) iframe repros under `transform: scale(2)` and screenshotted at one variable each — all three rendered **crisp**, so all three are rejected:

| Hypothesis | Result |
|---|---|
| `will-change: transform` promotes the layer, upscaling a cached texture | crisp — rejected |
| Rounded + `overflow:hidden` screen cut-out adds a mask/clip layer | crisp — rejected |
| Frame size (220×160 too small vs a realistic 1280×800) | crisp — rejected |

The deployed bundle was checked and **contains the current canvas code**, so this is not a stale build. Leading remaining suspect (untested, app-specific): `LazyFrame` unmounts frames outside a viewport-relative margin (`design-canvas.tsx:484`, `rootMargin: "150%"`) and swaps them for the light placeholder at `:567` — zooming changes what counts as "near", so a fast zoom can reveal placeholder blocks. **Discriminating evidence needed from the user:** a screenshot of the zoomed canvas, which device preset, the zoom readout, and whether it **settles crisp** (→ remounting) or **stays** pixelated (→ rasterization). Do not spec a fix before that.

## Affected files (reference)

**Backend:** `plugins/taskflow-design/src/models.rs` (+`DesignLayout`), `src/lib.rs` (register model), `src/urls.rs` (+2 routes), `src/views.rs` (+handlers, +`ensure_member` use), `src/validation.rs` (layout document rules), `migrations/taskflow_design/0002_*.json` (generated), `tests/` (+layout tests), `src/realtime.rs` + `plugins/taskflow-design/src/views.rs` + `v2_fe/src/lib/taskflow-api.ts` (realtime suffix, if not cut).

**Frontend:** `v2_fe/package.json` (+`dexie` ^4.3.0, +`dexie-react-hooks` ^4.2.0 — both verified to resolve on npm), `src/pages/design/design-ui-state.ts` (new: Dexie store — in `pages/design/`, not `lib/`, so it can take `MIN_SCALE`/`MAX_SCALE` from `design-canvas` the way `canvas-view.ts` already does, rather than inverting the `lib/` → `pages/` layering), `src/lib/design-layout.ts` (new: document types + edits), `src/lib/design-api.ts` (`fetchLayout`/`saveLayout` added to the existing design client, reusing its private `designFetch`/`jsonInit`), `src/lib/design-devices.ts` (`layoutBands`, `layoutGroups`, `boardsForView`, `boardWidth`, gutter 140), `src/pages/design/pages-panel.tsx` (new: extracted Pages panel + group picker), `src/pages/design/design-view.ts` (new: pure hydration decision), `src/pages/design/DesignSurfacePage.tsx` (view picker, hydration gate), `src/pages/design/design-canvas.tsx` (header containment, dark backdrops), tests alongside the pure helpers.
