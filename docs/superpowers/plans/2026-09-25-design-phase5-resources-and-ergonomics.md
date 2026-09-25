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
- **Never regenerate `backend/migrations/taskflow_design/0001_auto.json` or `0002_create_design_layout.json`.** No migration is expected in this plan; if one appears, a new file with a new name is the only acceptable outcome.
- Resource link schemes: **`https:` only**; `javascript:` and `data:` refused for both link and script shapes. Allowed `rel`: `preconnect`, `dns-prefetch`, `stylesheet`, `preload`.
- Backend tests: `cargo test --workspace` (**a bare `cargo test` in `backend/` silently skips every plugin crate**). Frontend: `npm test`, then `npm run build`.
- This repo has **no RTL/jsdom** — pure unit tests only, plus visual verification.
- **Publish order: the backend must deploy before the frontend.** Measured, not assumed: the deployed backend answers `403` to a realtime group it does not know and the realtime layer refuses the *entire* handshake. Phase 4's held build is still held.
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
fn a_document_without_pageLabels_still_parses() {
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
 *  own title, else the raw route. One resolver so the three places that render
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

- [ ] **Step 4: Render the label in the three places**

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

Run: `cd v2_fe && npx tsc -b && npm test && npm run build`
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

Run: `cd v2_fe && npx tsc -b && npm test && npm run build`

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
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`, `v2_fe/src/pages/design/DesignSurfacePage.tsx`

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

In `ArtboardHeader`, replace the Rotate placeholder with one that adds the board's landscape variant to `deviceIds` when one exists, and is **disabled with an explanatory title** when it does not (`landscapeVariant` returned null). Use the same `onDuplicateBoard(key, deviceId)` plumbing from Task 4 — the effect is identical — with the variant's id.

- [ ] **Step 5: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test && npm run build`

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
    parse, validate, ResourcesDoc, ResourceLink, ResourceSet, ALLOWED_REL, MAX_HREF,
    MAX_LINKS_PER_SET, MAX_SETS,
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
pub const ALLOWED_REL: &[&str] = &["preconnect", "dns-prefetch", "stylesheet", "preload"];

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
                    return Err(format!("\"{rel}\" is not an allowed link relation"));
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
- Modify: `backend/plugins/taskflow-design/src/manifest.rs`
- Modify: `backend/plugins/taskflow-design/src/composer.rs`
- Modify: `backend/plugins/taskflow-design/tests/` (a composer test)

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
    assert!(tags.contains("crossorigin") == false, "not set on these links");
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
fn the_emit_path_cannot_produce_a_dangerous_scheme() {
    // validate() is what refuses these, but the EMIT path is a second door —
    // it must not be able to render javascript:/data: even from a row written
    // out of band.
    let tags = composer::resources_tags(&[(false, lk("stylesheet", "https://ok.example/x"))]);
    assert!(!tags.contains("javascript:"), "{tags}");
    assert!(!tags.contains("data:text/html"), "{tags}");
    assert!(tags.contains("rel=\"stylesheet\""), "{tags}");
}

#[test]
fn the_sandbox_csp_allows_https_but_never_widens_dangerously() {
    let csp = composer::sandbox_csp("token");
    for directive in ["script-src", "style-src", "font-src"] {
        assert!(csp.contains(directive), "missing {directive}: {csp}");
    }
    assert!(csp.contains("https:"), "external fonts cannot load without it: {csp}");
    assert!(!csp.contains("http://"), "plain http must not be allowed: {csp}");
    assert!(!csp.contains("'unsafe-eval'"), "eval is never granted: {csp}");
}
```

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
                    if link.async_ { " async" } else { "" }
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

Insert `{resources_tags(&manifest.resources)}` into the `<head>` of **both** `compose_document` and `compose_export_document` (the export is the downloaded page — a font that does not travel with it would be a silent surprise), immediately before the tokens stylesheet link.

Then widen `sandbox_csp`: add `https:` to `script-src`, `style-src` and `font-src`, keeping the existing jsDelivr entries. Update the doc comment above it to record why the widening is bounded — separate origin, no cookies, short-lived read-only token, links supplied by the project's own members — and why the scheme refusal in `resources::validate` is what makes it acceptable.

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
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (mount it in the Tokens tab)

**Interfaces:**
- Consumes: the `DesignFile` endpoints already used by `TokenEditor` (`styles/resources.json`), and `ResourceLink`/`ResourceSet`/`ResourcesDoc` mirrored from Task 6.
- Produces: `normalizeResources(raw: unknown): ResourcesDoc`, `toggleSet(doc, id): ResourcesDoc`, `addSet(doc, name): { doc: ResourcesDoc; id: string }`, `removeSet(doc, id): ResourcesDoc`, `parsePastedLinks(text: string): ResourceLink[]`.

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
  it("picks up a script tag", () => {
    const [l] = parsePastedLinks('<script src="https://cdn.example/x.js" async></script>')
    expect(l.isScript).toBe(true)
    expect(l.script).toBe("https://cdn.example/x.js")
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

- [ ] **Step 2: Implement `src/lib/resources.ts`** to satisfy them, mirroring `design-layout.ts`'s tolerant-parse style. `parsePastedLinks` is a small regex pass over `<link …>` and `<script …>` tags, reading `rel`, `href`, `src`, `crossorigin`, `async`. It parses and does not judge.

- [ ] **Step 3: Write `resource-editor.tsx`**, modelled on `token-editor.tsx`: it loads `styles/resources.json` through the same client the TokenEditor uses, renders each set as a row with a toggle and its links, lets a set be added (with a name) or removed, and offers a paste box that runs `parsePastedLinks` and appends the result to a chosen set. Saving writes the document back via the same operator file endpoint. **On a rejected save, show the server's message** — validation refusals are the user's feedback that a URL was not https, and swallowing them would leave a dead button.

- [ ] **Step 4: Mount it** in the Tokens tab, below the token editor, since both are "how this project looks".

- [ ] **Step 5: Verify and commit**

Run: `cd v2_fe && npx tsc -b && npm test && npm run build`

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/resources.ts v2_fe/src/lib/resources.test.ts \
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

## Deferred / not in this plan

- **Item 5, the pan→select scroll freeze — a SPIKE, not a task.** Its leading theory was falsified by the user's own observation (they can highlight text, so frames do receive pointer events). Reproduce on the local stack, report the cause, and return for a decision. **No fix is written under this plan.** Re-check it *after* Task 3, since latching frames changes how many are alive.
- **The realtime suffix drift guard** was declined by the user previously; still not added. Note for the record that the failure mode is worse than assumed: a mismatch 403s the whole handshake, not one silent group.
- **Renaming a page's real title** — the user chose a display label.
- **Group rename/delete** — groups remain create-only from Phase 4; `removeGroup` still has no caller.
- **Per-board rotation for laptops and breakpoints** — ruled out deliberately; `landscapeVariant` returns null there and the Rotate control is disabled with an explanation.
