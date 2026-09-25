# Design Page Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-page display labels, make the five per-device actions real, keep seen frames loaded, and let a project's members manage toggleable external resource sets (web fonts and their companion links) from the UI.

**Architecture:** Two of the four items ride machinery that already exists rather than adding new paths. Page labels and rotated boards both become *data* — labels as a field on the arrangement document already served by `GET`/`PUT /layout`, rotation as extra entries in the device preset table that `deviceById` already resolves. Only the resource sets need a new document, and that document is a `DesignFile` row, so it inherits versioning, validation, the operator and agent write endpoints, and the manifest with no new plumbing. The one genuinely load-bearing change is the sandbox CSP, which is origin-allowlisted today and therefore blocks Google Fonts.

**Tech Stack:** Rust (Umbral plugin framework, serde, axum), React 19 + TypeScript + Vite, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-design-phase5-resources-and-ergonomics-design.md`

## Global Constraints

- **The iframe is ALWAYS the preset's true `width×height`; zoom stays `transform: scale()` on the wrapper.** Rotation therefore does not "fake" a landscape board — it renders at genuinely swapped pixels, which is the honest outcome and the reason a rotated board is visible as such.
- **Strict on write, forgiving on read** — the asymmetry established in `layout_doc.rs` applies to every document this plan touches. Unknown routes are refused by `PUT` and filtered by `GET`.
- **Reuse before invention.** Resource sets are a `DesignFile` row at `styles/resources.json`; `for_path` already maps `styles/` to `DesignFileKind::Token`. **No new model, no new migration, no new endpoints.**
- **But "no new plumbing" was WRONG** (found in Task 6, verified): `validation.rs:176`'s `check_extension` admits **only** `styles/tokens.json` and `styles/tokens.css` for the Token kind, so **every write to `styles/resources.json` is refused** with rule `extension` before `resources::validate` is ever reached. The document could be parsed and validated in a unit test and still be unsaveable. Task 6 extends `validation.rs`: allow the path in `check_extension` (with its `expected` message updated) and dispatch that path to `resources::validate` in `validate_write`. Cost of the miss: without it, the feature is unreachable from the UI while every test passes — the same silent-no-op shape as the Phase 4 `projectScopedRealtimeTables` omission.
- **Never regenerate `backend/migrations/taskflow_design/0001_auto.json` or `0002_create_design_layout.json`.** No migration is expected in this plan; if one appears, a new file with a new name is the only acceptable outcome.
- Resource link schemes: **`https:` only**; `javascript:` and `data:` refused for both link and script shapes. Allowed `rel`: `preconnect`, `dns-prefetch`, `stylesheet`. (**`preload` was removed in Task 7's fix round** — without an `as` attribute it is inert, so it produced a link that fetched nothing; see the spec's correction. Re-adding it means adding `as` to the model.)
- Backend tests: `cargo test --workspace` (**a bare `cargo test` in `backend/` silently skips every plugin crate**). Frontend tasks: `npx tsc -b && npm test` — **and NOT `npm run build`**, because the build is what publishes the app (Phase 4's own note: *"Run the build LAST — it is what publishes the app"*). It runs exactly once, in Task 9's held publish, on the user's go-ahead.
- This repo has **no RTL/jsdom** — pure unit tests only, plus visual verification.
- **Publish order: the backend must deploy before the frontend.** Measured, not assumed: the deployed backend answers `403` to a realtime group it does not know and the realtime layer refuses the *entire* handshake. Phase 4's held build is still held. So **no task in this plan runs `npm run build`**: a frontend build produced before the user's backend deploy is precisely the hazard this line describes, and Task 9 owns the plan's single one, on the user's go-ahead.
- **Stage explicit paths when committing. Never `git add -A`** — the tree carries an unrelated modified `backend/README.md`, and `v2_fe/yarn.lock` is tracked but CI-unused and gets dirtied by npm.
- **Do not edit `docs/superpowers/plans/…` or a task brief** — those are the controller's. Report defects instead.

## Review Focus

Input classes and failure modes the spec implies but no task's tests would otherwise catch. Each is pinned to the task that owns the code, in that task's steps.

1. **A resource document with a scheme that must never load** — `javascript:alert(1)` and `data:text/html,…` as either `href` or `src`, in mixed case (`JaVaScRiPt:`), and with leading whitespace → refused by validation, and never present in emitted markup. (Tasks 6, 7)
2. **A set that is disabled, or a document that is absent entirely** — no tags emitted, no error, page composes normally. (Task 7)
3. **A label for a page that no longer exists**, and a label that is only whitespace → the label is dropped on read, and refused on write. (Tasks 1, 2)
4. **A landscape variant of a device the user never selected** — it must not leak into the arrangement, and `design-ui-state`'s device filter must not silently drop a landscape id it does not know. (Task 5)
5. **A frame that has been seen and then scrolled far away, across a zoom change** — it stays mounted, and its iframe is not remounted by the content epoch. (Task 3)

---

### Task 1: Backend — page labels in the arrangement document

**Files:**
- Modify: `backend/plugins/taskflow-design/src/layout_doc.rs`
- Modify: `backend/plugins/taskflow-design/tests/layout_doc.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `LayoutDoc.page_labels: std::collections::HashMap<String, String>` (wire field `pageLabels`), plus `pub const MAX_LABEL: usize = 40`.

- [ ] **Step 1: Write the failing tests** — append to `tests/layout_doc.rs`

```rust
#[test]
fn page_labels_round_trip_as_camel_case() {
    let mut d = doc(DesignView::Rows, vec![]);
    d.page_labels.insert("/login".into(), "Sign in".into());
    let json = to_json_string(&d);
    assert!(json.contains("\"pageLabels\""), "{json}");
    assert_eq!(parse(&json).unwrap(), d);
}

#[test]
fn a_document_without_page_labels_still_parses() {
    // Every document written before this field existed must keep working.
    let d = parse(r#"{"view":"rows","routeOrder":[],"groups":[]}"#).unwrap();
    assert!(d.page_labels.is_empty());
}

#[test]
fn validate_trims_labels_and_refuses_bad_ones() {
    let mut ok = doc(DesignView::Rows, vec![]);
    ok.page_labels.insert("/login".into(), "  Sign in  ".into());
    let out = validate(ok, &known()).unwrap();
    assert_eq!(out.page_labels["/login"], "Sign in");

    // empty after trimming
    let mut blank = doc(DesignView::Rows, vec![]);
    blank.page_labels.insert("/login".into(), "   ".into());
    assert!(validate(blank, &known()).is_err());

    // over the cap
    let mut long = doc(DesignView::Rows, vec![]);
    long.page_labels.insert("/login".into(), "x".repeat(41));
    assert!(validate(long, &known()).is_err());

    // a route that is not a page — same rule as group routes
    let mut ghost = doc(DesignView::Rows, vec![]);
    ghost.page_labels.insert("/nope".into(), "Gone".into());
    assert!(validate(ghost, &known()).is_err());
}

#[test]
fn filter_drops_labels_for_vanished_routes() {
    let mut d = doc(DesignView::Rows, vec![]);
    d.page_labels.insert("/login".into(), "Sign in".into());
    d.page_labels.insert("/gone".into(), "Removed".into());
    let out = filter_to_known(d, &known());
    assert_eq!(out.page_labels.len(), 1);
    assert_eq!(out.page_labels["/login"], "Sign in");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && cargo test --workspace -p taskflow-design --test layout_doc`
Expected: compile error — `LayoutDoc` has no `page_labels`.

- [ ] **Step 3: Implement** — in `src/layout_doc.rs`

Add the import and constant beside the existing ones:

```rust
use std::collections::{HashMap, HashSet};

pub const MAX_LABEL: usize = 40;
```

Add the field to `LayoutDoc` (it already carries `#[serde(rename_all = "camelCase")]`, so `page_labels` becomes `pageLabels` automatically):

```rust
    /// Display labels, route → human name. A *label* only: the page's own title
    /// and the real app are untouched. Absent for a route that has never been
    /// renamed, which is why every reader must fall back to the manifest title.
    #[serde(default)]
    pub page_labels: HashMap<String, String>,
```

In `default_doc()`, add `page_labels: HashMap::new()`.

In `validate`, after the group loop, add:

```rust
    // Same rule as group routes: a label names a page, so a stale client
    // sending one for a route that does not exist is refused rather than stored.
    let mut page_labels = HashMap::with_capacity(doc.page_labels.len());
    for (route, label) in doc.page_labels {
        if !known.contains(route.as_str()) {
            return Err(format!("\"{route}\" is not a page in this project"));
        }
        let label = label.trim().to_string();
        if label.is_empty() {
            return Err(format!("the label for \"{route}\" cannot be empty"));
        }
        if label.chars().count() > MAX_LABEL {
            return Err(format!("a page label is limited to {MAX_LABEL} characters"));
        }
        page_labels.insert(route, label);
    }
```

and include `page_labels` in the returned `LayoutDoc`.

In `filter_to_known`, add to the returned struct:

```rust
        page_labels: doc
            .page_labels
            .into_iter()
            .filter(|(route, _)| known.contains(route.as_str()))
            .collect(),
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && cargo test --workspace -p taskflow-design`
Expected: all green, including the pre-existing `layout_doc` tests.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/layout_doc.rs \
        backend/plugins/taskflow-design/tests/layout_doc.rs
git commit -m "feat(design): page labels on the arrangement document"
```

---

### Task 2: Frontend — label resolution and the rename control

**Files:**
- Modify: `v2_fe/src/lib/design-layout.ts`, `v2_fe/src/lib/design-layout.test.ts`
- Modify: `v2_fe/src/pages/design/pages-panel.tsx`
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`

**Interfaces:**
- Consumes: the wire field `pageLabels` from Task 1.
- Produces: `pageLabel(doc: LayoutDoc, route: string, fallback: string): string`, `setPageLabel(doc: LayoutDoc, route: string, label: string): LayoutDoc`, `MAX_LABEL`, and `LayoutDoc.pageLabels: Record<string, string>`.

