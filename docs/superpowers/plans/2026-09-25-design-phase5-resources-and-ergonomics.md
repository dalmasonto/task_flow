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
- **A Rust test fixture containing `"#` needs `r##"…"##`, not `r#"…"#`.** A `r#"…"#` literal closes at the *first* `"#`, so `r#"<a href="#section">…"#` ends at `href="#` and the line does not compile. This bit a brief in this plan and cost an implementer a round; check any fixture whose markup contains a fragment anchor.

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
fn the_widening_reaches_the_fetch_directives_and_stops_there() {
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
    // Needs a second FALSE set, or this cannot fail. Written first against
    // `base` — where `s1` is already `true` — the assertions were "s2 became
    // true, s1 stayed true", which an implementation that forces EVERY set
    // enabled satisfies. The false pin is the half with teeth. (This is the
    // fourth instance of that shape in this phase; the signature is always the
    // same — the assertion is phrased against a state that is already true.)
    const both = normalizeResources({ version: 1, sets: [
      { id: "s1", name: "Inter", enabled: false, links: [] },
      { id: "s2", name: "Analytics", enabled: false, links: [] },
    ]})
    const out = toggleSet(both, "s2")
    expect(out.sets.find((s) => s.id === "s2")!.enabled).toBe(true)
    expect(out.sets.find((s) => s.id === "s1")!.enabled).toBe(false)
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

**Run this LAST — after Tasks 10, 11, 12 and 13 — even though it is numbered 9.** It is the phase's verification and its publish, so it belongs at the end; the number predates the navigation work being appended around it, and Tasks 11 and 13 both say "visual verification is Task 9's job", which is only true if Task 9 runs after them. Running it in numeric order would leave the entire navigation tranche — in-device links, history, the route header, the media policy — verified by nobody.

**Files:** none expected; any fix found gets its own commit.

- [ ] **Step 1: Bring up the local stack** — a backend pointed at a COPY of the dev database (never the live one), and a frontend the browser can actually load.

```bash
cd /home/dalmas/E/projects/local_task_tracker/backend
cp backend.db /tmp/tf-phase5.db
UMBRAL_DATABASE_URL="sqlite:///tmp/tf-phase5.db?mode=rwc" cargo run -- migrate
UMBRAL_DATABASE_URL="sqlite:///tmp/tf-phase5.db?mode=rwc" cargo run -- serve
```

Then, in a second shell, **`cd v2_fe && npm run dev`** — the dev server, *not* `npm run build`. Steps 2 and 3 need a browser, so a served frontend is required; the build is the publish and stays Step 5.

**The port has to line up in three places, and it already does — check it rather than assuming.** The backend's default bind is `127.0.0.1:8000` (`umbral-core/src/settings.rs:192`), `vite.config.ts:43` proxies `/api`, `/oauth`, `/media`, `/openapi` and `/realtime` to `VITE_API_PROXY_TARGET ?? http://localhost:8000`, and `v2_fe/.env.local` sets `VITE_SANDBOX_ORIGIN=http://localhost:8000`. Two consequences worth knowing before you debug a blank artboard:

- **`/s/` is not in the proxy list**, deliberately: `VITE_SANDBOX_ORIGIN` is an absolute URL, so every frame loads straight from the backend origin rather than through the dev server. If that variable were unset, `sandboxUrl` would fall back to `API_BASE_URL` and the frames would resolve against the dev server instead — which is the failure to look for first if artboards come up empty.
- **Leave `TASKFLOW_CORS_ALLOWED_ORIGINS` unset.** `src/main.rs:93-98` documents why: unset adds no CORS layer at all, "which keeps same-origin dev behavior byte-identical" — local dev is only same-origin *because* it goes through the proxy.

- [ ] **Step 2: Verify the fonts actually load** — the load-bearing claim of this phase. Add a Google Fonts set in the editor, enable it, and confirm **in the browser's network panel** that the CSS and the font files are fetched (i.e. not CSP-blocked). A tag that appears in the DOM but whose request was refused is precisely the failure the composer's own comment records, so DOM presence is not evidence.

- [ ] **Step 3: Verify the rest —** labels (rename, reload, persists, and the label appears in every arrangement); the four actions (reload affects only its board; open-in-new-tab; duplicate; remove); a seen page stays loaded after scrolling far away and back; a disabled set emits nothing; a `javascript:` URL is refused with a message.

  **Plus Task 13's claim, which is visual and cannot be checked any other way:** an external `https:` image actually renders inside a frame, and a plain `http:` one does not. The negative half is what proves the widening was a *scheme source* and not `*` — a policy that allowed everything would pass the positive half just as well.

- [ ] **Step 3b: Verify the navigation tranche (Tasks 10-12), which nothing else checks.** Each of these is a behaviour whose absence looks like a design choice rather than a bug, so check them explicitly and in a real browser:

  - a link to a **known** route navigates the frame (`<a href="/app">` from another page);
  - a link to a path that is **not a page** does nothing — it must not become a sandbox URL that 404s;
  - **`mailto:` and `tel:` links still work**, since the rewriter used to break them;
  - **back and forward work inside the frame**, and an agent-written `history.back()` returns — including a Back that the browser serves from the back/forward cache, which is why the frame reports on `pageshow` rather than `load`;
  - a board whose frame has navigated **shows the route it is actually displaying**, with a reset that returns it to the board's own route and reloads only that frame;
  - a `target="_blank"` link opens a new tab rather than being hijacked into the frame;
  - and the **agent-facing guidance** from Task 12 is actually served to an agent — read it back out of the context response, not out of the source, because a guidance string that is written but never served looks exactly like a capability that was delivered.

- [ ] **Step 3c: Verify Task 15's two browser-only fixes, since no unit test can.** Both came from the deployed app and both need a real frame and a real pointer.

  - **inspect delivers a selection** — turn inspect on, click an element inside a frame, confirm the panel receives it. Open the console first: the original failure was an uncaught `SecurityError` at `Array.find`, and its symptom (nothing happens) is identical to a dozen other causes.
  - **the highlight clears and does not fill the frame** — hover inside one board, then move to the next; the first board must not keep a box behind. Then hover the page background: nothing should be drawn, and in particular no full-frame rectangle.

  ⚠️ **Do not verify the leave-clear half through Chrome under CDP — it will report a false failure.** Task 15's implementer measured this: Chrome driven by CDP delivers **no cross-frame pointer-leave at all**, so the frame's `:hover` state stays stale and the box looks identical before and after the fix, in both the old and the new runtime. A Playwright-driven check would therefore "fail" a fix that works. It verified this half in **Firefox**, which does perform real pointer transitions (`mouseout` with `relatedTarget=null` arrives; the box stays pre-fix and clears post-fix). So: verify the leave-clear in Firefox, or by hand with a real mouse. The inspect half is fine under CDP — that one was reproduced there.

- [ ] **Step 4: Run both suites.**

Run: `cd backend && cargo test --workspace` then `cd ../v2_fe && npx tsc -b && npm test`

- [ ] **Step 5: Publish — backend first, and the build comes after it.** Per the measured constraint: the frontend must not go out before the backend, or the realtime handshake 403s app-wide. So this step is ordered, not parallel: **the backend deploy happens first, and `npm run build` — the plan's single build — only after it**, on the user's go-ahead. Their words were "deploy the backend first, then I build".

  This is the reason Step 4 runs `npx tsc -b && npm test` and *not* `npm run build`: the build is the publish in this repo, and running it here would put the new frontend in front of the user before the backend exists to serve it. **This step is not executed by the implementer; it waits.**

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
        (r##"<a href="#section">anchor</a>"##, r##"href="#section""##),
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

- [ ] **Step 2: Track it per board.** `DesignCanvas` keeps `Map<boardKey, string>` of reported routes, updated from the existing message listener (which already validates the sender against a board before trusting anything — keep that discipline: **only accept a route from a frame that maps to a known board**, and ignore anything else).

  🛑 **This step previously named `event.source.name` as "the discipline to keep". That is the bug, not the discipline, and obeying it would re-introduce a user-reported crash.** *(Corrected 2026-09-25, before this task was ever dispatched. The old text read: "The one to extend is `design-canvas.tsx:228`, which matches the sender against a board (`(b) => b.key === (event.source as Window | null)?.name`) — that is the discipline to keep.")*

  The sandbox is a **different origin** in every deployment, so **reading any property off `event.source` throws**:

  ```
  Uncaught SecurityError: Failed to read a named property 'name' from 'Window':
  Blocked a frame with origin "https://taskflow.supercodehive.com" from accessing
  a cross-origin frame.
  ```

  That throw escaped the whole `onMessage` handler, so **inspect had never worked cross-origin at all** — it is the first half of the user's own bug report. The matching was rewritten by Task 15 to compare **WindowProxy references**, which is allowed across origins, and the pattern is now banned in a doc comment of its own (`design-frame-source.ts`: *"never 'solve' this by matching `event.source.name` against a board key again, however right the `name={board.key}` on the iframe makes it look"*).

  **So the discipline to keep is the current one, and it lives at `design-canvas.tsx:353-361`:** `boardKeyForSource(frameSources(), event.source as Window | null)` — identity in, board key out. **Never read a property off `event.source`.** If you find yourself wanting `name`, or thinking the `name={board.key}` on the iframe makes it cheap, read `design-frame-source.ts` first.

  **There are still two `message` listeners and only one validates the sender.** The one to extend is the identity-checked one (`:353-361`). The other (`:848-856`, which was `:690` before Task 27's work moved it) handles `design:ready` with **no** source check at all. A route report is navigational state derived from a frame's URL, so it belongs with the validated listener; adding it to the unvalidated one would let any window on the page move a board's header.

- [ ] **Step 3: Render it.** `ArtboardHeader` shows the board's own route normally. When the reported route differs, it shows the current one distinctly (e.g. `→ /app`) plus a **reset** control that returns the frame to the board's route by remounting it — the same per-board epoch mechanism Task 4 built, so a **reset reloads one frame and nothing else**.

  ⚠️ **Bump the PER-BOARD half only.** *(Added 2026-09-25, after Task 27 changed this machinery.)* The epoch a frame now keys on is `epoch={contentEpoch + boardEpoch}` — **two halves summed**, and the global half is no longer a raw per-event counter: Task 27 made it a coalesced commit-on-settle value so that one file write remounts every board **once per burst** instead of once per event, which is what made responsive review sluggish. Resetting a board by moving the global half would remount every board at every device — **reintroducing exactly the cost Task 27 removed** — and, because that half is now settle-gated, it would not even do so predictably. The per-board half is the one a single-board reset owns.

- [ ] **Step 4: Verify and commit.** `npm test` — **not the build** (Task 9 owns the plan's single held publish, backend first). Visual verification is Task 9's job.

---

### Task 12: Tell agents how to link, go back, and use external media

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

Add the media half as a second block in the same register. Task 13 widens the policy; without this, an agent's habit stays "static SVG only", which is the gap the user reported:

```
Images, video and motion
  External https images and media work:
      <img src="https://cdn.example/hero.png" alt="…">
      <video src="https://cdn.example/clip.mp4" controls></video>
  That covers sprite sheets and CSS background-image from an https origin.
  Plain http is refused, and inline data:/blob: URIs still work for small
  assets. Motion no longer has to be CSS/SVG/inline — a video is a real
  option — though CSS and SVG animation are still the default for interface
  motion.

  A Lottie animation works, but NOT by putting <script src> in a page: page
  fragments may not contain one, and the server refuses that markup. Write a
  COMPONENT instead — in the sandbox a component is a same-origin script, and
  the player it appends from a CDN is allowed by script-src.

  Pass the animation data INLINE in that component (lottie's animationData),
  because there is nowhere to store it as a file: assets/ accepts image
  extensions only, and styles/ accepts only tokens.css, tokens.json and
  resources.json.
```

- [ ] **Step 1b: Do not let this become a dead sentence.** Whichever surface you add it to, the check in Step 2 is the same and it now covers the media text too — a guidance string that is written but never served is worse than none, because it looks like the capability was delivered.

- [ ] **Step 2: Verify the text lands where the agent reads it** — check it appears in the context response, not merely in the source.

- [ ] **Step 3: Commit.**

---

### Task 13: Backend — let external images and media load, and stop leaking the token to them

**Files:**
- Modify: `backend/plugins/taskflow-design/src/composer.rs` (`sandbox_csp`)
- Modify: `backend/plugins/taskflow-design/src/views.rs` (`apply_sandbox_headers`)
- Modify: `backend/plugins/taskflow-design/tests/resources.rs` (the CSP test)

**Interfaces:**
- Consumes: nothing from earlier tasks; the CSP test Task 7 built is the one to extend.
- Produces: nothing new. Two widened directives in an existing function, and one added response header.

**Why this is small — and why it is not §E.** A font is *declared* in the head, so §E needed a document, a validator, an editor and an emitter. An image or a video is *referenced* by the page's own markup, so there is nothing to store and nothing to toggle: the policy is the only blocker. Verified by reading `validate_page_fragment` (`validation.rs:318-474`), which has **no attribute-level URL rules at all** — `<img src="https://…">` and `<video src="https://…">` already pass validation today. **Do not build a document, a model or a UI for this.**

- [ ] **Step 1: Extend the CSP test first**

`tests/resources.rs` already has the CSP test — now named `the_widening_covers_the_five_resource_directives_and_stops_at_connect_src` (it was `…_reaches_the_three_fetch_directives_and_stops_there` before this task added two). It parses the policy into a directive map and asserts values per directive. **As shipped, all five directives are pinned exactly** — the original three gained exact pins in this task's fix round, because until then they were checked by token membership only and a *broadened* value (`script-src … https: *`) passed both tests. Extend it in that shape.

```rust
    // Unchanged — the ORIGINAL loop, kept for the reason above.
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

    // The two new load directives, held to the same rule.
    for directive in ["img-src", "media-src"] {
        let value = directives.get(directive).copied().unwrap_or_default();
        assert!(
            value.split_whitespace().any(|src| src == "https:"),
            "{directive} must allow any https origin, or the design layer cannot show a real image: {csp}"
        );
    }
```

```rust
    assert_eq!(directives.get("img-src").copied(), Some("'self' data: blob: https:"));
    assert_eq!(directives.get("media-src").copied(), Some("'self' data: blob: https:"));
```

An earlier draft of this step carried the five-directive loop *as* the replacement, and the implementer kept the original instead — proven by mutation: under the replacement, dropping jsdelivr from `style-src` fails nothing. That is recorded here because the next person editing this test will otherwise make the same simplification for the same plausible reason.

The existing `connect-src` assertion must keep passing unchanged — it stays `'self' https://cdn.jsdelivr.net`, and that is the point of the next step's comment.

- [ ] **Step 2: Add a test for the referrer header**

`apply_sandbox_headers` (`views.rs:697`) is private, so test it through the real route: boot the app, seed a project, `app.get_sandbox(&format!("/s/{token}/"))`, and assert the response carries `referrer-policy: no-referrer` next to the `x-robots-tag: noindex` it already sets. `tests/phase1_storage_composer.rs` has the harness pattern (`TestApp`, `seed_minimal_project`). If that is heavier than the task wants, a focused test in the resources file is fine — but say which you chose and why.

- [ ] **Step 3: Make the change**

In `sandbox_csp` (`composer.rs`), two directives change and one is added:

```
img-src 'self' data: blob: https:; \
media-src 'self' data: blob: https:; \
```

Keep `default-src 'self'`, `connect-src 'self' https://cdn.jsdelivr.net`, `form-action 'none'`, `base-uri 'none'` and `frame-ancestors *` **byte-identical**.

Then add `Referrer-Policy: no-referrer`. **As shipped it is set by a helper, `apply_token_response_headers`, called by `apply_sandbox_headers` and by both branches of `serve_file`** — the file route needed it too, since a `url(https://…)` inside a served stylesheet is governed by *that* response's headers, and a legacy hand-authored `styles/tokens.css` row can carry one.

**The reason, corrected — the first version of this step overstated it.** It said the font widening "already leaks the token to the font origins" and that images would leak it "to every image host a page references". Neither was true: the framework's default security-headers layer (`vendor/umbral-core/src/app.rs:1925-1945`) already set `strict-origin-when-cross-origin` with `set_if_absent`, and under that default a cross-origin request carries the **origin only** — no path, no token. The honest reason to set the header is that `no-referrer` is strictly stronger than that default, and a secret living in a URL should not have its safety decided by a framework or browser default. See the spec's §G correction for the full note.

- [ ] **Step 4: Record the reasoning, including why `connect-src` was NOT widened**

Extend the doc comment above `sandbox_csp` rather than starting a new paragraph — it already carries the font widening's bounded rationale (separate origin, no cookies, short-lived read-only token, values supplied by the project's own members), and the same argument covers images and media. Add the two facts a future reader would otherwise have to rediscover:

- that `https:` here is a **scheme source, not `*`** — plain `http:` stays refused, and `data:`/`blob:` stay because inline content is what the design layer already had;
- **why `connect-src` was not widened for Lottie**, because "Lottie does not work" is the sentence that leads the next person to widen it: a Lottie animation is deliverable today without it — the player loads as part of a *component* (inline script, and `script-src https:` already permits the player itself from any https origin), and the animation JSON lives in `assets/`, served same-origin and therefore covered by `connect-src 'self'`.

- [ ] **Step 5: Run the suite and commit**

Run: `cd backend && cargo test --workspace`

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/composer.rs \
        backend/plugins/taskflow-design/src/views.rs \
        backend/plugins/taskflow-design/tests/resources.rs
git commit -m "feat(design): allow external https images and media, and stop leaking the sandbox token to them"
```

---

### Task 14: Frontend — make `DesignComment` honest about the wire

**Files:**
- Modify: `v2_fe/src/lib/design-api.ts` (the `DesignComment` type, and the comment at `:44-51`)
- Modify: `v2_fe/src/pages/design/design-inspector.tsx`
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx`
- Create/extend a colocated `*.test.ts` for whatever pure logic this needs to be testable

**Why this exists:** Task 8's implementer found it while fixing the *same class* of defect in the same file, and the controller verified it at the source. It is not Task 8's defect and Task 8 did not cause it.

- `models::DesignComment` (`backend/plugins/taskflow-design/src/models.rs:115-116`) derives `Serialize` with **no `rename_all`**, and `views::list_comments` returns the rows directly — so the endpoint emits **snake_case**: `page_path`, `component_name`, `element_path`, `src_ref`, `thread_id`, `resolution_note`, `created_at`. The repo's own test reads `rows[0]["resolution_note"]` off that endpoint (`tests/phase3_agent_surface.rs:294-295`), so the wire is pinned by an existing test — it is the frontend type that is wrong.
- The TS type declares camelCase and **six** sites read the broken fields:

| Site | What is broken |
|---|---|
| `design-inspector.tsx:356` | `{c.pagePath}` renders `undefined` — the route label is blank |
| `design-inspector.tsx:361-362` | `c.resolutionNote ?` is always falsy — a resolution note **never** displays |
| `design-inspector.tsx:448` | `.filter((b) => b.route === comment.pagePath)` matches nothing |
| `DesignSurfacePage.tsx:446`, `:544`, `:547` | `artboards.find((b) => b.route === comment.pagePath)` matches nothing — **clicking a comment does not focus its board** |

The last row is the significant one, and the reason this is a task rather than a note: the failure is **silent**. Nothing throws; the click simply does nothing.

- [ ] **Step 1: Write the failing test first, and make it the kind that could have caught this.** The defect is a field-name mismatch, and a TS type cannot be tested at runtime — so the test has to be about *behaviour with a wire-shaped fixture*. Build the fixture the way `readJson` actually yields it, i.e. **snake_case keys**, and assert the values the inspector derives from it. If the reads are inline JSX, extract the two of them (route label, and note-or-null) into small pure helpers and test those — that extraction is what makes the bug catchable, and it is the whole point of the step.

- [ ] **Step 2: Rename the declarations to the wire spelling.** Same shape as Task 8's Fix 1: rename, do **not** add a mapping layer, and extend the convention comment at `design-api.ts:44-51` rather than leaving it to be re-derived. That comment currently says the camelCase reads are "left as found; it is not this round's to rename" — it is now this round's, so it must not be left pointing the other way.

- [ ] **Step 3: Check all six sites**, not just the two the report named. Each of the four `pagePath` comparisons must compare against the real route once renamed.

- [ ] **Step 4: Expect and report three user-visible changes**, because that is what fixing this means: the comment list's route label appears, a resolution note appears where one exists, and clicking a comment starts focusing its board. Say so plainly in the report — a fix that makes a previously-dead control live is worth flagging to whoever tests it, who would otherwise read the new behaviour as a regression.

- [ ] **Step 5: Verify and commit.** `cd v2_fe && npx tsc -b && npm test` — **not the build** (Task 9 owns the plan's single held publish, backend first).

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-api.ts v2_fe/src/pages/design/design-inspector.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "fix(design): comments carry snake_case on the wire, so the inspector was reading nothing"
```

(Stage whichever test file you create as well.)

---

### Task 15: Fix inspect — the cross-origin SecurityError and the highlight that never clears

**Reported by the user from the deployed app**, with a console trace. Two bugs, both confirmed at the source before this task was written.

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx` (the frame message listener, `:220-233`)
- Create a colocated test for the extracted matcher
- Modify: `backend/plugins/taskflow-design/src/composer.rs` (the picker runtime, `PICKER_RUNTIME`)

- [ ] **Step 1: Bug A — inspect delivers nothing, because reading `.name` across origins throws.**

`design-canvas.tsx:228` matches a message's sender like this:

```ts
const board = artboards.find((b) => b.key === (event.source as Window | null)?.name)
```

`event.source` is the sandbox iframe's WindowProxy, and the sandbox is a **different origin** from the app (`SANDBOX_ORIGIN` is the API origin; in production the app is `taskflow.supercodehive.com`). Reading `window.name` on a cross-origin WindowProxy **throws**:

```
Uncaught SecurityError: Failed to read a named property 'name' from 'Window':
  Blocked a frame with origin "https://taskflow.supercodehive.com" from accessing a cross-origin frame.
    at Array.find (<anonymous>)
```

That exception kills the whole `onMessage` handler, so `design:select` is never processed and **inspect does nothing at all**. This is not an edge case: the frames are cross-origin in every deployment, so the feature has never worked there.

**Fix by identity, not by property.** Comparing WindowProxy references is allowed cross-origin; reading their properties is not.

```ts
/// The board key whose frame sent this message, by WindowProxy identity.
/// Reads the iframe's own `name` ATTRIBUTE — our DOM, so `getAttribute` is
/// safe — never the Window's `name` property, which throws across origins.
export function boardKeyForSource<T>(
  frames: { key: string; win: T | null }[],
  source: T | null
): string | null {
  if (!source) return null
  return frames.find((f) => f.win === source)?.key ?? null
}
```

Extracting it this way is deliberate: the repo has no RTL/jsdom, so a pure function over `{key, win}` pairs is the **only** way to get a regression test on the single line that broke inspect. Build the frames from `document.querySelectorAll("iframe[data-design-frame]")` (the existing `mountedFrames()` at `:324`) and read each element's `getAttribute("name")`, which is what `name={board.key}` (`:392`) sets.

Write the test first, with plain objects, and confirm it fails against the current implementation's approach.

- [ ] **Step 2: Bug B — the highlight never clears, and it fills the frame over a container.**

The picker runtime (`composer.rs:28-48`) creates `box` and `label` once and removes them **only** when picking is switched off (`:83`). Two consequences the user reports as one symptom:

- moving out of a frame onto the next board leaves the old box behind — "the highlight box on the previous screen";
- moving the pointer over a **container** (the page's `<main>` or body) computes *that* element's rect, so the box covers the whole frame — "becomes active full on main component".

Fix, both parts:
- clear `box`/`label` on `mouseleave` of the document;
- when the target is `document.body` / `documentElement`, or its rect is empty, **hide** rather than draw.

Leave the rest of the picker alone — capture-phase listeners, `stopImmediatePropagation`, the label's `data-component` lookup, and the `design:mode` off-switch all behave.

- [ ] **Step 3: Do not fake a test for the runtime.** `PICKER_RUNTIME` is a JS string inside Rust; a unit test asserting it *contains* `mouseleave` proves nothing about behaviour and would pass for any edit that kept the word. Browser behaviour in a composed document is verified visually — Task 9's Step 3b is where these two checks belong, and they are added there.

- [ ] **Step 4: Verify and commit.** `cd v2_fe && npx tsc -b && npm test` — **not the build** (Task 9 owns the plan's single held publish).

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-canvas.tsx \
        backend/plugins/taskflow-design/src/composer.rs
git commit -m "fix(design): match frame messages by identity, and clear the pick highlight"
```

(Stage the new test file as well.)

---

### Task 16: Pages panel — groups first, then groupless, numbered 1..N

**Requested by the user:** *"Pages: should start by listing groups if any followed by groupless pages, Pages should be numbered ie 1..N."*

**Files:**
- Modify: `v2_fe/src/pages/design/pages-panel.tsx`
- Create a colocated pure module + test for the ordering/numbering

**Confirmed at the source:** `pages-panel.tsx:78` renders a flat `routes.map(...)` with no grouping and no numbering. Each row already carries a native group `<select>` (`:104-116`) and a `LabelInput`; both stay exactly as they are — the file header explains why they are native.

- [ ] **Step 1: Extract the list as a pure function, and test it first.**

```ts
export type NumberedPage = { route: string; n: number }
export type GroupedPages = {
  groups: { id: string; name: string; pages: NumberedPage[] }[]
  ungrouped: NumberedPage[]
}

/// Pages in DISPLAY order: each group in `layout.groups` order with its pages
/// in manifest order, then everything ungrouped. Numbering runs across the
/// whole displayed sequence, so the number a user reads matches the position
/// they see — a group's pages and the ungrouped tail share one 1..N series.
export function groupedPages(layout: LayoutDoc, routes: RouteEntry[]): GroupedPages
```

Test these, and say what would have to change to make each fail:

- a project with **no groups** returns everything under `ungrouped`, numbered 1..N;
- a project with two groups returns the groups in `layout.groups` order, each with its own pages, then the ungrouped rest;
- **numbering is continuous across the sections** — the first ungrouped page after a group continues the series rather than restarting at 1;
- **a route whose stored grouping references a group that no longer exists** falls into `ungrouped` rather than disappearing. This is the edge worth pinning: `groupOf` walks `layout.groups`, so a stale id is reachable from a group that was removed, and a page vanishing from the panel would be silent.

- [ ] **Step 2: Render the grouped shape.** Group name as a real heading above its rows; the ungrouped section gets a heading only when at least one group exists (with no groups at all, a lone "Ungrouped" header is noise). Show each page's number — small, muted, before the name — and keep the existing row controls, the open/closed highlighting, the `pageLabel` resolver, and the `+ New group` button untouched.

- [ ] **Step 3: Do NOT reorder the canvas, and leave a comment saying why.** `openRoutes` is kept in manifest order by `openRoute`, and the boards render in it. The panel is a listing; sorting the boards to match the panel would reflow the canvas on a grouping edit, which §F forbids (*"the canvas layout never reflows"*). Without that note, "the list is grouped now" is an invitation to make the boards match.

- [ ] **Step 4: Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — **not the build** (Task 9 owns the plan's single held publish). Keep the repo-wide lint count at its baseline.

---

### Task 17: Tokens panel — names off mono, values stay mono, and searchable

**Requested by the user:** *"Tokens are being listed using font mono for names, should use normal font. They should be searchable atleast too. Improve typography well… All properties should use normal font not font mono unless values."*

**Files:**
- Modify: `v2_fe/src/pages/design/token-editor.tsx`
- Create a colocated pure module + test for the filter

**Confirmed at the source:** the two name sites are `token-editor.tsx:186` (category header, `font-mono text-[11px] uppercase tracking-wide`) and `:192` (token key, `font-mono text-[10px]`). The three `font-mono` sites inside `ValueField` (`:100`, `:117`, `:123`) are **value inputs** — those are the user's stated exemption and they stay mono.

- [ ] **Step 1: The filter as a pure function, tested first.**

```ts
/// Case-insensitive substring match over the token key, its category label, and
/// the token VALUE — the value half is what makes a typography token whose value
/// is `Inter` findable by typing `inter`. Empty query returns the document
/// unchanged.
export function filterTokenCategories(doc: TokensDoc, query: string): TokensDoc
```

Tests: an empty or whitespace-only query returns everything; a query matching a **key** keeps that token and drops the others in the category; a query matching a **category label** keeps the whole category; a query matching a **value** finds that token (the `inter` case — pin it explicitly, since it is the example that was wrong); a query matching nothing returns empty categories rather than throwing, and the panel draws **its own** "No tokens match" line rather than the per-category "No {category} tokens yet.", which under a search would tell a project it has no colors tokens when it merely has no *matching* ones.

> **Correction (2026-09-25, from Task 17's implementer — and the wrong part was mine).** This step originally said *"so `inter` finds a `typography` token named `font_sans` … and `space` finds every spacing token"*, with the rule stated as key + label only. **Both examples were wrong, in two different ways.** `"space"` is not a substring of `"spacing"` — they diverge at the fifth character (`spac-e` vs `spac-ing`) — and no non-fuzzy rule makes it one. And `inter` was in the token's **value**, which the rule did not search at all. The implementer implemented the *rule* exactly as specified and pinned the near-miss in a test that names the contradiction, which is the right response to a brief whose rule and whose examples disagree.
>
> The rule now covers **values**, which makes the `inter` case real and is the useful half here — a project that has added a Google Fonts set should be able to find the token using it. The `space`→`spacing` case is deliberately **not** fixed: reaching it needs stemming or fuzzy matching, which is over-engineering for a token filter. Typing `spac` finds every spacing token. That is the honest boundary, and it is recorded so the next person does not rediscover it as a bug.

- [ ] **Step 2: The typography.** Names and category headers move off `font-mono` to the normal font; **values keep mono**, because they are literals and the user exempted them. While you are in the file, make the hierarchy read: the category header should not compete with the token names, and the `light`/`dark` labels should sit clearly under their token rather than beside the fields. Keep the sizes within the panel's existing scale rather than inventing new ones — the surrounding surface is dense and deliberate.

- [ ] **Step 3: The search box.** One input at the top of the panel, above the Save/Export row or directly under it, filtering as you type. It must not fight the save path: filtering is view state and never mutates `doc`, so a filtered view can still be saved whole. Say that in a comment — the panel's job is editing a document, and a filter that wrote back would be a data-loss bug.

> **Correction (2026-09-25, from this task's fix-round re-review).** The brief listed `resource-editor.tsx:397` (the add-*set* name input, now `:403`) among the sites that **stay mono** as "inputs". That line is wrong, and the reviewer named why: the token side's add-*name* input is off mono (`token-editor.tsx:168`), so following the instruction left **the same tab rendering two "add a name" fields in two different fonts**. The user's actual rule is names normal / values mono — the discriminator is what the field *holds*, not that it is an input. A field whose content is a URL, a hex, a size or markup stays mono; a field whose content is a name does not. **The add-set name input moves off mono**, and the paste textarea (`:160`) and the URL/rel-value sites stay as they are.

- [ ] **Step 4: Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>`. **Not the build.**

  ⚠️ Note in your report whether you touched the pre-existing `react-refresh/only-export-components` violation at `token-editor.tsx:31` — you may not have to, but a second one appearing would raise the repo baseline, and this phase holds that baseline fixed.

---

### Task 18: Inspect — finish the flow and make the dead controls live

**Requested by the user:** *"Inspect - I think I gave some suggestions for upgrades but update it further if possible."* Their earlier request was to select the right component, add text in the panel, and have the dispatch carry the sidebar selections with the full comment — and that flow **already exists** (`CommentForm` at `design-inspector.tsx:109-160`, `sendToAgent` at `:310`, and `dispatch_comments` sending `"instruction": c.body` plus a full target block). It was invisible because four defects broke it; Task 14 fixed three and Task 15 the fourth.

**So this task is not "build the flow" — it is "finish it and remove what still looks broken".** Read the code before changing anything, and report what you find rather than assuming the list below is complete.

**Files:**
- Modify: `v2_fe/src/pages/design/design-inspector.tsx`
- Possibly `v2_fe/src/pages/design/DesignSurfacePage.tsx` (the wiring of `onFocus`)

**Candidate items, confirmed by reading rather than assumed:**

- **The comment's route label renders but its click is inert.** `CommentsListSection` takes an `onFocus` prop (`:261`, `:269`) and renders the label as a button (`:355-360`), but nothing passes `onFocus` — `design-inspector.tsx:51` and `:102` render the section with `projectId` only, and `DesignSurfacePage.tsx:711-717` renders `DesignInspector` without it. It looks clickable and does nothing.
- **The ancestor breadcrumb has the same defect, and it is the answer to "select the right component".** `design-inspector.tsx:63-80` renders each crumb as a `<button>` with `title="Widen selection to {crumb}"`, under a comment that reads *"Breadcrumb — every crumb widens the selection upward."* **There is no `onClick`.** So the mechanism for reaching a component from an element was designed, labelled, and never wired. **No design decision is needed here — the UI already declares the intent; the handler is missing.** Wire the crumbs to widen the selection, which keeps element-level precision available instead of replacing it with snap-to-component.
  - The one thing to work out: `ancestors` currently carries **labels only** (`composer.rs:63-65` builds it from `dataset.component || tagName`), and widening needs a *path* per ancestor, not a label. The frame already computes `pathTo(el)` for the clicked element, so the natural extension is to send the ancestors' paths alongside their labels and rebuild a `SelectionState` from the chosen crumb. That means a small change to the picker runtime — **which Task 15's fix round is editing right now**, so this task waits for it rather than racing it in the same file.
- **The pins are new.** Task 14 made `CommentPins` render for the first time; verify a pin click reaches its board and that the numbering reads sensibly alongside the palette entries.

- [ ] **Step 1: Read, then list.** Before editing, write down what you found — which controls are dead, which already work, and anything the list above got wrong.
- [ ] **Step 2: Fix the dead controls you can confirm**, one at a time, each with a test where the repo's pure-function convention allows one. The two confirmed ones are the crumbs and `onFocus`; if the breadcrumb widening needs a `SelectionState` rebuilt from a crumb, extract that rebuild as a pure function and test it — it is exactly the kind of transformation that silently produces a comment pinned to the wrong element.
- [ ] **Step 3: Verify and commit.** `cd v2_fe && npx tsc -b && npm test`, **not the build**, lint delta zero.

---

### Task 19: Tokens panel — render typography tokens in the family they name (deferred last)

**Requested by the user**, who chose this option explicitly: panel typography first, **project-font preview last**. Nothing here starts until Tasks 16-18 are in and the fonts feature is verified end to end, because it makes the **app chrome** consume the project's own font tokens — a project with a broken font URL would then affect the editor's own rendering, which is a new failure mode that deserves the earlier tasks' stability underneath it.

Not specified further here on purpose: write this task once the fonts feature has been verified on a real stack, so it can be scoped against how webfont loading actually behaves rather than how it is expected to.

**Status 2026-09-25: blocked on the user, and honestly so.** *(Added during execution.)* The condition above is a **real** dependency, not ceremony: the font feature's backend half is merged and unit-tested, but **nothing in this phase has been browser-verified** — no implementer has run the built app, because the user asked to test locally themselves and publishing is on hold. So the one input this task needs (how a webfont URL actually loads, fails and falls back in the frame *and* in the chrome) does not exist yet. Writing it now would mean scoping it against an expectation, which is exactly what the paragraph above forbids. It waits for the user's local testing, and if their answer is "the fonts are fine", this task becomes writable immediately.

---

### Task 20: Group creation through a real dialog

**Requested by the user:** *"Group creation should be done via an actual dialog not a javascript window input"*.

**Confirmed at the source, and it is exactly one site.** `pages-panel.tsx:69` is `const name = window.prompt("Group name")` — the **last native dialog in the app**. Two things make this more interesting than a swap:

- **There is no `components/ui/dialog.tsx`.** `sheet.tsx` exists (a slide-over panel) but no modal. So this task **creates the primitive**, not just a usage site.
- **A prior developer wanted one and went without.** `task-sheet.tsx:63-64` reads: *"Two-step delete: the first click arms it, the second confirms — no AlertDialog component exists and `window.confirm` is off-brand."* Someone chose a workaround because the component was missing. **Build it properly and the workaround becomes replaceable** — but replacing it is *not* this task; note it in your report as a consequence.

**Files:**
- Create: `v2_fe/src/components/ui/dialog.tsx`
- Modify: `v2_fe/src/pages/design/pages-panel.tsx`
- A colocated pure module + test for the name rules

- [ ] **Step 1: The dialog primitive follows `sheet.tsx` exactly.** Same source (`{ Dialog as DialogPrimitive } from "@base-ui/react/dialog"`), same `data-slot` attribute convention on every part, `cn` from `@/lib/utils`, the same export shape (`Dialog`, `DialogTrigger`, `DialogClose`, `DialogPortal`, `DialogBackdrop`, `DialogPopup`, `DialogTitle`, `DialogDescription` — mirroring whatever `sheet.tsx` exports and how). **Do not invent a second convention**; the value of this component is that it is the same shape as the one beside it. Put `Sheet`'s styling vocabulary to work: the backdrop and popup classes in `sheet.tsx` already encode the app's overlay look.

- [ ] **Step 2: Extract the name rules as a pure function, tested first.** `createGroup` currently refuses a blank name, a name over `MAX_GROUP_NAME`, a duplicate (case-insensitive), and a call at `MAX_GROUPS` — and it refuses all of them the same way: by returning the document unchanged and an empty id. From a dialog that is a **silent no-op**, which is the exact failure this phase has spent its length removing (the resource editor gained `setNameProblem` for precisely this reason).

```ts
/// null when `name` is usable for a new group, otherwise the reason to show.
export function groupNameProblem(layout: LayoutDoc, name: string): string | null
```

  Tests: blank and whitespace-only; one character too long (`MAX_GROUP_NAME + 1`) refused and exactly at the limit accepted; a duplicate in a **different case** refused; and — the one worth pinning — a name that is currently taken is still refused when a *different* group is removed, so the rule reads from live state rather than a snapshot.

- [ ] **Step 3: Replace the prompt with the dialog.** Title, a labelled text input, Create and Cancel. Enter submits, Escape cancels, focus lands in the input on open — Base UI's popup handles the focus trap, so **do not hand-roll one**. Create is disabled while `groupNameProblem` returns a reason, and the reason is shown under the field so the user is never left guessing; `createGroup` stays the only creation path and its refusal contract is unchanged.

- [ ] **Step 4: Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — the baseline is **27 errors / 1 warning**. **Do not run `npm run build`**; the user is testing locally first and publishing is explicitly on hold.

  A dialog is interactive, so no unit test reaches the modal itself — say so in your report rather than implying coverage, and state exactly what a human should click to verify it.

---

### Task 21: Inspect — multiple selections across pages

**Requested by the user:** *"Inspect is currently doing a single component, I will need expanded to multiple selects from different design pages atleast, so during select we need to identify and say which route for example so that the underlying selected component can be mapped out well."*

**The granularity was asked and answered:** **one comment per selection**, not one comment covering many targets. That follows from the existing architecture — `CommentForm` creates a comment with a single `element_path`, the backend stores one target per comment, and `dispatch_comments` already formats a target block per comment. So nothing in the comment model or the backend changes.

**Confirmed at the source:** `DesignSurfacePage` holds **one** `selection`, and `design-canvas.tsx`'s `onSelect` replaces it — so selecting on a second page silently discards the first. That is the "single component" the user means. The route is already available: `sanitizeSelection(raw, route, viewport)` is called with the board's route, so **no frame-side change is needed** — the route travels with the selection already.

**Files:**
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (the selection state)
- Modify: `v2_fe/src/pages/design/design-inspector.tsx` (the list)
- Create a colocated pure module + test for the list operations

- [ ] **Step 1: The list operations as pure functions, tested first.** Selection state is exactly the kind of thing that goes wrong invisibly — a duplicate row, a lost entry, an active index pointing past the end after a removal.

```ts
/// Add `next` unless an equivalent selection is already present (same route AND
/// same elementPath), in which case re-activate the existing one. Returns the
/// list and the index that is now active.
export function addSelection(list: SelectionState[], next: SelectionState): { list: SelectionState[]; active: number }
export function removeSelection(list: SelectionState[], index: number): { list: SelectionState[]; active: number }
```

  Tests worth having, each of which names what would have to change for it to fail: clicking the same element twice yields **one** row, not two (dedupe is by route **and** elementPath — the same element path on *different* routes is two genuinely different selections, which is the case this whole feature exists for); removing the **active** row leaves `active` pointing at a real row rather than past the end; removing the last row leaves an empty list with `active` at `-1`; and re-clicking an existing selection makes it active rather than moving it.

- [ ] **Step 2: The inspector lists them, each with its route.** This is the user's explicit requirement — *"during select we need to identify and say which route"* — so every row shows the route, resolved through `pageLabel` the way the rest of the panel does, with the raw path available for precision. Each row needs: which page it is on, what was selected (component name when there is one, else the tag), a way to make it active, and a remove control. The **active** row is the one `CommentForm` edits, and `CommentForm` itself is unchanged — it still creates one comment for one selection, which is the whole contract.

- [ ] **Step 3: Mark the rows that already have a comment.** A selection whose comment was saved should say so, or the user cannot tell what they have already mapped — and the point of the feature is mapping components across pages. `CommentForm`'s `onCreated` already hands back the created comment, so the count per row is available without new plumbing. Keep it cheap: a badge, not a second list.

- [ ] **Step 4: Keep the single-selection path working.** The palette entries, the pins, and the comment→board focus all address one selection; they must keep working with the list present. Say in your report how you verified that, since the file is large.

- [ ] **Step 5: Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**. **Do not run `npm run build`** and do not push: the user is testing locally and publishing is on hold.

  The list *operations* are testable and should be tested; the click-to-select interaction is not (no RTL/jsdom). Say so rather than implying coverage, and give the human a short script: which page to click, what to expect in the list, and what order to check.

---

### Task 22: The parked minors batch

**Why this exists as one task rather than five fix rounds:** every item below is 1-6 lines, each was raised by a review whose task had **already passed** (0 Critical, 0 Important), and each is a preventive or a correction rather than a defect in shipped behaviour. Batching them keeps one review seat instead of five, and keeps them from accumulating into a large risky change at the very end. They are listed with their origin so a reviewer can check each against the task it came from.

**Files:** `v2_fe/src/pages/design/design-selection.ts`, `design-inspector.tsx`, `token-filter.ts`, `resource-editor.tsx`, `backend/plugins/taskflow-design/src/composer.rs`, `backend/plugins/taskflow-design/tests/resources.rs`

- [ ] **1. A malformed token can crash the panel while searching** (Task 17's re-review). `token-filter.ts:45` does `value.light.toLowerCase()`, and the document arrives as `JSON.parse(row.content) as DesignTokensDoc` with no runtime validation — so a hand-edited `tokens.json` with a `dark`-only token now throws where it previously rendered. Guard it (`value.light?.toLowerCase() ?? ""`) and test that a document with a missing `light` is filtered rather than fatal. Unreachable for anything the backend wrote, which is why it is here and not a fix round.

- [ ] **2. Make the two inspector callbacks required props** (Task 18's review, Minor 5). `design-inspector.tsx:45-48` declares `onWiden`/`onFocusComment` optional although there is exactly **one** call site and it passes both. Required props turn "a caller forgot" into a compile error — which is the whole defect class Task 18 fixed at runtime (two controls that looked live and had no handler).

- [ ] **3. A widened selection ships the click's captures beside the crumb's path** (Task 18's review, Minor 3). `design-selection.ts:110`'s spread keeps `snippet`/`srcRef`, and the dispatch sends both next to the crumb's `elementPath`/`component`/`file` — so widening to a crumb *outside* the component tells the agent `file: pages/settings.html` while `src` names a component file and the snippet shows the inner element. Drop the unmarked captures when the widened index is not the click.

- [ ] **4. Two hostile-input guards on the chain** (Task 18's review, Minors 6 and 7). The three arrays are `slice(-6)`d **independently**, so a frame sending mismatched lengths still lands misaligned windows and `widenSelection` cannot tell — add a length-equality guard so the invariant is explicit rather than assumed. And `canWiden` (`design-inspector.tsx:79`) should additionally require a **non-empty label**, or a blank ancestor renders a clickable crumb whose tooltip reads "Widen selection to ".

- [ ] **5. Point the Rust literal at its frontend fixture** (Task 18's review, Minor 4). `design-selection.test.ts`'s payload is a hand-copy of `composer.rs`'s message; the probe that ties them together was one-off, so a future runtime edit can drift and leave the tests green on stale premises. A comment in `composer.rs` naming the fixture is the cheap guard. (A full drift guard was declined by the user earlier for the realtime suffixes; do not reintroduce that idea here without asking.)

- [ ] **6. The mono line, corrected** (Task 17's re-review). `resource-editor.tsx:403` — the add-*set* name input — moves **off mono**, because the token side's add-*name* input already is and the same tab must not render two "add a name" fields in two fonts. The discriminator is what a field *holds*: URL, hex, size or markup stay mono; a name does not. The paste textarea (`:160`) and the value sites stay as they are.

- [ ] **7. Three comment/report corrections, each from a review that found the text claiming more than the code.** (a) Task 13: the old test name is split across a line wrap in `tests/resources.rs`, so a grep for it fails — put each old spelling on its own line, which was the fix's stated purpose. (b) Task 13: `composer.rs` says a page "cannot put that url in the markup it hands the validator"; the marker is a literal `<script src` substring search, so `<script type="module" src="https://…">` **passes** — narrow the claim. (c) Task 15: `composer.rs`'s CDP note reads as a claim about Chrome generally; scope it to Chrome under CDP. (d) Task 18: the report's §5 row 8 claims a discrimination its test does not have — either drop the claim or add a fixture with `ancestorComponents: [null, …]` so the `isClicked` fallback is actually exercised.

- [ ] **9. Two loose ends from the Pages panel's re-review.** (a) `pages-order.ts:32` tells the next reader to keep the manifest as the filter with `group.routes.filter(r => byPath.has(r))`, but **`byPath` exists only in `pages-panel.tsx:107`** — the module under discussion has no such map, so a literal flip hits an undefined identifier. Say what to build, not a variable from another file. (b) The render test's `not.toContain(">Settings<")` would not catch a bypass that fed `route.title` only into the input's `placeholder`; assert on the rendered text rather than one spelling of it. Also: test 6 in `pages-order.test.ts` provably proves nothing that test 1 does not, which means **the removed-group renumbering with a live group present is untested** — a two-group fixture (remove one, assert the survivor keeps 1..k and the orphaned pages continue the series) is separable by the existing mutations and is worth adding.

- [ ] **10. A note on the lint baseline, so the next reader is not misled.** The baseline is **27 errors / 1 warning**, but a bare `npx eslint .` during a concurrent task's round can read **29/1**, because a neighbour's *untracked* new module contributes two errors before it is finished with. Measure per-file against the committed baseline rather than trusting a single repo-wide number taken mid-round.

- [ ] **11. `setPageLabel` measures in UTF-16 units too** (Task 20's fix round, found while fixing `createGroup`'s). `design-layout.ts` counts a page label with `.length` while the server counts `chars().count()` (`layout_doc.rs:143`) — the same *client stricter than the server* shape, and now the only one left in that file. Same one-line fix, same boundary test shape: a multi-code-unit name at the limit that passes under `.length` and fails under `[...name].length`.

- [ ] **12. Two polish items from the multi-select review.** (a) An **unlabeled** page prints its route twice — `labelFor` falls back to the route itself, so the row reads `/pricing  /pricing`; suppress the second span when it equals the label. Both spans `truncate` with no `title`, so a long route can also be cut with no way to reveal it — put a `title` on the row. (b) `selection-list.ts`'s `replaceSelection` has an uncovered out-of-range fallback, and the `removeSelection` guard test's `1.5` assertion does not bite: only the `-1` case fails it, so a missing integer guard would pass. A guard test that only one of its two halves tests is the same shape as the other coverage gaps this batch exists to close.

- [ ] **10. Do not break the load-sequence guard, and share it if you split the loaders.** A task just landed `lib/load-sequence.ts` (`createLoadSequence()` → `{ begin(), isCurrent(seq) }`) with six checks inside `loadLiveWorkspace`; it exists because an older in-flight response was overwriting a newer, valid project choice — the user's *"different projects trying to take that spot"*. **Its implementer's condition, which I am carrying here rather than losing:** the guard survives this task as long as gating stays *inside* that orchestrator (ordering and what-is-fetched are orthogonal). **If you instead split loading into independent concurrent loaders, the token must be shared across them** — otherwise each gets its own sequence and the original race returns in a new shape. Flag it in your report if you take that route.

- [ ] **8. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>`, and `cd backend && cargo test --workspace`. Baseline: **27 errors / 1 warning** on lint. **Do not run `npm run build`**, and do not push — publishing is on hold pending the user's local testing.

  ⚠️ **Commit with a pathspec, `git commit -F <msg-file> -- <explicit paths>`, never `git add <paths> && git commit`.** Several agents share this worktree and therefore the git **index**, so the add+commit form commits whatever else another agent had staged — which has already produced a commit here whose tree does not compile, because a docs commit swept in a concurrent agent's staged `git rm`. Two wrinkles learned since: `-F <file>` is required rather than `-m`, because everything after `--` is parsed as a pathspec; and the pathspec form **cannot name a path git does not yet track**, so a task creating files must `git add <those exact new paths>` first and *then* `git commit -F <msg> -- <all the paths>`.

---

### Task 23: The Pages tab, restructured

**Requested by the user, with a layout sketch.** *"The grouping does not look good"* — the inline group headings Task 16 built are not what they want. Their sketch:

```
Groups                              [+Add Group]
1. Group 1
  - Page 1
  - Page 2
2. Auth
  - Login
  - Signup

[ ] Select all (Deselect)

[ ] 1. Pricing   [Click to Edit Label]        [Group ▾]
[ ] 2. Login     [Click to Edit Label]        [Auth  ▾]
[ ] 3. Signup    [Click to Edit Label]        [Auth  ▾]
```

**Three sections, in that order: Groups, a select-all control, then a flat numbered list of every page.** The checkbox meaning was asked and answered: **it shows the page on the canvas** — it is the open/close control the panel already has, so *"Select all / Deselect"* is bulk open/close, which the panel has never had.

**Files:**
- Modify: `v2_fe/src/pages/design/pages-panel.tsx`
- Modify: `v2_fe/src/pages/design/pages-order.ts` (the numbering changes) and its test
- Reuse the dialog from Task 20 for `+Add Group`

- [ ] **1. The Groups section is a read-only overview, and it is numbered.** A `Groups` header with `+Add Group` in it (the button moves up from the bottom of the panel), then the groups in `layout.groups` order as `1.`, `2.`, … each with its pages nested as bullets beneath it. **The bullets carry names only** — the numbering lives in the flat list below, so a page has exactly one number and it is the one the user reads next to its row. `groupedPages` from Task 16 already produces the sections and can drive this; what changes is that its numbers stop being rendered *here*.

- [ ] **2. The flat list is every page, numbered 1..N in manifest order.** One row per page, in the order the rest of the panel already uses — **keep manifest order**, the ruling from Task 16 still stands and its reasoning (a stable number beats matching a canvas column that filters to open routes anyway) is unchanged. Each row: the canvas checkbox, the number, the name, and the group select.

- [ ] **3. The name becomes click-to-edit.** Today it is an always-live input. The sketch says `[Click to Edit Label]`, which is the better affordance here: render the resolved `pageLabel` as text, and turn it into the existing `LabelInput` on click, keeping its commit-on-blur/Enter semantics and its refusal rules exactly as they are. **A click that opens the editor must not also toggle the checkbox** — they sit in the same row.

- [ ] **4. The group control becomes a real Select, and the native-select rationale must be dealt with rather than ignored.** The row currently uses a native `<select>` with a comment saying it is *"Kept native on purpose — see the file header"*. **Read that header first.** If its reason still holds, say so in your report and keep it; if the user's request supersedes it, change it and **update the header** — do not leave a comment whose stated reason no longer applies, which is a defect this phase has fixed four times.

  ⚠️ **Known trap, from this repo's own history: `@/components/ui/select.tsx` is Base UI, not Radix, and `SelectValue` renders the raw *value* unless the root is given an `items` value→label map.** Wire that map, or every row will read `g1` where it should read `Auth`. There is a memory note about exactly this; treat it as a real defect if it appears.

- [ ] **5. Select all / Deselect.** A checkbox reflecting whether *every* page is open. Clicking it when not all are open opens them all; clicking it when all are open closes them all. Label reads `Select all` in the first state and `Deselect` in the second. Keep the per-row toggling behaviour it summarises — this is a second entry point to the same `openRoutes` state, not a second state.

- [ ] **6. Numbering stays testable.** The flat 1..N is a pure function of the route list; Task 16's `groupedPages` tests should be updated rather than deleted, since the Groups section still depends on it. Add the case that the sketch implies: **a page in a group is numbered in the flat list by its manifest position, not by its position inside the group.**

- [ ] **7. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**. **Do not run `npm run build`** and do not push: the user is testing locally and publishing is on hold. The render test Task 16 committed (`pages-panel.test.ts`, SSR markup) should be updated for the new structure — it is the only test that sees the panel's actual markup, and it is exactly the kind of change that silently outlives its subject.

---

### Task 24: The default project is re-picked from list order (site-wide, not the design page)

**Requested by the user:** *"the global default project issue in which that may sometimes lead to random page reloads as different projects try to take that spot. Update dexie, create a new config table for the website to track default project atleast and watch that its only selected once and does not lead to random rerenders as projects keep changing."*

**Suspected mechanism, confirmed at the source — but you must confirm WHICH path fires before changing behaviour, because there are two and they are independent:**

1. **The resolver** (`App.tsx:396-433`, `loadLiveWorkspace`): it fetches the project summary and picks `preferredProjectId && nextProjects.some(p => p.id === preferredProjectId) ? preferredProjectId : nextProjects[0].id`. So when the preferred id is absent from the freshly-fetched list, the active project **silently becomes whatever is first** — and `loadLiveWorkspace` is called on `activeProjectId` change *and* on realtime events (`:894`).
2. **The render path** (`App.tsx:159-160`): `workspaceProjects.find(p => p.id === activeProjectId) ?? workspaceProjects[0]` — a second, independently written fallback to the same order-dependent `[0]`.

Both are **order-dependent on a list whose order this client does not control**, which is what *"different projects try to take that spot"* describes. Do not assume which one the user is hitting — instrument or instrument-by-reasoning and say which, because a fix to the unreachable one changes nothing.

**Files:**
- Modify: `v2_fe/src/App.tsx` (both fallbacks)
- Create a site-wide config module + Dexie table (see below)
- A colocated pure module + test for the choice

- [ ] **1. Extract the choice as a pure function, tested first.** This is the part that must be provably stable:

```ts
export function resolveActiveProject(
  preferred: string | null,
  persisted: string | null,
  projects: { id: string }[]
): string | null
```

  Tests, each naming what would change to fail it: `preferred` present → `preferred`; `preferred` absent but `persisted` present → `persisted` (**this is the fix** — today it would be `projects[0]`); both absent → `projects[0]`; **an empty list returns `null` rather than throwing or inventing**; and — the one that encodes the user's complaint — **a list that reorders does NOT change the answer when the preferred project is still present.**

- [ ] **2. A site-wide config table in Dexie, per user.** The user asked for *"a new config table for the website"*. Note what exists: the only Dexie DB today is `pages/design/design-ui-state.ts`, whose own doc comment says it is **per-user and per-project design viewport state** — so a site-wide default does not belong in that table's shape. **Decide and state**: either a new version of that DB with a separate `config` table keyed by user (one DB, two concerns — say why that is acceptable) or a separate small DB (cleaner boundary, another connection to open). Either way: **bump the Dexie schema version**, since an added table without a version bump silently does not exist.

- [ ] **3. Write the choice only when the user makes it, and read it in preference to list order.** The persisted value should be updated when the user *switches* projects — an explicit act — not when the resolver happens to land somewhere. Then `resolveActiveProject` reads it as the second preference, ahead of any positional fallback.

- [ ] **4. Both fallbacks must agree.** Whichever you confirm is live, the other must not remain as a differently-behaving second answer to the same question. If you cannot remove it, make it call the same function.

- [ ] **5. Prove the reload is gone, as far as a unit test can.** A pure function cannot show a missing reload. State plainly what you verified and how — and give the user a short manual check: switch projects, then cause a project list change, and confirm the active project does not move. Do not claim the rerender is fixed if you only tested the choice.

- [ ] **6. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning** (a mid-round repo-wide read can show 29 — measure your files). **Do not run `npm run build`** and do not push: publishing is on hold pending the user's local testing.

---

### Task 25: The two-finger pan re-renders the whole canvas on every event

**Requested by the user:** *"We usually use 2 fingers to pan the view, it sought of glitches, I think this is an issue with rerendering which should not be happening."* **They are right, and it is worse than a rerender.**

**Confirmed at the source:**
- `design-canvas.tsx:196-214`'s `onWheel` calls `onTransformChange(...)` on **every** wheel event, pan and zoom alike.
- `transform` is `useState` in `DesignSurfacePage` (`:127`), so every event **rerenders `DesignSurfacePage` and the entire board subtree** — and Task 3 latched the frames so they all stay mounted, which is exactly when this got expensive.
- `transform` is also in the dependency list of the **Dexie persist effect** (`:318`) — **but the write was already debounced, so no write lands mid-gesture and never did.** *(Corrected 2026-09-25. This line used to read "So every pan event **also schedules an IndexedDB write**, mid-gesture." **That was false**, and it was written from the effect's dependency list without reading its body — the persist effect at `DesignSurfacePage.tsx:330-345` has debounced the persist at **400 ms since `2ac745b`** (2026-09-25 03:59:09 +0300, verified), hours *before* this brief was written (08:23). Each wheel event cleared and re-armed that timer, so a gesture produced exactly one write after it settled, before and after the task.)* **The per-event cost was the re-render, and that is the whole of it** — the false half led a fix round to hunt a Dexie bug that does not exist. The plan carried this claim longest because earlier fix rounds left the controller's own artefact untouched; the code comments are corrected in `8b29f02`, whose message also records it.

**Files:** `v2_fe/src/pages/design/DesignSurfacePage.tsx`, `v2_fe/src/pages/design/design-canvas.tsx` (+ a pure module/test if the settle logic needs one)

- [ ] **1. The gesture must not go through React state.** Hold the live transform in a ref during the gesture and apply it **imperatively** — set the wrapper element's `style.transform` directly, reading the ref — so the boards are not re-rendered while the user is panning. Commit to React state (and therefore Dexie) only when the gesture **settles**, e.g. a short debounce after the last event.

- [ ] **2. Keep the existing maths untouched.** `design-canvas.tsx`'s zoom keeps the point under the cursor fixed, its clamp uses `MIN_SCALE`/`MAX_SCALE`/`ZOOM_STEP`, and the pan subtracts `deltaX`/`deltaY`. That logic is correct and testable; this task changes **when it commits**, not what it computes. Do not rewrite it.

- [ ] **3. The settle must be right, and it is the testable part.** A pure helper for "should this event schedule a commit" is testable; a debounce that never fires, or fires per event, is the same bug in a new shape. Cover: many events in a burst produce **one** commit; a single event still commits; and the final committed value equals the last event's value — not an earlier one, which is the classic dropped-tail bug.

- [ ] **4. This is NOT the item-5 spike.** The spec's item 5 is a *scroll freeze inside a frame* after using pan; this is canvas jank during a pan. Same code, different symptom. Do not merge them, and do not claim to have fixed item 5.

- [ ] **5. Verify and commit.** `npx tsc -b && npm test && npx eslint <files>`. **No build, no push.** Say what a human should do to confirm the smoothness, since jank is not unit-testable.

---

### Task 26: Order the screens into a flow

**Requested by the user:** *"We have been able to group the screens, now can we be able to order them so that I can say its signup screen 1 > signup screen 2 > login with email > login with phone > password recovery > new password reset, password confirmed … Like can I safely reorder different screens to have a good play atleast so that everything can be together as it should so that we can have a good flow that one can present after doing that."*

**The storage already exists and nothing reads it.** `LayoutDoc.route_order: Vec<String>` (`layout_doc.rs:40`) is in the document and is plumbed end to end and entirely dead: a grep across `v2_fe/src` finds it in the **type** (`design-layout.ts:13`), the **default** (`:23`), the **normalizer** (`:70`) and test fixtures — and in **no production consumer**. **This task makes it mean something; it does not add a field, a migration or an endpoint.**

**The two paths treat it differently, and the adversarial one is the write path.** *(Corrected 2026-09-25 — this paragraph previously said the field "is validated, and is filtered on read (`:121-128`, `:149`)", which conflated a hard refusal with a filter and would have told an implementer the server is tolerant. It is not.)*
- **Strict write** (`layout_doc.rs:118-129`): an entry that is **not a known route is refused with a 400** — the same rule as group routes — on the reasoning that a client sending one is stale. Duplicates are **silently deduped, first occurrence winning** (`seen_order.insert`). So an order that names a missing route **fails to save**; it does not degrade.
- **Forgiving read** (`filter_to_known`, `:149-155`): unknown routes are dropped.

**What that means for this task:** the client-side normalisation in Step 2 is not a convenience, it is what keeps the document **writable**. `setRouteOrder`/`moveRoute` must never construct an order the server would 400 on, so they normalise against the manifest *before* the write; and they should dedupe **first-wins**, matching `seen_order`, or an optimistic render will differ from what comes back on the next read.

**Files:** `v2_fe/src/lib/design-layout.ts` (+ helpers and tests), `v2_fe/src/pages/design/pages-panel.tsx`, `v2_fe/src/pages/design/DesignSurfacePage.tsx` / `design-canvas.tsx` for the board order

- [ ] **1. Decide the axis before writing code, and write the decision down.** The user's example is **one sequence that crosses groups** (`signup screen 1 > signup screen 2 > login with email > …`), and groups are a separate axis they already have. So `routeOrder` is a **single global presentation order**, not a per-group one. State that explicitly — a per-group order would be a different feature, and the field is singular.

- [ ] **2. Pure helpers first, tested.** `moveRoute(doc, route, delta)` / `setRouteOrder(doc, order)` with the invariants that matter: the order is a **permutation of known routes** (unknown routes dropped, missing routes appended in manifest order — never silently lost); moving the first item up is a no-op; moving the last down is a no-op; and a document whose `routeOrder` is empty falls back to manifest order rather than to nothing. **The repair case is the important one**: a stored order that disagrees with the current manifest must produce a total order containing every page exactly once, because that state is reachable — a page added after the order was written is not in it.

- [ ] **3. The reorder affordance goes where the ordering is legible.** The Pages panel already lists every page with a number and a group control; add explicit **move up / move down** controls (and, if you can do it cleanly, drag). Prefer the boring, testable control over a drag implementation that cannot be unit-tested in this repo — and if you do drag, the *pure* reorder function is still the thing that must be tested.

- [ ] **4. The order must be visible where it is claimed.** If the panel lists pages in `routeOrder`, say so and make it so; and the canvas boards must follow the same order, or the panel and the canvas will disagree about the flow the user just built. Note the constraint §F records: the canvas must not *reflow* on a grouping edit — but this is an explicit reordering, so re-flowing the boards in the new order is the point. Make that distinction in a comment, because the two look alike.

  **Ruling on the one place those two orderings fight — decided here rather than left to the implementer.** *(Added 2026-09-25.)* Read at the source: **`boardsForView` (`design-devices.ts:351`) is the single entry point the surface calls**, and all three arrangements (`layoutRows`, `layoutBands`, `layoutGroups`) consume `openRoutes` **positionally** — so in `rows` and `bands`, ordering `openRoutes` orders the boards. The `groups` arrangement is different in kind: its columns come from `groups[].routes`, and `openRoutes` only supplies the ungrouped tail (`layoutGroups:315`). So a single global order and a group arrangement are two orderings, and a naive "canvas follows `routeOrder`" would either silently do nothing in `groups` view or reflow the columns the user chose.
  **The decision:**
  - **`routeOrder` is the order for `openRoutes`**, and the panel lists pages in it. In **`rows`** and **`bands`** the boards therefore follow it, because the sequence is the only ordering those views have.
  - **In `groups`, the group columns stay the arrangement** — the user picked that view and §F forbids reflowing it — but **the pages within each group column are ordered by `routeOrder` too**, so the flow the user built is visible in every view rather than only in two of three.
  - The distinction to write in a comment: **a grouping edit must not reflow; an explicit reorder must.** They look alike and §F's rule is only about the first.
  If that proves awkward once you are in the code, say so and propose the alternative rather than delivering two of the three views.

- [ ] **5. Out of scope, and say so:** a presentation/walkthrough mode. The user said *"a good flow that one can present"* — an ordered sequence is what makes that possible later, and building a presentation mode now would be guessing at its shape.

- [ ] **6. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**, measured **per file** (a repo-wide read has produced three wrong counts in this phase when a neighbour's untracked file was in flight). **No build, no push** — publishing is on hold pending the user's local testing. Commit with `git commit -F <msg> -- <paths>`, never `git add <paths> && git commit`: several agents share this worktree's index and that form has already produced a commit here whose tree does not compile. If the task **creates** a file, `git add` its exact path first — the pathspec form cannot name a path git does not track yet.

---

### Task 27: Responsive review is sluggish because one write remounts every board

**Requested by the user:** *"if a user hits 'responsive review' they end up with a very slugish UI, improve rendering so that it remains smooth as updates come in."*

**Mechanism confirmed at the source — and the code states it as intent:**
- `DesignSurfacePage.tsx:196-203` subscribes to the app's single SSE stream through the design-realtime bus, and on **any** `designFiles` event does `setContentEpoch((e) => e + 1)`. The comment above it reads *"file writes remount artboards"*.
- The epoch is part of every frame's key: `design-canvas.tsx:413` renders `epoch={contentEpoch + boardEpoch}`, and `LazyFrame` keys on it. So **one write remounts every board on the canvas**, which reloads each composed document from the server.
- `responsiveReview` (`:425-430`) sets `RESPONSIVE_REVIEW_DEVICES` — three devices — so the board count **triples**. Same remount storm, three times the boards. That is why this is where the user notices.

**Why it is worse than N reloads:** the event is table-level. Whatever an agent or collaborator writes — a component, a token, a page — produces the same indiscriminate remount of every route at every device. During any active editing session the canvas is reloading everything continuously, and each reload re-runs the composer, re-fetches the frame's document and re-parses it.

**Files:** `v2_fe/src/pages/design/DesignSurfacePage.tsx`, `v2_fe/src/pages/design/design-canvas.tsx` (+ a pure module/test for the coalescing)

- [ ] **1. Coalesce the bump — the confirmed, cheapest fix.** A burst of writes must produce **one** epoch change, not one per event. Same shape as the pan fix (Task 25): a short settle after the last event. A pure "should this event schedule a bump" helper is testable, and the properties that matter are: a burst of N events produces **one** bump; a lone event still bumps; and the bump is not dropped when the burst ends (the classic coalescing bug, where the trailing event is swallowed).

- [ ] **2. Find out whether the invalidation can be scoped before assuming it cannot.** `PUT /file` returns `affected_routes` (`views.rs:392`, computed by `affected_routes_for`), which is exactly the information needed to remount only the routes a write touched. **Check what the SSE event actually carries** — this project's ORM signals have a known ids-only limitation (`bulk_post_save` carries ids, not values), so the affected routes may not be on the wire. If they are not, **say so in your report and do not invent a second fetch path** to get them; coalescing (item 1) is then the fix, and per-route invalidation becomes a follow-up that needs the event payload widened first. Report which it is — that distinction is the difference between a small fix and a protocol change.

- [ ] **3. Stop unrelated re-renders reaching the boards.** A parent state change — the transform, a panel toggle, a comment refresh — currently re-renders the whole canvas subtree. The boards should re-render when *their* inputs change, not when the page's do. Check whether `ArtboardCard`/`LazyFrame` are memoised and whether their props are stable (a fresh object or arrow function per render defeats memoisation silently, which is worth a comment where it is fixed).

- [ ] **4. Do not reduce what responsive review shows.** The feature is inherently three devices; showing fewer boards would be fixing the symptom by removing the feature. If you conclude a cap or virtualisation is needed, write it up as a proposal rather than doing it — the user asked for smoothness, not for less review.

- [ ] **5. Share the technique with Task 25 rather than inventing a second one.** The pan gesture has the same root cause — a per-event React state update forcing the whole canvas subtree to re-render — and the fix shape (hold live state outside React, commit on settle) is the same. If the two land differently, say why; two mechanisms for one problem is how the next person gets it wrong.

- [ ] **6. Say what you could not verify.** Smoothness is not unit-testable and this repo has no RTL/jsdom. Do not claim the UI is smooth. Give the user a script instead: which page, how many routes and devices, what to do while watching, and what "smooth" means concretely — and state plainly that the coalescing is proven by test while the *feel* is not.

- [ ] **7. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**, measured per file. **Do not run `npm run build`** and do not push: publishing is on hold pending the user's local testing. Commit with `git commit -- <paths>`, never `git add <paths> && git commit` — several agents share this worktree's index.

---

### Task 28: The eager-load leaks, and a reference-list cliff

**Requested by the user:** *"the client tries to load all the data once and this leads to long load times ie in production where there is lots of data and the UI is frozen … let the sidebar load its data alone, then let each screen load its data when the user hits it … For now the data cache unless it's the sidebar data like projects since they dont often change … but for the rest of the pages let them fetch when the user is there."* They also said: **do this after the UI upgrades.**

**Read `boot-load-map.md` first** — it is in this plan's workspace and it is the whole basis of this task: `bash scripts/sdd-workspace` prints the directory. It maps the boot path request by request, and it was written read-only with file:line citations.

**The headline finding, and it changes the shape of the work: the per-surface mechanism already exists and the user's named case mostly already holds.** Chat is **not** fetched on the board for a first-time visitor. There is no `<x>Needed` component — the gates are **nine booleans** computed from the route at `App.tsx:1083-1132`, funnelling into **one** effect (`App.tsx:1134-1247`) guarded by a ref of loaded flags. **So do not build a second mechanism.** The work is plugging specific leaks and fixing one correctness bug.

**Files:** `v2_fe/src/App.tsx`, `v2_fe/src/lib/taskflow-api.ts`, possibly `v2_fe/src/lib/live-mappers.ts`

> ⚠️ **Every `App.tsx` line number in this task is stale — re-locate by symbol, not by line.** *(Added 2026-09-25.)* `boot-load-map.md` was written before Tasks 24, 25 and 27 landed, and all three touched `App.tsx`; the file has since moved by **~126 lines**. Measured at `b7c57f7`: the nine gate booleans are at **`:1209-1248`**, not `:1083-1132`; the slice effect starts just after; `dockOpen` is read at **`:1028`** (`useState(() => loadDockOpen())`) and consumed by the gate at `:1210`, not `:912`. The map's *findings* — the nine booleans, the one effect, the `dockOpen` gate-input bug, the discarded `count` — all still hold and were re-verified; only its coordinates moved. Locate by the names (`chatNeeded`, `tasksNeeded`, `presenceNeeded`, `activityNeeded`, `terminalNeeded`, `settingsNeeded`, `reviewsNeeded`, `dockOpen`, `chatSurfaceMounted`), and if a citation and the code disagree again, trust the code and say so in the report.

- [ ] **1. `dockOpen` is persisted, so chat loads on every route forever — the user's own case.** `chat-dock-state.ts:41-51` persists the dock's open state to localStorage (read at `App.tsx:912`), and the chat slice is gated on `dockOpen` — so once a user has *ever* opened the chat dock, `chatNeeded` is true on **every** dashboard route for the rest of that browser's life. This is a gate-*input* bug, not a missing gate. **Rule: a persisted preference must not mean "load it everywhere"; gate on the current route's need, and let the dock's own surface trigger its own fetch.**

- [ ] **2. The board's five column queries are dragged in by two feeds that do not render them.** `App.tsx:1125-1129` gates `tasksNeeded` on `board|reviews|activity|openTask` (`taskflow-api.ts:664-675`), so `/dashboard/activity` and `/dashboard/reviews` pull up to 125 rows of the fattest row in the app (`description_markdown` + `notes_markdown`, `taskflow-tasks/src/models.rs:72-74`) which **neither feed renders**. Their only use there is title resolution (`live-mappers.ts:247-249`, `289-290`) — and that **already degrades honestly** to `Task #<id>`.
  **So this needs a title source, not a gate.** Removing the gate without one would leave the feeds showing `Task #123` everywhere, which is a regression dressed as an optimisation. Find or add the cheap title source first, and say in your report which it was. Biggest single win in the map — sequence it first.

- [ ] **3. The chat slice on `/dashboard/design` is six queries for a rail that needs two.** The `chatNeeded` gate (`App.tsx:1209-1213`, one of whose four disjuncts is `/dashboard/design`) pulls the whole slice, where the design page needs only `agentChannels` + `agentChannelMembers` to resolve the project room.

  ⚠️ **Do not simply drop or narrow the gate — there is a duplicate-creation hazard behind it, and it is confirmed.** `mapLiveChannelChats` (`live-mappers.ts:1069`) **synthesises** a project room **whenever `chats.length === 0`** (`:1086-1101`), with the detail string *"The live channel is created on first send."* So if the gate is narrowed in a way that leaves `agentChannels` empty, the synthesis fires **spuriously**, the rail shows a room that does not exist, and a send from it **creates a duplicate of a room that was already there**. The design page consumes it at `DesignSurfacePage.tsx:951`. **The fix is a channels-only slice, not a narrow gate.** Read `:1086-1101` and `:951` before changing anything here.

- [ ] **4. A production correctness cliff, which is a BUG rather than a weight problem — surface this even if you do nothing else on it.** `REFERENCE_PAGE_SIZE = 100` **is the server's hard ceiling**, and every "reference" loader reads **page 1 with no walk**.

  *(Corrected 2026-09-25. The ceiling half is right but the citation was to the formula rather than the config: the constructor sets `max_page_size = page_size * 4` (`vendor/umbral-rest/src/pagination.rs:294-306`), and the number that makes 100 the ceiling is **`PageNumberPagination::new(25)` at `backend/src/main.rs:217`**. Change that 25 and `REFERENCE_PAGE_SIZE` stops being the ceiling. Read both.)*

  *(The "silently … with no indication" half was an over-claim, and it changes what the fix is. The client's own comment beside the constant says the opposite — "`count` is in the envelope, so that limit is detectable rather than silent" (`taskflow-api.ts:503-508`) — and that is **true of the response**: `count` is there. What happens next is the defect: the reference loaders call `.list()` and use only `.results` (`:461-463`, `:608-613`), so **`count` is discarded unread**, and nothing in the UI shows that a list is short. So the honest statement is not "invisible" but "**detectable from the response and never read**" — which is a much cheaper fix than walking pages, and the same file already reads an envelope total for the board badges (`:482`). Start there.)*

  So: in production — exactly the "lots of data" case the user describes — those lists are **truncated at 100 rows with the total sitting unread in the same response**. That is a wrong answer, not a slow one. Either walk the pages or make the truncation visible; say which you chose and why. If it is too large to fix here, write it up rather than leaving it implied.

- [ ] **5. The smaller leaks, in the map's ranked order.** The summary's **2 count queries per project** on every route (`taskflow-api.ts:470-484`); the core workspace + summary loading on `/account/*` (`App.tsx:818-828` guards on auth, not route, while the account area renders no workspace data); `fetchMyInvites` fetched twice (boot + invitations page); `fetchCurrentUser` re-firing on every route change (`App.tsx:816` has `location.pathname` in its deps); `fetchGithubProjectStatus` fired by the header on every dashboard route (`:2012`). Take them in that order and stop where the risk stops being worth it — say where you stopped.

- [ ] **6. The sidebar badge that changes for the wrong reason.** `countOnlineAgents` feeds the sidebar's online badge from the **presence slice** (`App.tsx:176`, `live-mappers.ts:641-645`), so the number moves when an *unrelated* surface loads — even though `mapLiveProjects` deliberately avoids exactly that (`live-mappers.ts:652-658`). The map calls this a hazard rather than a bug; judge it and fix it if the fix is small, because a badge that changes while nothing relevant happened is the kind of thing that erodes trust in every other number.

- [ ] **7. Give the mechanism an executable spec, because it has none.** It is documented only in code comments — no plan, spec, README or `CLAUDE.md` — and `taskflow-api.ts` has **no test file at all**. The gates are **nine booleans computed from a route string plus three flags**, which is a pure function and perfectly testable. Extract and test it: which routes need which slices, that a *persisted* dock state does not enable chat everywhere (item 1 as a regression test), and that a route change resets what it should. This is the difference between fixing the leaks and preventing the next one.

- [ ] **8. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**, measured per file. **Do not run `npm run build`** and do not push: publishing is on hold. Commit with `git commit -- <paths>`, never `git add <paths> && git commit` — several agents share this worktree's index and that form has already produced a commit here whose tree does not compile.

- [ ] **9. What you cannot verify, stated rather than implied.** Every payload figure in the map is quoted from a code comment, not measured; nobody has profiled the built app. Do not claim a load-time improvement. Give the user a script — which routes to open, what to watch in the network panel, and **which requests should be absent** — since "fewer requests on a route that does not need them" is checkable by eye and a millisecond figure is not.

---

### Task 29: Realtime activity re-sorts thousands of rows on every event

**Found by the boot-load investigation**, which was looking for main-thread hot spots and found this one in the **app shell** rather than the design page: `taskActivity` is capped at **8000 rows** and `mapLiveActivityEvents` **re-sorts all of them** whenever the workspace object changes.

**Three citations corrected 2026-09-25, because the ones this task was written from would have sent an implementer to the wrong code:**
- The re-sort is **`mapLiveActivityEvents` (`live-mappers.ts:233`)**, at `:239-243` — **not** `:748-750`, which is where the two caps (`MAX_LIVE_TERMINAL_FRAMES`, `MAX_LIVE_ACTIVITY`) are *declared*.
- It is reached through a **`useMemo` at `App.tsx:395-398`, deps `[activeLiveWorkspace, projectTasks]`** — **not** `App.tsx:626`, which is the `tasks` **delete** case of `applyRealtimeRow` and has nothing to do with activity. `projectTasks` is itself memoised (`:254`), so in practice the memo re-runs on every realtime upsert, because each one replaces the workspace object.
- **8000 is a cap, not a growth** — `upsertCapped` (`live-mappers.ts:739-742`, applied at `App.tsx:742`). Item 1's "cap or growth" question is answerable from the file in one grep; it is a cap.

**The sort is deliberate and documented, so the naive reading of item 2 is a regression.** The comment at `:234-237` explains why it exists: the initial fetch arrives newest-first but a **realtime upsert appends**, so a live event used to land at the end of a 1500-row list and never appear in a feed paged from the top. *"Ordering at the point that defines the display order makes that impossible to get wrong again."* **So "stop re-sorting the whole array" is not the fix** — anything that replaces it must still guarantee newest-first, or it reintroduces a fixed bug that took a real report to find. Insert-in-position and a cheaper ordering key are the shapes that preserve it.

**And the sort may not even be the hot part** — do not assume it is. The same function does a **`projectTasks.find(...)` per event** (`:246`) and allocates a mapped object per event, so a recompute is O(events × tasks) plus 8000 allocations *before* the ~8000·log(8000) sort. Measure which dominates before optimising, and say what you measured.

**Why it matters here:** the user reports *"the UI is frozen"* in production, and this is a plausible **second** cause of it, entirely separate from Task 27's design-page remount storm. **Do not conflate them** — Task 27 is a design-page epoch remounting boards; this is the shell re-mapping and re-sorting a large array per event. If the user's freeze is this one, fixing Task 27 alone would leave it.

**Files:** `v2_fe/src/lib/live-mappers.ts`, `v2_fe/src/App.tsx`

- [ ] **1. Establish which one the user is hitting before optimising.** The map could not tell, because it had no profiler and no running stack. Say what you can determine from reading — how often this memo recomputes relative to the design-page path, and what it costs per recompute — and be explicit that the *decision* between the two causes needs a profile of the built app. (The "cap or growth" half of this item is already answered above: it is a cap, so do not spend a cycle re-deriving it.)

- [ ] **2. Find the actual hot part, then make it cheaper — without losing newest-first.** The candidates, in the order worth measuring: the **`projectTasks.find` per event** (`live-mappers.ts:246`, so O(events × tasks) — build a lookup once instead, which is a pure change and cheap), the **per-event object allocation** in the `.map`, and the **sort** (`:240-243`, ~8000·log 8000). A recompute fires on every realtime upsert, so all three are per-event costs. A pure helper for whatever you change is testable; the *arrangement* is not, so test the helper and say what remains unverified. **Whatever replaces the sort must keep the guarantee its comment names** — see the paragraph above; a faster feed that hides a fresh event is a regression, not an optimisation.

- [ ] **3. Do not change what the activity feed shows.** Reducing rows rendered is fine; silently dropping events from the *data* is not — the feed is a record. If you cap the in-memory array, say what a user loses.

- [ ] **4. Verify and commit.** `npx tsc -b && npm test && npx eslint <files>`. **No build, no push.** Commit with `git commit -- <paths>`.

---

### Task 30: The second hardening batch — reasons that outlived their subjects

**Why a second batch and not more items in Task 22:** Task 22's brief was cut before these arrived, and it is already mid-round. Adding to a brief that is being worked is how items get silently dropped; a named second batch keeps the record unambiguous. Same shape as Task 22: small, non-blocking, each from a review whose task **passed** (Task 23: approved, 0 Critical, 0 Important).

**Files:** `v2_fe/src/pages/design/pages-order.ts`, `pages-panel.tsx`, and their tests; plus whatever the sweep below finds.

> ⚠️ **Run this task LAST among the remaining ones, and locate everything by symbol rather than by line.** *(Added 2026-09-25.)* Its items were written by four separate reviews at four different commits, and **every file it touches has moved since** — Task 26 is reworking `pages-panel.tsx` and `pages-order.ts` right now, and Task 28 restructures `App.tsx`. The citations below (`pages-panel.tsx:300`, `design-devices.ts:315`, `DesignSurfacePage.tsx:280`, `design-canvas.tsx:85-89`, `DesignSurfacePage.tsx:606`, and the `composer.rs` block in item 7) were accurate **at the commits their reviewers read**, which is not the tree you will open. This is not a small hazard for *this* task in particular: it is 15 items whose whole job is correcting statements that are slightly wrong about code that has since moved, and an implementer who trusts a coordinate will "fix" a line that no longer says what the finding described. If a cited line and the finding disagree, **the finding is probably still right and the coordinate is not** — find the code it describes, fix that, and note the drift in your report.

- [ ] **1. `GroupedPages.ungrouped` has no production consumer, and its doc says the panel draws it** (Task 23's review, Minor 1). The panel renders `sections.groups` only (`pages-panel.tsx:300`); `ungrouped` is read by tests alone. Both its type doc ("…then the tail") and the `claimed`-not-stored rationale ("a page whose group is gone must be listed, not hidden") describe a rendered tail that **no longer exists** — the flat list is what guarantees nothing vanishes now. **Keep the field** (the partition invariant is worth having) and restate the doc as what it is: the sections' complement, computed for the partition the tests pin, no longer drawn.

- [ ] **2. `selectAllState`'s justification is not true as written** (Minor 2). It says "a route that is not a page in the manifest cannot be drawn on the canvas" — but `layoutGroups` builds its ungrouped tail from `openRoutes.filter((r) => !grouped.has(r))` with **no manifest filter** (`lib/design-devices.ts:315`), and the Dexie read that seeds `openRoutes` also has no manifest filter (`DesignSurfacePage.tsx:280`). **Only the reason is wrong**; the behaviour is deliberate, tested, and arguably a feature (a stale route has no row and no other panel affordance). Say "a route this panel cannot list" and drop the certainty about the canvas.

- [ ] **3. One clause overstates the `items`-map guard** (Minor 3). "A guard a native `<select>` could not have offered" is too strong — a native select's option labels are in the markup and a render test could assert them. The honest distinction, which the test actually proves: the Base UI trap is a **silent value→label substitution** with no native equivalent. Swap the clause.

- [ ] **4. A mislabelled page has no in-panel way to show its route** (Task 23's review, on the dropped route path). The reviewer recommends **keeping the path dropped** — the brief enumerates four slots and the sketch draws four — but notes the loss is larger than "the canvas shows it anyway", because **the canvas header resolves to the label too** (`design-canvas.tsx:85-89`), leaving the ⌘K palette's hint (`DesignSurfacePage.tsx:606`) as the only sighted surface with a raw path. Since a label accepts anything up to `MAX_LABEL`, a user can rename a page into ambiguity with nothing to check against. **Cheapest honest fix, no row-shape change and no test change: `title={page.route}` on the name button.** The accessible name already carries it (`aria-label="Label for /settings"`), so this closes the *sighted* gap only.

- [ ] **5. Report-only corrections, to be applied if those reports are ever relied on** (Minor 5). Task 23's report claims a pre-existing React key warning was fixed incidentally — **not reproducible**: React marks a static JSX child `validated = 1`, so it could not have warned (the reviewer probed it). And its §6 says mutation B fails "tests 1 and 3" where it fails 1 and 2 in file order. Note these the way earlier report errors were noted, with the implementer's words left intact.

- [ ] **6. A sweep, since this class keeps recurring.** Four separate reviews have now found a **comment whose stated reason has outlived its subject** — the phase's most-repeated documentation defect. Grep the design page's modules for comments justifying a mechanism (`why`, `because`, `so that`, `for this reason`) and check the ones whose subject has since changed. Report what you find rather than fixing blindly; some will be fine and saying so is useful.

- [ ] **7. `composer.rs`: the three items Task 22 deferred under a scope cut.** Task 22 was dispatched while Task 10 was editing `composer.rs`, so I removed these three from its brief to keep one writer per file. Task 22 never touched the file and wrote the exact change it *would* have made for each (in `task-22-report.md`), so they are ready to apply. Take them in this order:
  - **7a. The comment that claims a bound the marker does not have (its judgement: "the one with teeth").** The marker it reads is the `<script src` substring; the comment asserts a containment the substring test cannot give. Read it before and after Task 13's CSP widening and correct the claim to what the code enforces. **A comment that overstates a safety property is worse than no comment** — this phase has already twice had a false mechanism outlive its subject.
  - **7b/7c.** The second comment narrowing and item 5's runtime-side pointer, per the report's written-out diffs.
  Re-verify against the file as it stands now: `composer.rs` moved twice after Task 22 was dispatched (`f9debda`, then `b7c57f7` — `rewrite_hrefs` was substantially rewritten in the second), so **any line number Task 22 recorded is stale**. Locate by symbol.

- [ ] **8. Move the load-sequence guard above the persisted-project write** (Task 24's re-review, Minor, out of scope for a "minimal and local" fix round). `App.tsx:483` runs `rememberPersistedProjectId(persisted)` after the awaited Dexie read at `:482` and **before** the `:489` check, and it writes state — so a load superseded during that read can publish the value it read, potentially the pre-choice one, over the user's newer pick. The window needs the ref to be null at load start *and* a choice during the read, and the damage is bounded (a stale second preference for the rest of the session; the ref short-circuit then suppresses re-reading the fresh Dexie value) — the reported symptom does not reproduce. `:489` is an unchanged context line, so this predates the fix; **but `8f1fd5e`'s own message claims "checked after each one, before any setState", which is not true here.** One-line move closes it. *(Line numbers from `App.tsx` at `b7c57f7`; Task 28 restructures this file, so locate by symbol.)*

- [ ] **9. Correct "no test in this repo mounts a component"** (Task 24's re-review, Minor). `load-sequence.ts:19-22` and `load-sequence.test.ts:17-19` both justify the wiring-by-inspection decision with a claim about the repo that is **too broad**: `pages-panel.test.ts` and `design-inspector.test.ts` already render *real* components in the node environment via `renderToStaticMarkup`. The narrow claim is true and is the reason to keep: **App cannot be rendered** (`App.tsx` calls `hasStoredAuthSession` → `window.localStorage` at render), and more fundamentally **effects do not run** under static rendering, so a wiring test could not exercise this path at all. Say that, not "no test mounts a component". The next person to touch the file will otherwise re-litigate it — or worse, believe a test could be written the easy way.

- [ ] **10. A hesitating drag re-renders once per pause** (Task 25 fix round, parked as efficiency, not correctness). The settle timer is armed for drags as well as wheel events, so a drag that pauses longer than the settle window commits; the committed value equals the live one, so **there is no visual jump** — it is one render per pause, nothing more. If it ever matters the lever is arming the settle for wheel events only, since a drag has a real end and already flushes. Do not fix it speculatively; fix it if a profile says so.

- [ ] **11. The epoch gate's cleanup never fires on a project switch, and the comment says it does** (Task 27's review, Minor — one identifier). `DesignSurfacePage.tsx`'s `useEffect(() => () => contentEpochGate.cancel(), [contentEpochGate])` has a dependency that is **stable for the component's life**, so the cleanup runs **only on unmount**. The design route is a static path with no `key`, so a project switch changes only the `projectId` prop and the instance persists — meaning a file event landing inside the settle window of a project switch remounts every board at every device on the project the user *just arrived at*, right after those frames mounted. Content stays correct, so it is one redundant reload rather than a bug — **but it is exactly the waste Task 27 exists to remove, and the comment asserts a bound the code does not have**, which is this phase's most-repeated documentation defect. Fix: `}, [contentEpochGate, projectId])`. Keep it out of Task 27's fix round and apply it here, since Task 27 is approved.

- [ ] **12. A test whose stated purpose is not what it pins** (Task 27's review, Minor). `content-epoch.test.ts`'s "coalesces a burst at the module's OWN default window" asserts the **constant** (`EXPECT CONTENT_EPOCH_SETTLE_MS >= 120`) and then arms one window for one push — neither is sensitive to the duration. Proven by mutation: handing the gate `settleMs: 0` while leaving the exported constant at 200 leaves **9 of 9 passing**, so the threading of the constant into the gate is unpinned. The code is *correct* as written and `settle-gate.test.ts` pins the real timing, so this is a comment overstating its reach — the same class as item 12's sibling and as Task 17's near-miss test. Either pin the threading or restate the test's purpose as what it actually checks.

- [ ] **13. A wrong line citation in a report** (Task 27's review, Minor). Report §3 cites `App.tsx:945-955` for the design forward; at `fc3952a` it is `App.tsx:1002` (`emitDesignRealtimeEvent(event)`), and `945-955` is the task-chip refetch effect. **The claim is correct, the coordinate is not.** Note it the way this phase notes report errors — alongside the claim, with the implementer's words left intact — because a citation that sends the next reader to an unrelated effect is worse than no citation.

- [ ] **14. A latent dep, worth a comment and not a change** (Task 27's review, Minor, benign today). `DesignSurfacePage.tsx`'s `pins` `useMemo` depends on `transform`, so `pinLayer` — and with it `DesignCanvas`'s `pins` prop — changes identity on **every pan/zoom commit**. Harmless now: `transform` is already a `DesignCanvas` prop, so that path re-renders the canvas regardless, and the boards are saved by `ArtboardCard`'s own memo one level down. Worth one comment line, because it means `memo(DesignCanvas)` can never help on a transform change, and if `transform` ever returns to per-event updates this dep list is where the pins subtree rebuilds.

- [ ] **15. Verify and commit.** `cd v2_fe && npx tsc -b && npm test && npx eslint <touched files>` — baseline **27 errors / 1 warning**, measured **per file** (a repo-wide read can be inflated mid-round by a neighbour's untracked file — that has now produced three wrong counts in this phase, so measure the committed tree or per file). **Do not run `npm run build`**; no push. Commit with `git commit -F <msg> -- <paths>`.

---

### Task 31: The final whole-branch fix wave — everything parked to it

**Why this task exists, and why it is written now.** *(Added 2026-09-25.)* From Task 7 onward, reviews kept parking small findings to "the final whole-branch fix wave", several with the phrase *"with the exact fix recorded so it cannot be lost"*. **They were recorded in the ledger, and the ledger is git-ignored scratch.** So the record existed only where `git clean -fdx` deletes it, for items explicitly filed *because they must not be lost*. This task is that record, in the committed plan, written the moment the gap was noticed rather than at the end when the details would be gone.

**This is the single fix wave after the final whole-branch review**, per the process. It is not a hardening batch like Task 30 — Task 30 is minors from *approved* tasks; this is the residue that reviews deliberately left open, including **one item a re-review marked open rather than as breakage**, which is why Task 13 is not marked complete-with-nothing-outstanding.

**Sequencing decision, made here rather than at the end:** run Task 31 **before** the final whole-branch review, not after it. The process says the final review is followed by one fix wave, which would put this task's items and that wave in the same files at the same time — two writers, the exact conflict this phase has paid for repeatedly. So this closes the backlog the task reviews left, and the final review's own wave is then genuinely last and genuinely small. **Order: Task 26 → Task 30 → Task 28 → Task 29 → Task 31 → final review.** Task 30 precedes Task 28 because Task 30's `App.tsx` guard move is one line and Task 28 restructures that file; landing the small change first keeps the restructure's diff clean.

**Files:** mostly backend (`composer.rs`, `views.rs`, `resources.rs`, `manifest.rs`, `tests/`), a few `v2_fe` one-liners. **Locate everything by symbol** — these were written at many different commits and the tree has moved under all of them.

**The items with a real fix:**

- [ ] **1. A duplicated emission would be invisible to the whole suite** (Task 7, parked as the first of two "to the fix wave"). The ordering assertion catches a **move** but not a **duplicate**, and neither half of the test counts tags: `find` returns the first occurrence, which stays before `<style>` under duplication. The reviewer checked the entire suite and found every other assertion is either `contains` or head-equality *between* the two documents — which a consistently duplicated emission preserves. So a duplicated `<script src>` emission would be **invisible everywhere**, and the reviewer called the mistake "empirically plausible" on the strength of the implementer's own first mutation being exactly that. **Fix: one `html.matches(preconnect).count() == 1` in either half.**

- [ ] **2. Nothing pins the serialised key `variablesDark` on the wire — and the general form is worth more than the instance** (Task 14, parked to the wave). `manifest.rs`'s own test asserts the dark override on the *struct*, and `phase1_storage_composer.rs` pins `usedOn`/`usageCount` on the manifest JSON — but **no test asserts the serialised key**, which is exactly why the wrong spelling could sit there and why the sweep could only be done by reading the Rust. This is the **fourth** instance in the phase of the TS type not mirroring the wire (the design-api rows, `DesignComment`, `DesignManifest.resources`, and now `variablesDark`). **Fix the instance with one assertion, and consider the general form: a Rust test pinning the serialised key names of the shapes the frontend mirrors** — which would have caught `variables_dark` **and** `affected_routes` together. If you take only one item from this task, take this one.

- [ ] **3. A stored document containing `preload` loses every link in it, silently** (Task 7, parked as the second of two). Tightening the allowlist means `manifest.rs`'s collapse-to-empty drops the whole link set. **Exposure is nil** — no fixture, seed or test document anywhere contains `preload`, the editor that could create one is Task 8 and does not exist yet, `deploy-backend.yml` is manual-trigger only, and the publish is held. The reviewer's judgment, which I adopted: *"correct trade, not a defect; shipping a second silent no-op to protect a document population that does not exist would be the worse call."* **Fix: one release-note line in the plan.** Do not change the behaviour.

- [ ] **4. Task 13's Fix 6 and its two Minors, parked OPEN** (Task 13). Reason at the time: Task 15 was editing `composer.rs` in the same regions, so a round 2 would have put two writers in one file and dragged Task 15's diff into Task 13's review range. Cost of the deferral, recorded then: **a comment string that does not grep, and two sentences slightly broader than the code** — no behaviour, no reachability, nothing a user can hit. The specifics are in `task-13-report.md` and `review-…` in the phase workspace; **read them before applying**, since this is the one parked item a re-review marked open rather than as new breakage.

- [ ] **5. A comment claiming more about Chrome than it can** (Task 15). The "Chrome delivers no cross-frame pointer-leave" comment reads as a claim about production Chrome rather than about Chrome-under-CDP. The lead-in already says "NOT verifiable under CDP", so the instruction is safe, but **a two-word scope would remove the ambiguity** — and this phase has now had six comments whose stated reason outlived or overstated its subject.

- [ ] **6. `pages-order.ts`'s flip instruction names an identifier that does not exist there** (Task 16). It names `byPath`, which lives only in `pages-panel.tsx` — a literal flip would hit an undefined identifier. **Fix: name the real binding.**

- [ ] **7. The render test's `not.toContain` would miss a `placeholder` bypass — and an earlier ruling of mine was wrong about this.** *(Corrected 2026-09-25.)* Task 22 asked me to rule on a "test-strength descriptor" that seemed to map to no brief item, and I ruled it was noise. **It was not noise — it is this parked Task 16 item**, and it is real: `pages-panel.test.ts`'s `not.toContain(">Settings<")` is text-shaped, while `pages-panel.tsx` feeds the resolved name into `placeholder={name}`, so a bypass through the attribute is invisible to it. It fell outside Task 22's file list (`pages-panel.*`), which is why it could not be acted on there. **Fix belongs here**, with the rest of the panel work. **A "no `LabelInput` mounts in that test, so no live bypass is demonstrable" caveat applies** — so first make it demonstrable, then pin it; a test that cannot fail for the thing it names is this phase's single most-repeated defect, and adding one *about* test strength would be an unusually poor joke.

- [ ] **8. A removed-group renumbering case is untested, and one test proves nothing another does not** (Task 16). Its test 6 proves nothing test 1 does not, which means **the removed-group renumbering with a live group present is untested** — and a two-group fixture separates them with the existing mutations. **Fix: add the fixture and the case.**

- [ ] **9. Two report nits that outlive their task** (Task 20). The boundary test's comment claims "every expectation passes under `[...name].length` and fails under `.length`", **which is literally false for three measure-insensitive expectations** (the direction is still proven, so the conclusion stands and only the claim is wrong); and the report says `24 passed` where the number is `25`. Fix the comment; note the report number the way this phase notes report errors.

- [ ] **10. Two pre-existing observations from Task 21's review.** `CommentsListSection`'s self-fetch path is now **unreachable** — both callers pass `comments`, so `localComments` and its effect can never run. It is deliberate, so **either delete it or say in a comment that it is a fallback with no caller**; dead code that looks live is worse than either. And a plan document still references the **removed `onCommentCreated` prop** — find it and fix it.

- [ ] **11. Two report-text errors from Task 14, which its re-review verified rather than waved through** (Task 14, Minor). `task-14-report.md:179` promises a range edit that the row at `:98` did not make; and `:181`'s explanation for a reviewer's number — a dirty tree — is **unsupported** by the evidence. Note them the way this phase notes report errors, with the implementer's words left intact, because both are the same failure as item 13: a claim about the record that the record does not support. **The Task 14 half of this item is documentation-only**; its re-review found **no code findings at all**, so nothing else is owed from it.

- [ ] **12. A correction to the record itself, because it is instructive:** Task 14's re-review established that the fix instruction **I** wrote into the ledger for its Fix 3 was *also* drift. The implementer was right; the mechanism it gave was not. The true range for that `derive`/struct pair is `views.rs:278-286`, at both the reviewed commit and HEAD; the `:277-285` my ledger asked for **never existed at or after the commit under review** — it is the pre-`b855a4d` state, and `b855a4d` (04:31) added a line above it. The round-1 range it was "correcting" was not wrong either (it named the `derive` separately at `:278`). **So a coordinate can be wrong in the direction of a correction as easily as in the original**, and this phase has now produced drift in both directions. **Nothing to change in the code** — recorded because the next person to trust a remembered line number should know it has already happened to the person writing them down.

- [ ] **13. `views.rs` builds a whole manifest to read one field** (Task 7, twice parked). It is pure and DB-free, so this is **cost and clarity, not correctness**. The suggested shape is a `manifest::resources_from(files)` helper. Apply it only if it is genuinely small; say so either way.

**Recorded as NO ACTION, so nobody re-proposes them** — the second half of what "parked" has to mean:

- `pub(crate)` on `resources_tags` (Task 7): **not viable.** The reviewer proposed it without checking that `tests/resources.rs` is a separate crate calling it directly, so `pub(crate)` would not compile there — and the doc comment already states the precondition it was meant to enforce.
- The two `mod support;` harness warnings (Task 7): the report's "adds no new warnings" was overstated, but the suggested remedy (**delete them**) is **unsafe** — `support/mod.rs` is compiled per test target, and an import unused in one target may be used in another. Leave them.
- Untrimmed `rel`/`href`/`name`/`id` and the absent component test (Task 8): harmless (the server trims names and ids, strips the url, and HTML tokenises `rel` as a whitespace-separated list), and the missing component test is the repo's own convention.
- `composer.rs`'s `let _ = token;` in `sandbox_csp`, and `esc`'s `'`-gap (Task 7). The gap is already documented at the code; both are pre-existing.
- The `ResourceLink` null-vs-absent asymmetry (Task 14): invisible, and no reader distinguishes them.
- The `CommentScope`/`CommentStatus` citation ranges (Task 14): the same omission shape the round was correcting, but **the claim itself is correct**.
- A report quote dropping a commit subject's tail (Task 15), and the `\u0000` join / `|` React key separator assumption (Task 21): pre-existing, unreachable for the frame's grammar, but the "bit-identical" argument rests on it — so it is worth a comment, not a change.

- [ ] **12. Verify and commit.** Per file touched, not repo-wide: `cargo test --workspace` for the backend (**`--workspace` is mandatory — a bare `cargo test` in `backend/` silently omits every plugin crate**), and `npx tsc -b && npm test && npx eslint <files>` for `v2_fe`. Baseline **27 errors / 1 warning**, measured per file. **No build, no push** unless the user has lifted the hold by then. Commit with `git commit -F <msg> -- <paths>`; `git add` exact paths first if you create a file.

---

## Deferred / not in this plan

Items 1–7 are all now planned above. The following remain deliberately out.

- **Item 5, the pan→select scroll freeze — a SPIKE, not a task.** Its leading theory was falsified by the user's own observation (they can highlight text, so frames do receive pointer events). Reproduce on the local stack, report the cause, and return for a decision. **No fix is written under this plan.** Re-check it *after* Task 3, since latching frames changes how many are alive.
- **The realtime suffix drift guard** was declined by the user previously; still not added. Note for the record that the failure mode is worse than assumed: a mismatch 403s the whole handshake, not one silent group.
- **Renaming a page's real title** — the user chose a display label.
- **Group rename/delete** — groups remain create-only from Phase 4; `removeGroup` still has no caller.
- **Per-board rotation for laptops and breakpoints** — ruled out deliberately; `landscapeVariant` returns null there and the Rotate control is disabled with an explanation.