- [ ] **Step 1: Write the failing tests** — append to `design-layout.test.ts`

```ts
describe("page labels", () => {
  it("falls back to the manifest title when no label is set", () => {
    expect(pageLabel(DEFAULT_LAYOUT, "/", "Dashboard")).toBe("Dashboard")
  })

  it("prefers a label, and treats a blank one as unset", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "  Home  ")
    expect(pageLabel(doc, "/", "Dashboard")).toBe("Home")
    // A blank label must behave like no label, not like an empty name.
    expect(pageLabel(doc, "/login", "Login")).toBe("Login")
  })

  it("clearing a label removes the key", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "Home")
    const cleared = setPageLabel(doc, "/", "   ")
    expect(cleared.pageLabels["/"]).toBeUndefined()
    expect(pageLabel(cleared, "/", "Dashboard")).toBe("Dashboard")
  })

  it("refuses a label over the cap, returning the document unchanged", () => {
    const doc = setPageLabel(DEFAULT_LAYOUT, "/", "x".repeat(MAX_LABEL + 1))
    expect(doc).toBe(DEFAULT_LAYOUT)
  })

  it("normaliseLayout defaults a missing or malformed pageLabels", () => {
    expect(normalizeLayout({ view: "rows" }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: "nope" }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: { "/": 7 } }).pageLabels).toEqual({})
    expect(normalizeLayout({ view: "rows", pageLabels: { "/": "Home" } }).pageLabels).toEqual({ "/": "Home" })
  })

  it("edits do not mutate the input", () => {
    const doc = DEFAULT_LAYOUT
    const before = JSON.stringify(doc)
    setPageLabel(doc, "/", "Home")
    expect(JSON.stringify(doc)).toBe(before)
  })
})
```

Extend the import line with `pageLabel`, `setPageLabel`, `MAX_LABEL`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd v2_fe && npm test -- design-layout`
Expected: FAIL — the helpers do not exist.

- [ ] **Step 3: Implement** — in `src/lib/design-layout.ts`

```ts
export const MAX_LABEL = 40

/** The name to show for a page: its label if it has one, else the manifest's
 *  own title, else the raw route. One resolver for EVERY place that renders
 *  a page name can never disagree. */
export function pageLabel(doc: LayoutDoc, route: string, fallback: string): string {
  const label = doc.pageLabels[route]
  return label && label.trim() ? label : fallback
}

/// Set or clear a page's display label. An empty (or whitespace) label CLEARS
/// the key rather than storing a blank — a blank label must render identically
/// to no label, and storing one would mean two spellings of the same state.
export function setPageLabel(doc: LayoutDoc, route: string, label: string): LayoutDoc {
  const trimmed = label.trim()
  if (trimmed.length > MAX_LABEL) return doc
  const pageLabels = { ...doc.pageLabels }
  if (!trimmed) delete pageLabels[route]
  else pageLabels[route] = trimmed
  return { ...doc, pageLabels }
}
```

Add `pageLabels: Record<string, string>` to `LayoutDoc` (with a doc comment noting it is a **label only**), add `pageLabels: {}` to `DEFAULT_LAYOUT`, and in `normalizeLayout` add a tolerant read mirroring `groups`:

```ts
  const rawLabels = obj.pageLabels
  const pageLabels: Record<string, string> = {}
  if (rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)) {
    for (const [route, label] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof label === "string" && label.trim()) pageLabels[route] = label
    }
  }
```

Include `pageLabels` in the returned document.

- [ ] **Step 4: Render the label at every site that shows a page name**

**Do not work from the count in this heading, and do not trust a count at all.** An earlier draft of this plan said "three places" and was wrong twice: the toolbar's `PagePicker` (which derives its trigger label from `routes.find(...)?.title` and renders `{r.title}` per row) and the ⌘K command palette (whose `label` is *rendered*, not merely fuzzy-matched) were both missed. The binding rule is the framing: **any site that displays a page's name must resolve it through `pageLabel`.** `rg -n "r\.title|\.title\b"` over `src/pages/design/` is the way to find them — five existed at the time of writing, in `pages-panel.tsx`, `design-canvas.tsx`, and `DesignSurfacePage.tsx` (row-header overlay, `PagePicker` trigger and rows, palette).

- `pages-panel.tsx`: replace `{route.title}` with `{pageLabel(layout, route.path, route.title)}`, and add the rename control. Keep the native-input rule: a plain `<input>` that commits on blur/Enter and reverts on Escape, calling `onLayoutChange(setPageLabel(layout, route.path, value))`.
- `design-canvas.tsx` `ArtboardHeader`: it currently receives `route` and derives a title as `route === "/" ? "Dashboard" : route.slice(1)`. Give it an explicit `label: string` prop instead — computed by the caller — so the header never guesses a name.
- `design-canvas.tsx` row-header overlay: same substitution.
- `DesignSurfacePage.tsx` computes both labels and passes them down; it already has `manifest`.

- [ ] **Step 5: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test`
Expected: no type errors; all green.

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-layout.ts v2_fe/src/lib/design-layout.test.ts \
        v2_fe/src/pages/design/pages-panel.tsx \
        v2_fe/src/pages/design/design-canvas.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): page labels — resolver, rename control, header fallback"
```

---

### Task 3: Frontend — latch the frames (stop unloading seen pages)

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx` (`LazyFrame`)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports; `LazyFrame`'s mount becomes one-way.

- [ ] **Step 1: Make the observer one-way**

`LazyFrame` currently does `for (const entry of entries) setNear(entry.isIntersecting)`, which flips **both** ways — scrolling past unmounts the iframe and swaps in `PlaceholderSkeleton`, and scrolling back reloads the whole document. Replace the callback body with a latch:

```tsx
    const observer = new IntersectionObserver(
      (entries) => {
        // Latch: mount on first sight, never unmount. A page that vanishes when
        // scrolled past cannot be compared against its neighbour, and reloading
        // it on return throws away exactly the live state the comparison needs.
        // Initial mounting stays lazy — a frame nobody has scrolled to still
        // costs nothing, which is what keeps a large canvas from mounting a
        // dozen documents at once.
        for (const entry of entries) if (entry.isIntersecting) setNear(true)
      },
      { root: null, rootMargin: "150%", threshold: 0 }
    )
```

Leave the observer's `disconnect()` cleanup, the `PlaceholderSkeleton` arm, and the `near` state name as they are — only the transition changes.

- [ ] **Step 2: Note the memory trade in the code**

Add one line to `LazyFrame`'s doc comment recording the deliberate trade: frames are never released, so a session that scrolls a large canvas costs one live document per board seen. This is the accepted cost of the behaviour, not an oversight.

- [ ] **Step 3: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test` — type-check and tests only. **Do not run `npm run build`**: it publishes the app, and Task 9 owns the plan's single held publish, backend first.
Expected: clean. The change is one predicate; correctness is visual.

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-canvas.tsx
git commit -m "fix(design): latch frame mounting so seen pages stop unloading"
```

---

### Task 4: Frontend — the four straightforward per-device actions

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`, `v2_fe/src/pages/design/DesignSurfacePage.tsx`

**Interfaces:**
- Consumes: `sandboxUrl` from `@/lib/design-api`; `closeRoute` and the existing device state on the surface.
- Produces: `DesignCanvasProps` gains `onReloadBoard(key: string): void`, `onOpenBoard(key: string): void`, `onDuplicateBoard(key: string, deviceId: string): void`, `onRemoveBoard(route: string): void`.

Rotate is **not** here — it is Task 5, because it is a device-table change rather than a board action.

- [ ] **Step 1: Give each board its own reload epoch**

`contentEpoch` is global, so reloading one board would remount every frame. The **surface** owns an extra per-board counter (it is the component that already owns the actions) and passes the map down; `DesignCanvas` adds it to the global epoch when it builds each frame's key:

```tsx
// DesignSurfacePage — one counter per board, layered ON TOP of the global
// `contentEpoch`. A server-side file change remounts everything (that epoch),
// while a single board's Reload must remount only that board — without this
// overlay, one click would reload every frame on the canvas.
const [boardEpochs, setBoardEpochs] = useState<Map<string, number>>(new Map())
```

`DesignCanvasProps` gains `boardEpochs: Map<string, number>`, and `ArtboardCard`'s `LazyFrame` receives `epoch={contentEpoch + (boardEpochs.get(board.key) ?? 0)}`.

- [ ] **Step 2: Wire the four actions in `DesignSurfacePage`**

```tsx
  const handleReloadBoard = useCallback((key: string) => {
    setBoardEpochs((current) => new Map(current).set(key, (current.get(key) ?? 0) + 1))
  }, [])

  const handleOpenBoard = useCallback((key: string) => {
    if (!sandboxToken) return
    const board = artboards.find((b) => b.key === key)
    if (!board) return
    // The sandbox URL is the same origin-isolated render the frame shows.
    window.open(sandboxUrl(sandboxToken, board.route), "_blank", "noopener")
  }, [sandboxToken, artboards])

  const handleDuplicateBoard = useCallback((key: string, deviceId: string) => {
    const board = artboards.find((b) => b.key === key)
    if (!board) return
    setDeviceIds((current) =>
      current.includes(deviceId) ? current : [...current, deviceId],
    )
  }, [artboards])

  const handleRemoveBoard = useCallback((route: string) => closeRoute(route), [closeRoute])
```

`handleDuplicateBoard` deliberately adds the **device**, not a board: boards are derived from `(openRoutes × deviceIds)`, so adding the device is the only way to get this route rendered at another size, and it does so consistently in every arrangement.

- [ ] **Step 3: Wire the menu items**

In `ArtboardHeader`, give each item its handler and remove the dead placeholders' status. Pass the callbacks plus `board.key`/`board.route` down through `ArtboardCard`. `Duplicate at another device` needs a device list — render it as a `DropdownMenuSub` over `DEVICE_PRESETS` excluding any already selected.

- [ ] **Step 4: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test` — type-check and tests only. **Do not run `npm run build`**: it publishes the app, and Task 9 owns the plan's single held publish, backend first.

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-canvas.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): per-device actions — reload, open, duplicate, remove"
```

---

### Task 5: Frontend — rotate as a landscape device variant

**Files:**
- Modify: `v2_fe/src/lib/design-devices.ts`, `v2_fe/src/lib/design-devices.test.ts`
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`

`DesignSurfacePage.tsx` is **not** in this task: the only Rotate site is `ArtboardHeader`, and the action reuses Task 4's `onDuplicateBoard` plumbing, which the surface already wires. An earlier draft listed it and an implementer correctly invented nothing.

**Interfaces:**
- Consumes: `DEVICE_PRESETS`, `deviceById`.
- Produces: `landscapeId(deviceId: string): string`, `landscapeVariant(device: DevicePreset): DevicePreset | null` (null for laptop/breakpoint), and the landscape entries appended to `DEVICE_PRESETS`.

**Why this shape:** the hard constraint says the iframe renders at true pixel dimensions, so rotating *is* changing the width and therefore the breakpoint. Modelling a rotated board as an ordinary device preset — id `${id}:landscape`, dimensions swapped — means `deviceById`, `boardWidth`, `boardHeight` and all three layout engines need **no change at all**, and the rotated board is visibly a different board rather than a silently altered one.

- [ ] **Step 1: Write the failing tests** — append to `design-devices.test.ts`

```ts
describe("landscape variants", () => {
  it("swaps the dimensions and keeps the group", () => {
    const v = landscapeVariant(deviceById("iphone-16-pro"))!
    expect(v.width).toBe(852)
    expect(v.height).toBe(393)
    expect(v.group).toBe("phone")
    expect(v.id).toBe("iphone-16-pro:landscape")
  })

  it("exists only for phones and tablets", () => {
    expect(landscapeVariant(deviceById("iphone-se"))).not.toBeNull()
    expect(landscapeVariant(deviceById("ipad-mini"))).not.toBeNull()
    // A laptop is not a portrait device and a breakpoint is a width, not a
    // device — rotating either produces a size that means nothing.
    expect(landscapeVariant(deviceById("laptop"))).toBeNull()
    expect(landscapeVariant(deviceById("bp-sm"))).toBeNull()
  })

  it("every variant is a real preset, so the device filter accepts it", () => {
    // `design-ui-state`'s parse filters stored ids against DEVICE_PRESETS; a
    // landscape id that is not in the table would be silently dropped on reload.
    for (const d of DEVICE_PRESETS) {
      if (d.id.endsWith(":landscape")) {
        expect(d.width).toBe(deviceById(d.id.replace(":landscape", "")).height)
      }
    }
    expect(DEVICE_PRESETS.some((d) => d.id === "iphone-16-pro:landscape")).toBe(true)
  })

  it("deviceById resolves a variant, and board metrics follow it", () => {
    const v = deviceById("iphone-16-pro:landscape")
    expect(v.width).toBe(852)
    // Portrait: 393 + 12 + 12 + 2. Landscape swaps the WIDTH, so the sides are
    // the same padding but the number is now the preset's height.
    expect(boardWidth(v)).toBe(852 + 12 + 12 + 2)
  })

  it("landscapeId is stable and reversible", () => {
    expect(landscapeId("ipad-mini")).toBe("ipad-mini:landscape")
    expect(deviceById(landscapeId("ipad-mini")).id).toBe("ipad-mini:landscape")
  })
})
```

Extend that file's imports with `landscapeVariant`, `landscapeId`, `boardWidth`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd v2_fe && npm test -- design-devices`
Expected: FAIL — `landscapeVariant is not a function`.

- [ ] **Step 3: Implement** — in `src/lib/design-devices.ts`

```ts
/** Id of a device's landscape variant. */
export function landscapeId(deviceId: string): string {
  return `${deviceId}:landscape`
}

/// A rotated rendering of a device: the SAME device, rendered at swapped
/// dimensions. Phones and tablets only — a laptop is not a portrait device, and
/// a Tailwind breakpoint is a width rather than a device, so rotating either
/// produces a size that means nothing.
///
/// This is a real preset rather than a per-board flag precisely because the
/// iframe must render at true pixel dimensions: rotating therefore IS a
/// breakpoint change, and giving it its own preset makes that visible instead
/// of hiding it. Returns null when the device has no meaningful landscape form.
export function landscapeVariant(device: DevicePreset): DevicePreset | null {
  // Already landscape: rotating again would build `${id}:landscape:landscape`,
  // an id no preset declares — `deviceById` would fall back to a laptop, so two
  // different boards would collide on one key while one renders the wrong
  // device. The helper must be total; a caller guard is defence, not the fix.
  if (device.id.endsWith(":landscape")) return null
  if (device.group !== "phone" && device.group !== "tablet") return null
  return {
    ...device,
    id: landscapeId(device.id),
    label: `${device.label} ↻`,
    width: device.height,
    height: device.width,
  }
}
```

Then append every variant to `DEVICE_PRESETS`:

```ts
// Landscape variants live in the preset table so `deviceById`, the layout
// engines, the device picker and `design-ui-state`'s stored-id filter all
// resolve them with no special case. Built from the portrait entries, so the
// two can never disagree about a device's dimensions.
for (const preset of [...DEVICE_PRESETS]) {
  const variant = landscapeVariant(preset)
  if (variant) DEVICE_PRESETS.push(variant)
}
```

**Ordering matters:** this must run after the initial array literal. `deviceById`'s fallback search (`DEVICE_PRESETS.find((d) => d.id === FALLBACK_DEVICE_ID)`) still resolves `"laptop"` — verify that test still passes.

- [ ] **Step 4: Wire the Rotate action**

In `ArtboardHeader`, replace the Rotate placeholder with one that adds the board's landscape variant to `deviceIds` when one exists, and is **disabled with a readable reason** when it does not (`landscapeVariant` returned null).

**The reason must be in the item's rendered TEXT, not a `title` attribute.** `dropdown-menu.tsx:91` sets `data-disabled:pointer-events-none`, so a disabled item can never show a tooltip — a `title` there is unreachable and produces a greyed item with an explanation nobody can read, which is a milder form of the "feels broken" complaint this phase exists to fix. Use the same `onDuplicateBoard(key, deviceId)` plumbing from Task 4 — the effect is identical — with the variant's id.

- [ ] **Step 5: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test` — type-check and tests only. **Do not run `npm run build`**: it publishes the app, and Task 9 owns the plan's single held publish, backend first.

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts \
        v2_fe/src/pages/design/design-canvas.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): rotate as a landscape device variant"
```

---

### Task 6: Backend — the resource document and its validator

**Files:**
- Create: `backend/plugins/taskflow-design/src/resources.rs`
- Create: `backend/plugins/taskflow-design/tests/resources.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (`pub mod resources;`)

**Interfaces:**
- Produces: `ResourceLink`, `ResourceSet`, `ResourcesDoc`, `parse(&str) -> Result<ResourcesDoc, String>`, `validate(ResourcesDoc) -> Result<ResourcesDoc, String>`, `to_json_string(&ResourcesDoc) -> String`, `enabled_links(&ResourcesDoc) -> Vec<(bool, &ResourceLink)>` (the bool = is-script), `MAX_SETS`, `MAX_LINKS_PER_SET`, `MAX_HREF`, `ALLOWED_REL`, and `RESOURCES_PATH: &str = "styles/resources.json"`.

- [ ] **Step 1: Write the failing tests** — `tests/resources.rs`

```rust
use taskflow_design::resources::{
    enabled_links, parse, to_json_string, validate, ResourcesDoc, ResourceLink, ResourceSet,
    ALLOWED_REL, MAX_HREF, MAX_LINKS_PER_SET, MAX_SETS,
};

fn link(rel: &str, href: &str) -> ResourceLink {
    ResourceLink { rel: Some(rel.into()), href: Some(href.into()), crossorigin: false,
                   script: None, is_script: false, is_async: false }
}

fn doc(sets: Vec<ResourceSet>) -> ResourcesDoc {
    ResourcesDoc { version: 1, sets }
}

fn set(name: &str, links: Vec<ResourceLink>) -> ResourceSet {
    ResourceSet { id: format!("set_{name}"), name: name.into(), enabled: true, links }
}

#[test]
fn round_trips() {
    let d = doc(vec![set("Inter", vec![link("stylesheet", "https://fonts.googleapis.com/css2?family=Inter")])]);
    assert_eq!(parse(&to_json_string(&d)).unwrap(), d);
}

#[test]
fn accepts_the_google_fonts_triple() {
    let d = doc(vec![set("Inter", vec![
        link("preconnect", "https://fonts.googleapis.com"),
        ResourceLink { crossorigin: true, ..link("preconnect", "https://fonts.gstatic.com") },
        link("stylesheet", "https://fonts.googleapis.com/css2?family=Inter&display=swap"),
    ])]);
    assert!(validate(d).is_ok());
}

#[test]
fn refuses_dangerous_schemes_in_every_spelling() {
    // Review Focus #1. Case and whitespace must not be a bypass.
    for bad in [
        "javascript:alert(1)", "JaVaScRiPt:alert(1)", "  javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>", "DATA:text/html,x",
        "http://fonts.googleapis.com/css",            // not https
        "//fonts.googleapis.com/css",                 // scheme-relative
        "/local/thing.css",                           // not absolute
    ] {
        let d = doc(vec![set("Bad", vec![link("stylesheet", bad)])]);
        assert!(validate(d).is_err(), "should refuse: {bad}");
    }
}

#[test]
fn refuses_a_script_with_a_dangerous_scheme() {
    let mut l = link("stylesheet", "https://ok.example/x.js");
    l.is_script = true;
    l.rel = None;
    l.script = Some("javascript:alert(1)".into());
    assert!(validate(doc(vec![set("X", vec![l])])).is_err());
}

#[test]
fn refuses_rel_outside_the_allowlist() {
    let d = doc(vec![set("X", vec![link("import", "https://ok.example/x")])]);
    assert!(validate(d).is_err());
    for rel in ALLOWED_REL {
        let d = doc(vec![set("X", vec![link(rel, "https://ok.example/x")])]);
        assert!(validate(d).is_ok(), "{rel} should be allowed");
    }
}

#[test]
fn refuses_over_long_hrefs_caps_and_duplicate_names() {
    let long = format!("https://ok.example/{}", "x".repeat(MAX_HREF));
    assert!(validate(doc(vec![set("X", vec![link("stylesheet", &long)])])).is_err());

    let many: Vec<ResourceSet> = (0..=MAX_SETS)
        .map(|i| set(&format!("S{i}"), vec![])) // distinct names
        .collect();
    assert!(validate(doc(many)).is_err());

    let too_many_links = vec![link("stylesheet", "https://ok.example/x"); MAX_LINKS_PER_SET + 1];
    assert!(validate(doc(vec![set("X", too_many_links)])).is_err());

    let dupes = vec![set("Same", vec![]), set("same", vec![])];
    assert!(validate(doc(dupes)).is_err());
}

#[test]
fn enabled_links_skips_disabled_sets_and_keeps_order() {
    let mut off = set("Off", vec![link("stylesheet", "https://off.example/x")]);
    off.enabled = false;
    let d = doc(vec![off, set("On", vec![link("stylesheet", "https://on.example/x")])]);
    let out = enabled_links(&d);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1.href.as_deref(), Some("https://on.example/x"));
}

#[test]
fn garbage_is_an_error_not_a_panic() {
    assert!(parse("not json").is_err());
    assert!(parse(r#"{"sets":"nope"}"#).is_err());
    assert!(parse(r#"{"version":1}"#).is_ok()); // sets defaults to empty
}

#[test]
fn an_empty_document_is_valid_and_emits_nothing() {
    let d = validate(doc(vec![])).unwrap();
    assert!(enabled_links(&d).is_empty());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && cargo test --workspace -p taskflow-design --test resources`
Expected: compile error — no `resources` module.

- [ ] **Step 3: Implement** — `src/resources.rs`

```rust
//! The project's external resource document: named, toggleable groups of links
//! a page needs in order to look right — a web font and its companion
//! preconnects, or a third-party script.
//!
//! Stored as a `DesignFile` row at `styles/resources.json`, which means it
//! inherits versioning, the write validator, the operator and agent write
//! endpoints, and the manifest without any new plumbing. Shape mirrors
//! `tokens.rs`, which set that precedent.
//!
//! The security posture is the point of `validate`. These links are injected
//! into a document that runs scripts, so a URL scheme is a capability: only
//! `https:` is accepted, and `javascript:`/`data:` are refused in every
//! spelling. The sandbox is a separate origin with no cookies and a short-lived
//! read-only token, which bounds the blast radius — it does not license letting
//! an arbitrary scheme through.

use serde::{Deserialize, Serialize};

pub const RESOURCES_PATH: &str = "styles/resources.json";
pub const MAX_SETS: usize = 24;
pub const MAX_LINKS_PER_SET: usize = 16;
pub const MAX_HREF: usize = 2_048;
pub const MAX_SET_NAME: usize = 60;

/// `rel` values we accept on a `<link>`. All four are inert: none executes or
/// mutates the document, which is what makes them safe to allow alongside a
/// stylesheet.
pub const ALLOWED_REL: &[&str] = &["preconnect", "dns-prefetch", "stylesheet"];

/// camelCase on the wire throughout, so the frontend mirror is mechanical.
/// Everything is always serialised — no `skip_serializing_if` — because a
/// `None`/`false` round-trips through `#[serde(default)]` identically and the
/// attribute gymnastics buy nothing but a chance to get one wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLink {
    /// Present for `<link>` shapes.
    #[serde(default)]
    pub rel: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub crossorigin: bool,
    /// Present for `<script>` shapes.
    #[serde(default)]
    pub script: Option<String>,
    /// True when this link is a `<script src>` rather than a `<link>`.
    #[serde(default)]
    pub is_script: bool,
    #[serde(default)]
    pub is_async: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSet {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub links: Vec<ResourceLink>,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesDoc {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub sets: Vec<ResourceSet>,
}

fn default_version() -> u32 { 1 }

pub fn parse(raw: &str) -> Result<ResourcesDoc, String> {
    serde_json::from_str::<ResourcesDoc>(raw).map_err(|e| format!("invalid resources document: {e}"))
}

pub fn to_json_string(doc: &ResourcesDoc) -> String {
    serde_json::to_string(doc).expect("ResourcesDoc serialises")
}

/// The URL a link actually points at, whichever shape it is.
fn url_of(link: &ResourceLink) -> Option<&str> {
    if link.is_script { link.script.as_deref() } else { link.href.as_deref() }
}

/// `https:` and nothing else. Checked on the LOWERCASED, TRIMMED url so case
/// and leading whitespace cannot smuggle a scheme past it, and deliberately
/// strict — a scheme-relative `//host/x` and a bare path are both refused,
/// because "it will resolve to https anyway" is an assumption about the page's
/// origin, not a property of the link.
fn is_safe_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("https://") && !u.starts_with("https://javascript:")
}

pub fn validate(doc: ResourcesDoc) -> Result<ResourcesDoc, String> {
    if doc.sets.len() > MAX_SETS {
        return Err(format!("at most {MAX_SETS} resource sets are allowed"));
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sets = Vec::with_capacity(doc.sets.len());

    for set in doc.sets {
        let name = set.name.trim().to_string();
        if name.is_empty() {
            return Err("a resource set needs a name".into());
        }
        if name.chars().count() > MAX_SET_NAME {
            return Err(format!("a set name is limited to {MAX_SET_NAME} characters"));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("the set name \"{name}\" is already used"));
        }
        let id = set.id.trim().to_string();
        if id.is_empty() {
            return Err("a resource set needs a non-empty id".into());
        }
        if set.links.len() > MAX_LINKS_PER_SET {
            return Err(format!("at most {MAX_LINKS_PER_SET} links per set"));
        }

        let mut links = Vec::with_capacity(set.links.len());
        for link in set.links {
            let url = url_of(&link).ok_or_else(|| {
                format!("a link in \"{name}\" has no {}",
                    if link.is_script { "src" } else { "href" })
            })?;
            if url.trim().is_empty() {
                return Err(format!("a link in \"{name}\" has an empty url"));
            }
            if url.chars().count() > MAX_HREF {
                return Err(format!("a url in \"{name}\" is too long"));
            }
            if !is_safe_url(url) {
                return Err(format!("\"{url}\" is not an https address"));
            }
            if !link.is_script {
                let rel = link.rel.as_deref().unwrap_or("").trim().to_ascii_lowercase();
                if !ALLOWED_REL.contains(&rel.as_str()) {
                    // Enumerate from the constant, never a hardcoded list: the
                    // first version of this message named no alternatives at
                    // all, so a user who wrote a relation that is not allowed
                    // (or whose relation was dropped from the set) had no way to
                    // learn what to write instead. The set and the sentence that
                    // describes it are now one source.
                    return Err(format!(
                        "\"{rel}\" is not an allowed link relation; use one of: {}",
                        ALLOWED_REL.join(", ")
                    ));
                }
            }
            links.push(link);
        }
        sets.push(ResourceSet { id, name, enabled: set.enabled, links });
    }

    Ok(ResourcesDoc { version: doc.version, sets })
}

/// Every link from enabled sets, in document order, paired with whether it is a
/// script. Disabled sets contribute nothing — that is the whole point of the
/// toggle, and the reason a font can be kept without affecting a page.
pub fn enabled_links(doc: &ResourcesDoc) -> Vec<(bool, &ResourceLink)> {
    doc.sets
        .iter()
        .filter(|s| s.enabled)
        .flat_map(|s| s.links.iter().map(|l| (l.is_script, l)))
        .collect()
}
```

Register `pub mod resources;` in `lib.rs` beside the other `pub mod` lines.

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && cargo test --workspace -p taskflow-design --test resources`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/resources.rs \
        backend/plugins/taskflow-design/src/lib.rs \
        backend/plugins/taskflow-design/tests/resources.rs
git commit -m "feat(design): external resource document + https-only validator"
```

---

### Task 7: Backend — compose the links and widen the CSP

**Files:**
- Modify: `backend/plugins/taskflow-design/src/manifest.rs` (the field, the wiring, and its own test module)
- Modify: `backend/plugins/taskflow-design/src/composer.rs`
- Modify: `backend/plugins/taskflow-design/tests/resources.rs` (the emitter's own tests — this is the resource document's existing test file, so the emission tests belong beside the validator's)

**Interfaces:**
- Consumes: `resources::{parse, enabled_links, RESOURCES_PATH}` from Task 6.
- Produces: `DesignManifest.resources: Vec<(bool, ResourceLink)>` (script?, link) and `pub fn resources_tags(links: &[(bool, ResourceLink)]) -> String` in `composer.rs`. It takes the slice rather than the manifest so it is a pure function with no fixture to build.

- [ ] **Step 1: Write the failing tests**

In a composer test file, assert both halves — presence for enabled sets, absence for disabled ones and for an absent document:

```rust
use taskflow_design::composer;
use taskflow_design::resources::ResourceLink;

fn lk(rel: &str, href: &str) -> ResourceLink {
    ResourceLink { rel: Some(rel.into()), href: Some(href.into()), crossorigin: false,
                   script: None, is_script: false, is_async: false }
}
fn sc(src: &str) -> ResourceLink {
    ResourceLink { rel: None, href: None, crossorigin: false,
                   script: Some(src.into()), is_script: true, is_async: true }
}

#[test]
fn enabled_resource_links_are_emitted_in_document_order() {
    // Review Focus: the Google Fonts triple, in the order the user pasted it.
    let links = vec![
        (false, lk("preconnect", "https://fonts.googleapis.com")),
        (false, lk("stylesheet", "https://fonts.googleapis.com/css2?family=Inter&display=swap")),
        (true, sc("https://cdn.example/x.js")),
    ];
    let tags = composer::resources_tags(&links);
    let pre = tags.find("preconnect").expect("preconnect emitted");
    let sheet = tags.find("stylesheet").expect("stylesheet emitted");
    let js = tags.find("cdn.example").expect("script emitted");
    assert!(pre < sheet && sheet < js, "order must be preserved: {tags}");
    assert!(tags.contains("async"), "async is carried through: {tags}");
    assert!(!tags.contains("crossorigin"), "not set on these links: {tags}");
}

#[test]
fn crossorigin_is_emitted_when_set() {
    let mut l = lk("preconnect", "https://fonts.gstatic.com");
    l.crossorigin = true;
    assert!(composer::resources_tags(&[(false, l)]).contains("crossorigin"));
}

#[test]
fn an_empty_resource_list_emits_nothing() {
    // Review Focus #2: absent document, or every set disabled, is the normal
    // case for most projects and must produce no markup at all.
    assert_eq!(composer::resources_tags(&[]), "");
}

#[test]
fn an_attribute_breaking_url_is_escaped_not_executed() {
    // `validate` accepts this by design — a URL is opaque to it — so the EMIT
    // path is the only thing standing between it and execution, now that
    // `script-src` allows any https origin.
    let nasty = "https://ok.example/x\" onload=\"alert(1)";
    let tags = composer::resources_tags(&[(false, lk("stylesheet", nasty))]);
    assert!(!tags.contains("\" onload="), "attribute escaped: {tags}");
    assert!(tags.contains("&quot;") || tags.contains("&#34;"), "quote encoded: {tags}");
}

// The scheme refusal is deliberately NOT tested here. It lives in
// `resources::validate`, and Step 3 runs `validate` before `enabled_links`, so
// the emitter never receives a refused link. The emitter ESCAPES; it does not
// FILTER — a test that handed it a hand-built `javascript:` row would assert a
// property this design does not promise, and would pass whatever the emitter
// did, because a `javascript:` URL interpolated into `href` is perfectly
// well-escaped HTML. The property that actually protects the page is
// end-to-end — a document carrying a dangerous scheme emits nothing — and it is
// pinned in `src/manifest.rs`'s test module, where a two-file fixture costs
// three lines (the tests are in Step 3 below).

// This test replaces an earlier draft that asserted `csp.contains("https:")`,
// `!csp.contains("http://")` and `!csp.contains("'unsafe-eval'")`. Every one of
// those passes on the UNWIDENED policy too — `https:` is already present via
// `https://cdn.jsdelivr.net` — so the test could not see the very change it was
// written for, and would equally have passed if `connect-src` had been widened
// by mistake. The implementer caught that by running it at RED, before adding
// the widening, rather than by reading it. The lesson to keep: for a test whose
// job is to fail on the WRONG code, "the assertions hold on the current code" is
// not verification.
#[test]
fn the_widening_reaches_the_three_fetch_directives_and_stops_there() {
    // Pin the boundary in both directions — the three directives that MUST carry
    // a scheme source, and the four that must not move at all.
    let csp = composer::sandbox_csp("token");
    let directives: HashMap<&str, &str> = csp
        .split(';')
        .filter_map(|part| part.trim().split_once(' '))
        .map(|(name, value)| (name, value.trim()))
        .collect();

    for directive in ["script-src", "style-src", "font-src"] {
        let value = directives.get(directive).copied().unwrap_or_default();
        assert!(
            value.split_whitespace().any(|src| src == "https:"),
            "{directive} must allow any https origin for a webfont to load: {csp}"
        );
        assert!(
            value.split_whitespace().any(|src| src == "https://cdn.jsdelivr.net"),
            "{directive} must keep the jsdelivr origin it already had: {csp}"
        );
    }

    // Asserted as VALUES rather than as substrings, so a widened `connect-src`
    // (which would let agent-authored JS POST the operator's localhost and
    // intranet anywhere) cannot slip through. Token equality is what makes this
    // test unattributable to a `https:` occurring anywhere else in the string.
    assert_eq!(directives.get("default-src").copied(), Some("'self'"));
    assert_eq!(directives.get("img-src").copied(), Some("'self' data: blob:"));
    assert_eq!(directives.get("connect-src").copied(), Some("'self' https://cdn.jsdelivr.net"));
    assert_eq!(directives.get("form-action").copied(), Some("'none'"));
    assert_eq!(directives.get("base-uri").copied(), Some("'none'"));
    assert_eq!(directives.get("frame-ancestors").copied(), Some("*"));
}
```

Add `use std::collections::HashMap;` to the test file's imports.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Build the resource list onto the manifest**

In `manifest.rs`, `build(...)` already receives `&[DesignFile]`. Find the resources row by path, parse it, and store the enabled links:

```rust
    // Absent, unparseable, or invalid: no links, page composes normally. The
    // read path is forgiving by design — a bad resource document must never
    // stop a page from rendering, because the page is the thing being worked on.
    let resources = files
        .iter()
        .find(|f| f.path == resources::RESOURCES_PATH)
        .and_then(|f| resources::parse(&f.content).ok())
        .and_then(|d| resources::validate(d).ok())
        .map(|d| resources::enabled_links(&d).into_iter().map(|(s, l)| (s, l.clone())).collect())
        .unwrap_or_default();
```

Add `pub resources: Vec<(bool, ResourceLink)>` to `DesignManifest`.

**Now test it — Step 3 is real wiring and nothing above covers it.** The tests in Step 1 call `resources_tags` directly, so the manifest half (finding the row, parsing it, validating it, filtering to enabled sets) would otherwise ship untested: it is exactly the seam where a mistake looks like every neighbouring unit passing. Add these to the **existing `#[cfg(test)] mod tests` in `src/manifest.rs`**, beside `token_file`, which is the fixture pattern already there:

```rust
    fn resource_file(content: &str) -> DesignFile {
        DesignFile {
            id: 0,
            project: ForeignKey::new(1),
            kind: DesignFileKind::Token,
            path: resources::RESOURCES_PATH.to_string(),
            content: content.to_string(),
            version: 1,
            updated_by: "test".to_string(),
            created_at: None,
            updated_at: None,
        }
    }

    fn page_file(path: &str) -> DesignFile {
        DesignFile {
            kind: DesignFileKind::Page,
            path: path.to_string(),
            content: "<main>x</main>".to_string(),
            ..resource_file("")
        }
    }

    #[test]
    fn enabled_sets_reach_the_manifest_and_disabled_ones_do_not() {
        let doc = r#"{"version":1,"sets":[
            {"id":"on","name":"On","enabled":true,
             "links":[{"rel":"preconnect","href":"https://fonts.googleapis.com"},
                      {"rel":"stylesheet","href":"https://fonts.googleapis.com/css2?family=Inter&display=swap"}]},
            {"id":"off","name":"Off","enabled":false,
             "links":[{"rel":"stylesheet","href":"https://example.com/off.css"}]}
        ]}"#;
        let files = vec![page_file("pages/index.html"), resource_file(doc)];
        let m = manifest::build(1, &files, 0);
        let hrefs: Vec<_> = m.resources.iter().map(|(_, l)| l.href.as_deref()).collect();
        assert_eq!(m.resources.len(), 2, "only the enabled set contributes: {hrefs:?}");
        assert!(m.resources.iter().all(|(is_script, _)| !*is_script));
        assert!(hrefs.contains(&Some("https://fonts.googleapis.com")), "{hrefs:?}");
        assert!(
            !hrefs.contains(&Some("https://example.com/off.css")),
            "a disabled set must not contribute: {hrefs:?}"
        );
    }

    #[test]
    fn a_document_with_a_dangerous_scheme_contributes_nothing() {
        // The end-to-end half of the scheme rule: `validate` refuses the whole
        // document, the forgiving read collapses it to no links, and the emitter
        // therefore has nothing dangerous to escape.
        let doc = r#"{"version":1,"sets":[{"id":"a","name":"A","enabled":true,
            "links":[{"rel":"stylesheet","href":"javascript:alert(1)"}]}]}"#;
        let m = manifest::build(1, &[page_file("pages/index.html"), resource_file(doc)], 0);
        assert!(m.resources.is_empty(), "a refused document yields no links");
    }

    #[test]
    fn an_absent_or_unparseable_resource_row_contributes_nothing() {
        for doc in [None, Some("{ not json")] {
            let mut files = vec![page_file("pages/index.html")];
            if let Some(c) = doc {
                files.push(resource_file(c));
            }
            let m = manifest::build(1, &files, 0);
            assert!(m.resources.is_empty(), "forgiving read: {doc:?}");
        }
    }
```

Run: `cd backend && cargo test -p taskflow-design --lib manifest`

- [ ] **Step 4: Emit and widen the CSP**

In `composer.rs`, add:

```rust
/// The project's enabled external resources as tags for the document head.
/// Emitted BEFORE the page's own stylesheet so a page can override a webfont,
/// and only for enabled sets — a disabled set contributes nothing.
pub fn resources_tags(links: &[(bool, ResourceLink)]) -> String {
    let mut out = String::new();
    for (is_script, link) in links {
        if *is_script {
            if let Some(src) = &link.script {
                out.push_str(&format!(
                    "<script src=\"{}\"{}></script>\n",
                    esc(src),
                    if link.is_async { " async" } else { "" }
                ));
            }
        } else if let (Some(rel), Some(href)) = (&link.rel, &link.href) {
            out.push_str(&format!(
                "<link rel=\"{}\" href=\"{}\"{}>\n",
                esc(rel),
                esc(href),
                if link.crossorigin { " crossorigin" } else { "" }
            ));
        }
    }
    out
}
```

**Escaping is load-bearing, not hygiene.** `resources::validate` accepts a URL containing a double quote by design (a URL is opaque to it), and Task 7 widens `script-src` to `https:` — so an unescaped `href="https://ok.example/x" onload="…"` or a URL carrying a `">` would break out of the attribute and execute. Every interpolated value must go through `composer::esc`, and the test below exists specifically to pin that rather than to document it.

Insert `{resources_tags(&manifest.resources)}` into the `<head>` of **both** `compose_document` and `compose_export_document` (the export is the downloaded page — a font that does not travel with it would be a silent surprise), immediately before the tokens stylesheet link.

Then widen `sandbox_csp`: add `https:` to `script-src`, `style-src` and `font-src`, keeping the existing jsDelivr entries. Update the doc comment above it to record why the widening is bounded — separate origin, no cookies, short-lived read-only token, links supplied by the project's own members — and why the scheme refusal in `resources::validate` is what makes it acceptable.

**Leave `connect-src`, `form-action`, `base-uri` and `frame-ancestors` exactly as they are.** `connect-src` is the one directive whose existing comment says why it is tight: without it, agent-authored JS could `fetch()` the operator's localhost and internal network from inside their browser. Widening it to `https:` would grant arbitrary exfiltration for no gain — a webfont is fetched by the *renderer*, not by `fetch()`, so `style-src`/`font-src` already cover the whole requirement. Widening it is the plausible-looking mistake available in this step, so the test asserts on the CSP text: `!csp.contains("http://")` and the four directives' presence.

- [ ] **Step 5: Run the tests and commit**

Run: `cd backend && cargo test --workspace`

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/manifest.rs \
        backend/plugins/taskflow-design/src/composer.rs \
        backend/plugins/taskflow-design/tests/
git commit -m "feat(design): inject enabled resource links; allow https in the sandbox CSP"
```

---

### Task 8: Frontend — the resource-set editor

**Files:**
- Create: `v2_fe/src/pages/design/resource-editor.tsx`
- Create: `v2_fe/src/lib/resources.ts`, `v2_fe/src/lib/resources.test.ts`
- Modify: `v2_fe/src/lib/design-api.ts` (add the resource document's fetch/put pair, mirroring the tokens pair)
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (mount it in the Tokens tab)

**Interfaces:**
- Consumes: the `DesignFile` endpoints already used by `TokenEditor` (`styles/resources.json`), and `ResourceLink`/`ResourceSet`/`ResourcesDoc` mirrored from Task 6.
- **The data pair goes in `design-api.ts`, mirroring the tokens pair.** "The endpoints `TokenEditor` uses" is not a generic client — it is two thin wrappers over the generic file calls, and the resource document needs its own:
  - `export const RESOURCES_JSON_PATH = "styles/resources.json"`, beside `TOKENS_JSON_PATH`.
  - `fetchDesignResources(projectId): Promise<{ doc: ResourcesDoc; version: number }>` over `fetchDesignFile(projectId, RESOURCES_JSON_PATH)`, **failing soft to an empty document** when the row is absent *or* its content does not parse — the same tolerant read `fetchDesignTokens` (`design-api.ts:210-223`) does, and the read half of the strict-write/forgiving-read asymmetry.
  - `putDesignResources(projectId, doc, baseVersion): Promise<WriteFileResult>` over `putDesignFile(projectId, RESOURCES_JSON_PATH, JSON.stringify(doc), baseVersion)`.
  - The save has **three** outcomes, not two (`design-api.ts:101-102`): `{ok: true}`, `{ok: false, errors: ValidationError[]}`, and `{ok: false, error: "version_conflict"}`. Step 3's "show the server's message" means rendering `errors[].message` — and the `version_conflict` arm must be handled too, or an editor that went stale silently saves nothing.
- Produces: `normalizeResources(raw: unknown): ResourcesDoc`, `toggleSet(doc, id): ResourcesDoc`, `addSet(doc, name): { doc: ResourcesDoc; id: string }`, `removeSet(doc, id): ResourcesDoc`, `appendLinks(doc, setId, links): { doc: ResourcesDoc; added: number; skipped: number }`, `parsePastedLinks(text: string): ResourceLink[]`.
- **Wire shape, mirrored from Task 6's Rust exactly** (it is `#[serde(rename_all = "camelCase")]` there): `ResourceLink = { rel?: string; href?: string; crossorigin: boolean; script?: string; isScript: boolean; isAsync: boolean }`; `ResourceSet = { id: string; name: string; enabled: boolean; links: ResourceLink[] }`; `ResourcesDoc = { version: number; sets: ResourceSet[] }`. Every field is always present on the wire — the Rust side does not skip serialising — so `normalizeResources` must tolerate `null` for the optional ones.
- **`removeSet` on an unknown id, and `toggleSet` on an unknown id, both return the SAME document object** (identity), matching `createGroup`'s refusal convention so a caller can tell "nothing happened".
- **Mirror the server's caps**, so the editor cannot build a document the server will reject — the rule `createGroup` already states in its own doc comment (*"matching the server's rule, so the UI cannot build a document the server will reject"*). Task 6's validator enforces all three of these (`resources.rs:20-23`), so without the mirror "Add set" appears to work and the *save* then fails with a message about a document the user cannot see:

  ```ts
  export const MAX_SETS = 24          // resources.rs MAX_SETS
  export const MAX_SET_NAME = 60      // resources.rs MAX_SET_NAME
  export const MAX_LINKS_PER_SET = 16 // resources.rs MAX_LINKS_PER_SET

  let setSeq = 0
  function nextSetId(): string {
    setSeq += 1
    return `s${Date.now().toString(36)}${setSeq.toString(36)}`
  }
  ```

  `nextSetId` mirrors `design-layout.ts`'s `nextGroupId` exactly — same shape, same module-local counter, same reason (ids must be unique and stable; the server refuses duplicates by design). `addSet` refuses (identity doc plus `id: ""`) when the trimmed name is blank, over `MAX_SET_NAME`, already taken case-insensitively, or `doc.sets.length >= MAX_SETS`. `appendLinks` appends only as many links as fit under `MAX_LINKS_PER_SET`, reports `added`/`skipped`, and returns the same document object when nothing fit.
- **Do NOT mirror `MAX_HREF` (2048).** The line is: cap what the *UI* creates as an entity, because there is no server message that makes sense for "you clicked Add set"; let the server adjudicate per-link content, because "a url is limited to 2048 characters" is a message the user can act on, and Step 3 already surfaces it.

- [ ] **Step 1: Write the failing tests** — `src/lib/resources.test.ts`

```ts
describe("normalizeResources", () => {
  it("returns an empty document for anything unusable", () => {
    for (const raw of [null, "nope", 7, {}, { sets: "nope" }]) {
      expect(normalizeResources(raw).sets).toEqual([])
    }
  })
  it("drops malformed sets but keeps valid ones", () => {
    const doc = normalizeResources({ version: 1, sets: [
      { id: "s1", name: "Inter", enabled: true, links: [{ rel: "preconnect", href: "https://a.example" }] },
      { name: "No id" }, "nonsense", null,
    ]})
    expect(doc.sets.map((s) => s.id)).toEqual(["s1"])
  })
  it("defaults enabled to true when absent", () => {
    const doc = normalizeResources({ sets: [{ id: "s1", name: "X", links: [] }] })
    expect(doc.sets[0].enabled).toBe(true)
  })
})

describe("set edits", () => {
  const base = normalizeResources({ version: 1, sets: [
    { id: "s1", name: "Inter", enabled: true,  links: [] },
    { id: "s2", name: "Analytics", enabled: false, links: [] },
  ]})

  it("toggleSet flips only the named set", () => {
    const out = toggleSet(base, "s2")
    expect(out.sets.find((s) => s.id === "s2")!.enabled).toBe(true)
    expect(out.sets.find((s) => s.id === "s1")!.enabled).toBe(true)
  })

  it("toggleSet returns the same document for an unknown id, and never mutates", () => {
    const before = JSON.stringify(base)
    expect(toggleSet(base, "nope")).toBe(base)
    toggleSet(base, "s1")
    expect(JSON.stringify(base)).toBe(before)
  })

  it("addSet appends with a fresh id, and refuses a duplicate name", () => {
    const { doc, id } = addSet(base, "Display")
    expect(doc.sets).toHaveLength(3)
    expect(doc.sets[2].id).toBe(id)
    expect(doc.sets[2].enabled).toBe(true)
    // Refusal is by identity plus an empty id — the same contract createGroup
    // has, so the caller reads "nothing happened" the same way.
    const dup = addSet(doc, "  inter  ")
    expect(dup.doc).toBe(doc)
    expect(dup.id).toBe("")
  })

  it("addSet refuses a blank name", () => {
    expect(addSet(base, "   ").doc).toBe(base)
  })

  it("removeSet drops exactly one set", () => {
    const out = removeSet(base, "s1")
    expect(out.sets.map((s) => s.id)).toEqual(["s2"])
    expect(removeSet(base, "nope")).toBe(base)
  })

  // The server's caps, mirrored (see this task's Interfaces). Without these the
  // UI happily builds a document `resources::validate` refuses, and the user
  // meets the refusal at Save with no way to see which row caused it.
  it("addSet refuses at the set cap", () => {
    const full = normalizeResources({ version: 1, sets:
      Array.from({ length: MAX_SETS }, (_, i) => ({ id: `s${i}`, name: `S${i}`, enabled: true, links: [] })) })
    expect(addSet(full, "One more").doc).toBe(full)
    expect(addSet(full, "One more").id).toBe("")
  })

  it("addSet refuses a name past the server's limit", () => {
    expect(addSet(base, "x".repeat(MAX_SET_NAME + 1)).doc).toBe(base)
    expect(addSet(base, "x".repeat(MAX_SET_NAME)).doc).not.toBe(base)
  })

  it("appendLinks stops at the per-set cap and reports what it skipped", () => {
    const link = (href: string) => ({ rel: "stylesheet", href, crossorigin: false, isScript: false, isAsync: false })
    const full = normalizeResources({ version: 1, sets: [{ id: "s1", name: "X", enabled: true,
      links: Array.from({ length: MAX_LINKS_PER_SET }, () => link("https://a.example")) }] })
    const out = appendLinks(full, "s1", [link("https://b.example")])
    expect(out.added).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.doc).toBe(full)
    // With room it takes what fits and says so.
    const partial = appendLinks(base, "s1", [link("https://c.example"), link("https://d.example")])
    expect(partial.added).toBe(2)
    expect(partial.skipped).toBe(0)
    expect(partial.doc.sets.find((s) => s.id === "s1")!.links).toHaveLength(2)
  })
})

describe("parsePastedLinks", () => {
  it("parses the Google Fonts triple", () => {
    const links = parsePastedLinks(`
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">
    `)
    expect(links).toHaveLength(3)
    expect(links[1].crossorigin).toBe(true)
    expect(links[2].rel).toBe("stylesheet")
  })
  it("picks up a script tag, and carries NO href", () => {
    const [l] = parsePastedLinks('<script src="https://cdn.example/x.js" async></script>')
    expect(l.isScript).toBe(true)
    expect(l.script).toBe("https://cdn.example/x.js")
    // The wire contract, and the reason it is asserted rather than trusted:
    // the server refuses a link carrying BOTH url fields, and an EMPTY STRING
    // counts as carried (`""` is present, not absent). Emitting `href: ""`
    // beside a script would be refused with a message naming a cause the
    // caller never intended. Assert absence, not emptiness.
    expect(l.href).toBeUndefined()
    expect(l.rel).toBeUndefined()
  })

  it("a link shape carries NO script field, for the same reason", () => {
    const [l] = parsePastedLinks('<link rel="stylesheet" href="https://ok.example/x.css">')
    expect(l.isScript).toBe(false)
    expect(l.script).toBeUndefined()
  })
  it("ignores anything that is not a link or script", () => {
    expect(parsePastedLinks("<div>hello</div><p>rel=\"stylesheet\"</p>")).toEqual([])
  })
  it("does not reject unsafe urls itself — validation is the server's job", () => {
    // The client must not silently drop what the user pasted; the server
    // refuses it with a message the user can act on. Parse only.
    expect(parsePastedLinks('<link rel="stylesheet" href="javascript:alert(1)">')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Implement `src/lib/resources.ts`** to satisfy them, mirroring `design-layout.ts`'s tolerant-parse style. `parsePastedLinks` is a small regex pass over `<link …>` and `<script …>` tags, reading `rel`, `href`, `src`, `crossorigin`, `async`. It parses and does not judge — the cap lives in `appendLinks`, which is the only thing that puts pasted links into a document, so the two concerns stay separable and each is testable on its own.

- [ ] **Step 3: Write `resource-editor.tsx`**, modelled on `token-editor.tsx`: it loads `styles/resources.json` through the same client the TokenEditor uses, renders each set as a row with a toggle and its links, lets a set be added (with a name) or removed, and offers a paste box that calls `appendLinks(doc, setId, parsePastedLinks(text))` — appending through the capped helper rather than splicing the parse result in directly, and reporting `skipped` when the set was full. Saving writes the document back via the same operator file endpoint. **On a rejected save, show the server's message** — validation refusals are the user's feedback that a URL was not https, and swallowing them would leave a dead button.

- [ ] **Step 4: Mount it** in the Tokens tab, below the token editor, since both are "how this project looks".

- [ ] **Step 5: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test` — type-check and tests only. **Do not run `npm run build`**: it publishes the app, and Task 9 owns the plan's single held publish, backend first.

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/resources.ts v2_fe/src/lib/resources.test.ts \
        v2_fe/src/lib/design-api.ts \
        v2_fe/src/pages/design/resource-editor.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): resource-set editor with paste-a-snippet import"
```

---

### Task 9: Verification — local stack, and the held publish

**Files:** none expected; any fix found gets its own commit.

- [ ] **Step 1: Point a local backend at a COPY of the dev database** (never the live one) and confirm the schema is current.

```bash
cd /home/dalmas/E/projects/local_task_tracker/backend
cp backend.db /tmp/tf-phase5.db
UMBRAL_DATABASE_URL="sqlite:///tmp/tf-phase5.db?mode=rwc" cargo run -- migrate
UMBRAL_DATABASE_URL="sqlite:///tmp/tf-phase5.db?mode=rwc" cargo run -- serve
```

- [ ] **Step 2: Verify the fonts actually load** — the load-bearing claim of this phase. Add a Google Fonts set in the editor, enable it, and confirm **in the browser's network panel** that the CSS and the font files are fetched (i.e. not CSP-blocked). A tag that appears in the DOM but whose request was refused is precisely the failure the composer's own comment records, so DOM presence is not evidence.

- [ ] **Step 3: Verify the rest —** labels (rename, reload, persists, and the label appears in every arrangement); the four actions (reload affects only its board; open-in-new-tab; duplicate; remove); a seen page stays loaded after scrolling far away and back; a disabled set emits nothing; a `javascript:` URL is refused with a message.

- [ ] **Step 4: Run both suites and the build.**

Run: `cd backend && cargo test --workspace` then `cd ../v2_fe && npm test && npm run build`

- [ ] **Step 5: Publish — backend first.** Per the measured constraint: the frontend must not go out before the backend, or the realtime handshake 403s app-wide. **This step waits for the user's go-ahead; it is not executed by the implementer.**

---

---

### Task 10: Backend — fix the href rewriter so page links navigate correctly

**Files:**
- Modify: `backend/plugins/taskflow-design/src/composer.rs`
- Create: `backend/plugins/taskflow-design/tests/composer_links.rs`
- **Modify:** `backend/plugins/taskflow-design/src/manifest.rs` — **only** to correct the stale doc comment noted below, if you touch it at all

**Interfaces:**
- Consumes: the manifest's route list — `DesignManifest.routes: Vec<RouteEntry>`, each with a `path`.
- Produces: **no new public function.** `compose_body_fragment` gains a `routes: &[String]` parameter, and the private `rewrite_hrefs` gains the same. Everything else keeps its present signature.

**The mechanism already exists. This task fixes it; it does not build it.** `compose_body_fragment` (`composer.rs:212-216`) already runs `rewrite_hrefs(fragment, "/s/{token}")` over every page body, and has since an earlier phase — its doc comment says exactly why: *"Rewrite sandbox-relative hrefs to tokenized URLs so `<a href="/settings">` navigates natively inside the frame — no router needed."* So `<a href="/app">` **already** becomes `/s/{token}/app`, the click is **already** a real navigation inside the iframe, and the frame **already** has its own session history for back/forward and `history.back()`. **The spec's §F premise — that a page's own links go nowhere — is wrong**, and an implementer who builds from that premise will write a second rewriter that never runs. What this task's value actually is: the three defects the existing pass has.

| Defect in `rewrite_hrefs` today | What it does now | What it must do |
|---|---|---|
| **Any** path-shaped href is rewritten | `/not-a-page` → `/s/{token}/not-a-page` — a 404 wearing a plausible URL | rewrite **only** a path that matches a manifest route |
| `mailto:` / `tel:` fall into the relative branch | `mailto:a@b.c` → `/s/{token}/mailto:a@b.c` — **a mail link is broken today** | leave them byte-identical |
| `target="_blank"` is ignored | a new-tab link is hijacked into the frame | leave it alone: the markup asked for a new tab |

**Why this must EXTEND `rewrite_hrefs` rather than add a parallel pass.** A second `rewrite_page_links` pass wired after the first would never see a route-shaped href — the first pass has already turned `href="/app"` into `href="/s/tok/app"` — so the route-membership rule would be dead code whose unit tests pass while the served page is unchanged. That is the silent-no-op shape this phase has hit three times already (`check_extension`, the bulk-signal bridge, the unread `routeOrder`). **One pass, one place.**

- [ ] **Step 1: Write the failing tests** — `tests/composer_links.rs`, **through `compose_body_fragment`**

Test the function the server actually calls. A test of a private helper could pass while the live pipeline was untouched — which is the failure mode this whole task exists to avoid.

```rust
use taskflow_design::composer;

fn routes() -> Vec<String> {
    ["/", "/app", "/settings"].iter().map(|r| r.to_string()).collect()
}

/// Compose through the REAL pipeline. It also stamps `data-src` and expands
/// `<ui-*>` primitives, so assert containment, never whole-string equality.
fn body(fragment: &str) -> String {
    composer::compose_body_fragment("tok", "pages/index.html", fragment, &routes())
}

#[test]
fn a_link_to_a_known_route_becomes_a_sandbox_url() {
    let out = body(r#"<a href="/app" class="btn">Open</a>"#);
    assert!(out.contains(r#"href="/s/tok/app""#), "{out}");
    assert!(out.contains(r#"class="btn""#), "other attributes survive: {out}");
}

#[test]
fn the_root_route_maps_to_the_bare_sandbox_url() {
    // The client's `sandboxUrl` drops the path for "/" (`design-api.ts:18`) and
    // the server serves BOTH `/s/{token}` and `/s/{token}/` (`views.rs:808-812`),
    // so assert the exact form: `/s/tok/` CONTAINS `/s/tok`, and a `contains` on
    // the bare form alone would pin nothing.
    let out = body(r#"<a href="/">Home</a>"#);
    assert!(out.contains(r#"href="/s/tok""#), "{out}");
    assert!(!out.contains(r#"href="/s/tok/""#), "must be the bare form: {out}");
}

#[test]
fn hrefs_that_are_not_pages_are_left_alone() {
    // Each of these is broken by today's pass — `mailto:`/`tel:` worst of all.
    for (html, expected) in [
        (r#"<a href="https://example.com/x">ext</a>"#, r#"href="https://example.com/x""#),
        (r#"<a href="//cdn.example/x">proto-relative</a>"#, r#"href="//cdn.example/x""#),
        (r#"<a href="mailto:a@b.c">mail</a>"#, r#"href="mailto:a@b.c""#),
        (r#"<a href="tel:+1">tel</a>"#, r#"href="tel:+1""#),
        (r#"<a href="#section">anchor</a>"#, r#"href="#section""#),
        (r#"<a href="/not-a-page">not a page</a>"#, r#"href="/not-a-page""#),
        (r#"<a href="app">relative</a>"#, r#"href="app""#),
    ] {
        let out = body(html);
        assert!(out.contains(expected), "must be untouched: {html} gave {out}");
    }
}

#[test]
fn a_new_tab_link_is_left_alone() {
    let out = body(r#"<a href="/app" target="_blank">Open</a>"#);
    assert!(out.contains(r#"href="/app""#), "{out}");
}

#[test]
fn several_links_in_one_fragment_are_all_rewritten() {
    let out = body(r#"<a href="/app">a</a><a href="/settings">b</a><a href="https://x.example">c</a>"#);
    assert_eq!(out.matches("/s/tok/").count(), 2, "{out}");
}
```

A relative href (`href="app"`) is deliberately left alone: inside a frame at `/s/tok/` or `/s/tok/settings` it already resolves to `/s/tok/app`, so it works today and needs nothing.

- [ ] **Step 2: Run to verify they fail.** The `mailto:` and `tel:` cases and the `target="_blank"` case must fail against today's code; the known-route and several-links cases should already pass, which is the evidence that the mechanism exists.

- [ ] **Step 3: Extend `rewrite_hrefs`** — change its signature and its rules; add no second pass.

```rust
/// Rewrite a sandbox-relative href to a tokenized URL so a click navigates
/// natively inside the frame — no router needed.
///
/// That is the whole mechanism behind in-device navigation: because the click
/// becomes a real navigation inside the iframe, the frame gets its own session
/// history, and back/forward — and an agent-written `history.back()` — work with
/// nothing further built.
///
/// Deliberately conservative, because a rewrite that is wrong turns a link that
/// works into one that does not:
///   * only a site-absolute path that MATCHES A MANIFEST ROUTE is rewritten —
///     `/not-a-page` is left alone, since a 404 under a plausible URL is worse
///     than the dead link the author wrote;
///   * an empty href, `#fragment`, `//protocol-relative`, anything with a
///     `scheme:` prefix (`http:`, `mailto:`, `tel:`, and by construction
///     `javascript:`/`data:`), and a plain relative path are all returned
///     byte-identical — note a relative path already resolves correctly inside
///     the frame, so it needs no help;
///   * a `target="_blank"` link is left alone: the markup asked for a new tab.
fn rewrite_hrefs(html: &str, base: &str, routes: &[String]) -> String
```

Keep the existing character-walk shape; keep the `!href.starts_with("/s/")` guard so an already-tokenized href is never rewritten twice; add the route-membership test and the `target="_blank"` check on the tag. Keep the helper small and in this file, beside the code it belongs to.

- [ ] **Step 4: Thread the routes through `compose_body_fragment`.** It gains `routes: &[String]` and passes them down. It has exactly **one** caller — `compose_document` (`composer.rs:237`) — which has `manifest` in scope, so it computes the list once and passes it.

**Do NOT touch the export path.** `compose_export_body` (`composer.rs:352`) deliberately does *not* rewrite hrefs, and its doc comment says why: *"a portable export must carry no sandbox-only cruft."* Rewriting there would stamp the short-lived sandbox **token** into a file the user downloads and may share, and turn a link that at least resolves locally into a URL that means nothing off the server. **The spec's sentence about the export carrying working links is wrong; the export keeps its current behaviour.** While you are in the file, note that `compose_body_fragment`'s own doc comment claims it is shared with the `page.html` export — it is not, and correcting that comment is welcome but optional.

- [ ] **Step 5: Run the suite and commit**

Run: `cd backend && cargo test --workspace`

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/composer.rs \
        backend/plugins/taskflow-design/tests/composer_links.rs
git commit -m "fix(design): only rewrite hrefs that match a real route, and stop breaking mailto:"
```

---

### Task 11: Frontend — show where a frame actually is, with a reset

**Files:**
- Modify: `backend/plugins/taskflow-design/src/composer.rs` (the sandbox runtime)
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`, `v2_fe/src/pages/design/DesignSurfacePage.tsx`

**Interfaces:**
- Consumes: the navigation from Task 10.
- Produces: a `design:route` postMessage from the frame carrying its current path, and a board header that renders it.

- [ ] **Step 1: Have the frame report its route.** In the composer's system-owned runtime (the same script that already posts `design:ready`/`design:select`), post the current path on load **and** on history changes:

```js
// Report where this frame currently is. A page navigated by its own links is
// showing a DIFFERENT page than the board was created for, and the chrome must
// not keep claiming the old one.
var announce = function () { parent.postMessage({ type: 'design:route', path: location.pathname }, '*') }
// `pageshow`, NOT `load`. A Back or Forward that the browser satisfies from the
// back/forward cache restores the document WITHOUT firing `load` — and a Back is
// precisely the interaction this whole task exists for, so `load` would leave
// the header claiming the old route at the one moment it matters. `pageshow`
// fires on a normal load as well (with `persisted: false`), so it subsumes
// `load` rather than supplementing it.
addEventListener('pageshow', announce)
// A same-document history change (pushState/replaceState) fires neither of the
// above; an agent-authored page that routes in JS would otherwise go unreported.
addEventListener('popstate', announce)
```

The path is the sandbox path (`/s/{token}/app`), so strip the `/s/{token}` prefix before reporting — report `/app`, and `/` for the bare sandbox root.

The event choice is load-bearing rather than stylistic, and there is a reason to prefer `pageshow` over the `load` it replaces beyond correctness: `pageshow` fires *after* `load` on a normal navigation too, so a frame reports once per navigation either way, but only `pageshow` covers the restore path.

- [ ] **Step 2: Track it per board.** `DesignCanvas` keeps `Map<boardKey, string>` of reported routes, updated from the existing message listener (which already validates `event.source` against a board before trusting anything — keep that discipline: **only accept a route from a frame that maps to a known board**, and ignore anything else).

  **There are two `message` listeners in this tree and only one of them validates the source.** The one to extend is `design-canvas.tsx:228`, which matches the sender against a board (`(b) => b.key === (event.source as Window | null)?.name`) — that is the discipline to keep. The other (`design-canvas.tsx:690`) handles `design:ready` with **no** source check at all. A route report is navigational state derived from a frame's URL, so it belongs with the validated listener; adding it to the unvalidated one would let any window on the page move a board's header.

- [ ] **Step 3: Render it.** `ArtboardHeader` shows the board's own route normally. When the reported route differs, it shows the current one distinctly (e.g. `→ /app`) plus a **reset** control that returns the frame to the board's route by remounting it — the same per-board epoch mechanism Task 4 built, so a reset reloads one frame and nothing else.

- [ ] **Step 4: Verify and commit.** `npm test` — **not the build** (Task 9 owns the plan's single held publish, backend first). Visual verification is Task 9's job.

---

### Task 12: Tell agents how to link and go back

**Files:**
- Modify: the agent-facing context (`backend/plugins/taskflow-design/src/agent_views.rs`) and/or the primitives catalogue the agent reads

**Interfaces:**
- Consumes: Tasks 10 and 11.
- Produces: agent-visible guidance.

**Why this is a task and not a footnote:** the user asked for it explicitly — *"we need to tell the agent how to write a go back function"*. Cross-page links did not work before, so an agent's existing habit is to avoid them; shipping the capability without saying so leaves the gap open in practice.

- [ ] **Step 1: Add the guidance** to whatever the agent reads when writing pages, in the register of the surrounding text:

```
Links between pages
  Use a plain <a href="/route"> for any route in the manifest — e.g.
  <a href="/app">. The composer rewrites it to the sandbox URL, so the click
  navigates the preview frame and the browser's back/forward work.

  A back control is just:
      <button onclick="history.back()">Back</button>
  The frame keeps its own history, so this works with no extra wiring.

  Do NOT hand-write sandbox URLs, and do not use target="_blank" for
  in-project links — a new tab leaves the frame and loses its history.
```

- [ ] **Step 2: Verify the text lands where the agent reads it** — check it appears in the context response, not merely in the source.

- [ ] **Step 3: Commit.**

---

## Deferred / not in this plan

Items 1–7 are all now planned above. The following remain deliberately out.

- **Item 5, the pan→select scroll freeze — a SPIKE, not a task.** Its leading theory was falsified by the user's own observation (they can highlight text, so frames do receive pointer events). Reproduce on the local stack, report the cause, and return for a decision. **No fix is written under this plan.** Re-check it *after* Task 3, since latching frames changes how many are alive.
- **The realtime suffix drift guard** was declined by the user previously; still not added. Note for the record that the failure mode is worse than assumed: a mismatch 403s the whole handshake, not one silent group.
- **Renaming a page's real title** — the user chose a display label.
- **Group rename/delete** — groups remain create-only from Phase 4; `removeGroup` still has no caller.
- **Per-board rotation for laptops and breakpoints** — ruled out deliberately; `landscapeVariant` returns null there and the Rotate control is disabled with an explanation.
