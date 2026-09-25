# Design Page Phase 4 — Three Canvas Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `bands` and `groups` canvas views alongside today's `rows`, persist the shared arrangement server-side and the per-user viewport in Dexie, and fix the header-collision and dark-mode-fringe defects.

**Architecture:** Artboards are already **derived, never stored** — `DesignSurfacePage.tsx:119` computes them from `(openRoutes, deviceIds)` and every consumer keys on `route@device`. So the two new views are pure layout functions swapped behind one selector, and nothing downstream (canvas, selection, pins, focus) changes. The arrangement document (view + groups) is a new one-row-per-project server record validated like `styles/tokens.json`; the viewport (open pages, devices, zoom, tool) is a Dexie record keyed `[userId+projectId]`.

**Tech Stack:** Rust (Umbral plugin framework, sqlx, serde, axum), React 19 + TypeScript + Vite, Tailwind, Dexie 4 + dexie-react-hooks, vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-design-phase4-canvas-views-design.md`

## Global Constraints

- **The iframe is ALWAYS the preset's true `width×height`; canvas zoom stays `transform: scale()` on the wrapper.** Never zoom by changing the iframe's CSS width — that would move the page's breakpoints. HARD CONSTRAINT carried from Phase 3.
- `MIN_SCALE = 0.25`, `MAX_SCALE = 2`, `ZOOM_STEP = 1.1` (in `design-canvas.tsx`). Do not change.
- `GUTTER = 140` (was a hardcoded 80). `HEADER_H = 28`. `CHROME_BORDER = 1`.
- Group cap **24**; group name trimmed, **1–40 chars**, unique case-insensitively. One `design_layout` row per project.
- Layout validation is **strict on write, forgiving on read**: unknown routes are rejected by `PUT`, but filtered out by `GET` so a deleted page cannot wedge a client.
- **Never regenerate `backend/migrations/taskflow_design/0001_auto.json`.** New models get a NEW migration file. Re-emitting an applied migration under the same name silently never runs on existing databases.
- Dependencies: `dexie` `^4.3.0`, `dexie-react-hooks` `^4.2.0` (both verified to resolve on npm — latest are 4.4.6 / 4.4.0).
- Backend tests: `cargo test --workspace`. **A bare `cargo test` in `backend/` silently skips every plugin crate.**
- Frontend: `npm test` (= `vitest run`), then `npm run build` (= `tsc -b && vite build`). **Run the build LAST — it is what publishes the app.**
- The repo has **no RTL/jsdom**. Canvas behaviour is unit-covered on pure helpers and verified visually; do not add a DOM test harness.
- **Commits: stage explicit paths. Never `git add -A`** — the working tree carries an unrelated modified `backend/README.md` that must not be swept in.

## Review Focus

Classes of input the spec implies but whose tests are easy to forget. Each line is pinned to the task that owns the code, in that task's steps.

1. **A stored document that is valid JSON but the wrong shape** (hand-edited row, or written by a future/older client) → `GET` must return the default document, never a 500. (Tasks 1, 3)
2. **A project whose pages were all deleted** → groups survive with empty route lists and `view` is preserved; no crash. (Task 1)
3. **A `PUT` with `view` absent, or with unknown extra fields** → defaults to `rows`; extras ignored, not rejected. (Task 1)
4. **Group names differing only by case or surrounding padding** (`"auth"` vs `" Auth "`) → duplicate, rejected — not silently accepted. (Task 1)
5. **A persisted viewport holding an out-of-range or non-finite `scale`** (hand-edited IndexedDB, or a record from another build) → clamped on hydration so the canvas never renders at scale 9 or `NaN`. (Task 9)

---

## File Structure

**Backend** (`backend/plugins/taskflow-design/`)
- `src/layout_doc.rs` — NEW. The layout document: types, default, tolerant parse, strict validate, read-side filtering. Pure, no IO.
- `src/models.rs` — MODIFY. `DesignView` enum + `DesignLayout` row.
- `src/lib.rs` — MODIFY. `pub mod layout_doc;` + register the model.
- `src/views.rs` — MODIFY. `get_layout` / `put_layout` handlers + shared `known_routes` helper.
- `src/urls.rs` — MODIFY. Two routes.
- `tests/layout_doc.rs` — NEW. Pure unit tests.
- `tests/phase7_layout_endpoint.rs` — NEW. Handler tests over the real router.
- `backend/migrations/taskflow_design/0002_create_design_layout.json` — GENERATED (the tool names the file after the change, not `_auto`).

**Frontend** (`v2_fe/`)
- `src/lib/design-layout.ts` — NEW. Document types + pure edit helpers (`createGroup`, `assignRoute`, …) + tolerant `normalizeLayout`. No device imports, so `design-devices.ts` can depend on it one-way.
- `src/lib/design-devices.ts` — MODIFY. `GUTTER`/`HEADER_H`/`boardWidth`/`boardHeight`, updated `layoutRows`, new `layoutBands`/`layoutGroups`/`boardsForView`.
- `src/lib/design-api.ts` — MODIFY. `fetchLayout` / `saveLayout`, reusing the existing (unexported) `designFetch`/`jsonInit`.
- `src/pages/design/design-ui-state.ts` — NEW. Dexie store + pure tolerant `parseUIState`. **Lives in `pages/design/`, not `lib/`,** so it can import `MIN_SCALE`/`MAX_SCALE` from `design-canvas` the way `canvas-view.ts` already does, instead of a `lib/` → `pages/` import.
- `src/pages/design/design-view.ts` — NEW. Pure view-picker options + `shouldSeedRoutes` (the hydration-vs-manifest-seed decision).
- `src/pages/design/DesignSurfacePage.tsx` — MODIFY. View picker, hydration gate, layout load/save, `boardsForView`.
- `src/pages/design/pages-panel.tsx` — NEW. `PagesPanel` extracted from `DesignSurfacePage.tsx` (already 979 lines) + the per-page group picker.
- `src/pages/design/design-canvas.tsx` — MODIFY. Header containment + dark backdrops.

Test files sit beside their subjects: `design-devices.test.ts`, `design-layout.test.ts`, `design-view.test.ts`, `design-ui-state.test.ts`.

---

### Task 1: Backend — the layout document (pure)

**Files:**
- Create: `backend/plugins/taskflow-design/src/layout_doc.rs`
- Create: `backend/plugins/taskflow-design/tests/layout_doc.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (add `pub mod layout_doc;` beside the other `pub mod` lines)

**Interfaces:**
- Consumes: `crate::models::DesignView` (created in Task 2 — for this task, define `DesignView` in `models.rs` first, see Step 3a).
- Produces: `LayoutGroup { id: String, name: String, routes: Vec<String> }`, `LayoutDoc { view: DesignView, route_order: Vec<String>, groups: Vec<LayoutGroup> }`, `default_doc() -> LayoutDoc`, `parse(&str) -> Result<LayoutDoc, String>`, `to_json_string(&LayoutDoc) -> String`, `to_value(&LayoutDoc) -> serde_json::Value`, `validate(LayoutDoc, &[String]) -> Result<LayoutDoc, String>`, `filter_to_known(LayoutDoc, &[String]) -> LayoutDoc`, `const MAX_GROUPS: usize = 24`, `const MAX_GROUP_NAME: usize = 40`.

- [ ] **Step 1: Add `DesignView` to `models.rs`** (Task 2 needs it too; it lives here because it is a column type)

```rust
/// Which arrangement the canvas uses. Stored as a column, so the choice is
/// shared per project rather than per viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum DesignView {
    #[default]
    Rows,
    Bands,
    Groups,
}
```

- [ ] **Step 2: Write the failing tests** — `tests/layout_doc.rs`

```rust
use taskflow_design::layout_doc::{
    default_doc, filter_to_known, parse, to_json_string, to_value, validate, LayoutDoc, LayoutGroup,
    MAX_GROUPS,
};
use taskflow_design::models::DesignView;

fn group(id: &str, name: &str, routes: &[&str]) -> LayoutGroup {
    LayoutGroup {
        id: id.into(),
        name: name.into(),
        routes: routes.iter().map(|r| r.to_string()).collect(),
    }
}

fn known() -> Vec<String> {
    ["/", "/login", "/signup"].iter().map(|s| s.to_string()).collect()
}

fn doc(view: DesignView, groups: Vec<LayoutGroup>) -> LayoutDoc {
    LayoutDoc { view, route_order: vec!["/".into()], groups }
}

#[test]
fn default_is_rows_with_nothing_grouped() {
    let d = default_doc();
    assert_eq!(d.view, DesignView::Rows);
    assert!(d.groups.is_empty());
    assert!(d.route_order.is_empty());
}

#[test]
fn round_trips_through_camel_case_json() {
    let d = doc(DesignView::Groups, vec![group("g1", "Auth", &["/login"])]);
    let json = to_json_string(&d);
    // The wire field is `routeOrder`, and the view is a lowercase string.
    assert!(json.contains("\"routeOrder\""), "{json}");
    assert!(json.contains("\"groups\""), "{json}");
    assert!(json.contains("\"view\":\"groups\""), "{json}");
    assert_eq!(parse(&json).unwrap(), d);
}

#[test]
fn missing_view_defaults_to_rows_and_extra_fields_are_ignored() {
    // Review Focus #3: forward/backward compatibility of the stored document.
    let d = parse(r#"{"groups":[],"routeOrder":["/"],"futureField":1}"#).unwrap();
    assert_eq!(d.view, DesignView::Rows);
    assert_eq!(d.route_order, vec!["/".to_string()]);
}

#[test]
fn garbage_json_is_an_error_not_a_panic() {
    // Review Focus #1: the handler falls back to the default on this.
    assert!(parse("not json at all").is_err());
    assert!(parse(r#"{"groups":"auth"}"#).is_err());
    assert!(parse(r#"{"groups":[{"id":"g1"}]}"#).is_err());
}

#[test]
fn rejects_unknown_view_name() {
    assert!(validate(doc(DesignView::Rows, vec![]), &known()).is_ok());
    assert!(parse(r#"{"view":"diagonal","groups":[],"routeOrder":[]}"#).is_err());
}

#[test]
fn rejects_more_than_max_groups() {
    let many: Vec<LayoutGroup> = (0..=MAX_GROUPS)
        .map(|i| group(&format!("g{i}"), &format!("G{i}"), &[]))
        .collect();
    assert!(validate(doc(DesignView::Groups, many), &known()).is_err());
}

#[test]
fn rejects_duplicate_names_case_insensitively_and_untrimmed() {
    // Review Focus #4: padding and case are the same group to a human.
    let dupes = vec![group("g1", "Auth", &[]), group("g2", "auth", &[])];
    assert!(validate(doc(DesignView::Groups, dupes), &known()).is_err());

    let padded = vec![group("g1", "Auth", &[]), group("g2", " Auth ", &[])];
    assert!(validate(doc(DesignView::Groups, padded), &known()).is_err());

    let empty = vec![group("g1", "   ", &[])];
    assert!(validate(doc(DesignView::Groups, empty), &known()).is_err());

    let too_long = vec![group("g1", &"x".repeat(41), &[])];
    assert!(validate(doc(DesignView::Groups, too_long), &known()).is_err());
}

#[test]
fn rejects_a_route_in_two_groups_and_unknown_routes() {
    let twice = vec![group("g1", "Auth", &["/login"]), group("g2", "More", &["/login"])];
    assert!(validate(doc(DesignView::Groups, twice), &known()).is_err());

    // A ghost route would render an empty board forever.
    let ghost = vec![group("g1", "Auth", &["/nope"])];
    assert!(validate(doc(DesignView::Groups, ghost), &known()).is_err());
}

#[test]
fn validate_normalises_names_on_the_way_through() {
    let d = validate(
        doc(DesignView::Groups, vec![group("g1", "  Auth  ", &["/login"])]),
        &known(),
    )
    .unwrap();
    assert_eq!(d.groups[0].name, "Auth");
}

#[test]
fn filter_keeps_groups_whose_routes_all_vanished() {
    // Review Focus #2: deleting pages must not delete the grouping.
    let d = doc(
        DesignView::Groups,
        vec![group("g1", "Auth", &["/login", "/gone"]), group("g2", "Dead", &["/gone"])],
    );
    let out = filter_to_known(d, &known());
    assert_eq!(out.view, DesignView::Groups, "view survives");
    assert_eq!(out.groups[0].routes, vec!["/login".to_string()]);
    assert!(out.groups[1].routes.is_empty(), "empty group survives");
    assert_eq!(out.route_order, vec!["/".to_string()]);
}

#[test]
fn filter_drops_vanish_via_empty_manifest() {
    let d = doc(DesignView::Groups, vec![group("g1", "Auth", &["/login"])]);
    let out = filter_to_known(d, &[]);
    assert_eq!(out.groups.len(), 1);
    assert!(out.groups[0].routes.is_empty());
    assert!(out.route_order.is_empty());
}

#[test]
fn to_value_emits_the_wire_shape() {
    let v = to_value(&doc(DesignView::Bands, vec![]));
    assert_eq!(v["view"], "bands");
    assert!(v["routeOrder"].is_array());
    assert!(v["groups"].is_array());
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && cargo test --workspace -p taskflow-design --test layout_doc`
Expected: compile error — `layout_doc` module does not exist.

- [ ] **Step 4: Write the implementation** — `src/layout_doc.rs`

```rust
//! The design-layout document: which arrangement the canvas uses, the canonical
//! page order, and the named page groups.
//!
//! One JSON document per project, for the same reason `styles/tokens.json` is
//! one document: order IS the content here, so normalising groups into rows
//! would buy nothing and cost an ordering column.
//!
//! Two directions, deliberately asymmetric (spec §A):
//!   * `validate` is STRICT — a caller sending a route we cannot render is
//!     told so, rather than silently storing a board that will never be drawn.
//!   * `filter_to_known` is FORGIVING — a stored document outlives the pages it
//!     names, and refusing to serve it would wedge the client against a
//!     document it has no way to repair.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::models::DesignView;

pub const MAX_GROUPS: usize = 24;
pub const MAX_GROUP_NAME: usize = 40;
const MAX_GROUP_ID: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub routes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDoc {
    #[serde(default)]
    pub view: DesignView,
    #[serde(default)]
    pub route_order: Vec<String>,
    #[serde(default)]
    pub groups: Vec<LayoutGroup>,
}

/// What a project has before anyone has arranged anything: today's view, every
/// page in manifest order, nothing grouped.
pub fn default_doc() -> LayoutDoc {
    LayoutDoc { view: DesignView::Rows, route_order: Vec::new(), groups: Vec::new() }
}

/// Tolerant on shape, strict on syntax. A caller that cannot parse falls back to
/// `default_doc()` rather than erroring the read.
pub fn parse(raw: &str) -> Result<LayoutDoc, String> {
    serde_json::from_str::<LayoutDoc>(raw).map_err(|e| format!("invalid layout document: {e}"))
}

pub fn to_json_string(doc: &LayoutDoc) -> String {
    // Serialising our own plain struct cannot fail; a panic here would be a bug
    // in this module, not bad input.
    serde_json::to_string(doc).expect("LayoutDoc serialises")
}

pub fn to_value(doc: &LayoutDoc) -> serde_json::Value {
    serde_json::to_value(doc).expect("LayoutDoc serialises")
}

/// Strict: everything a client sends must be renderable against the live
/// manifest. Names are trimmed and the document comes back normalised, so what
/// is stored is exactly what a later read will parse.
pub fn validate(doc: LayoutDoc, known_routes: &[String]) -> Result<LayoutDoc, String> {
    if doc.groups.len() > MAX_GROUPS {
        return Err(format!("at most {MAX_GROUPS} pages groups are allowed"));
    }
    let known: HashSet<&str> = known_routes.iter().map(String::as_str).collect();

    let mut seen_names: HashSet<String> = HashSet::new();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut groups = Vec::with_capacity(doc.groups.len());

    for group in doc.groups {
        let name = group.name.trim().to_string();
        if name.is_empty() {
            return Err("a group name cannot be empty".into());
        }
        if name.chars().count() > MAX_GROUP_NAME {
            return Err(format!("a group name is limited to {MAX_GROUP_NAME} characters"));
        }
        if !seen_names.insert(name.to_lowercase()) {
            return Err(format!("the group name \"{name}\" is already used"));
        }
        let id = group.id.trim().to_string();
        if id.is_empty() || id.chars().count() > MAX_GROUP_ID {
            return Err("a group needs a non-empty id of at most 64 characters".into());
        }

        let mut routes = Vec::with_capacity(group.routes.len());
        for route in group.routes {
            if !known.contains(route.as_str()) {
                return Err(format!("\"{route}\" is not a page in this project"));
            }
            if !claimed.insert(route.clone()) {
                return Err(format!("\"{route}\" is already in another group"));
            }
            routes.push(route);
        }
        groups.push(LayoutGroup { id, name, routes });
    }

    // Order is advisory but still names pages, so unknown entries are refused
    // for the same reason as group routes: a client sending one is stale.
    let mut route_order = Vec::with_capacity(doc.route_order.len());
    let mut seen_order: HashSet<String> = HashSet::new();
    for route in doc.route_order {
        if !known.contains(route.as_str()) {
            return Err(format!("\"{route}\" is not a page in this project"));
        }
        if seen_order.insert(route.clone()) {
            route_order.push(route);
        }
    }

    Ok(LayoutDoc { view: doc.view, route_order, groups })
}

/// Forgiving read path: drop routes the manifest no longer has, keep the group
/// (a grouping is a decision about the project, and one deleted page is not
/// grounds to throw it away).
pub fn filter_to_known(doc: LayoutDoc, known_routes: &[String]) -> LayoutDoc {
    let known: HashSet<&str> = known_routes.iter().map(String::as_str).collect();
    LayoutDoc {
        view: doc.view,
        route_order: doc
            .route_order
            .into_iter()
            .filter(|r| known.contains(r.as_str()))
            .collect(),
        groups: doc
            .groups
            .into_iter()
            .map(|g| LayoutGroup {
                routes: g.routes.into_iter().filter(|r| known.contains(r.as_str())).collect(),
                ..g
            })
            .collect(),
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && cargo test --workspace -p taskflow-design --test layout_doc`
Expected: 12 passed.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/layout_doc.rs \
        backend/plugins/taskflow-design/src/models.rs \
        backend/plugins/taskflow-design/src/lib.rs \
        backend/plugins/taskflow-design/tests/layout_doc.rs
git commit -m "feat(design): layout document type, strict validate + forgiving read filter"
```

---

### Task 2: Backend — `DesignLayout` row + generated migration

**Files:**
- Modify: `backend/plugins/taskflow-design/src/models.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs`
- Generate: `backend/migrations/taskflow_design/0002_<name>.json` (the makemigrations tool names it after the change — as shipped this was `0002_create_design_layout.json`)

**Interfaces:**
- Consumes: `DesignView` (Task 1, Step 1).
- Produces: `DesignLayout` model + the generated `design_layout` table module `design_layout::{ID, PROJECT, VIEW, LAYOUT_JSON, UPDATED_BY, UPDATED_AT}`.

- [ ] **Step 1: Add the model** to `src/models.rs`

```rust
/// The project's canvas arrangement — one row per project (unique together on
/// `project`), so "how this project's pages are laid out" is shared rather than
/// per-viewer. The document itself lives in `layout_json`; see `layout_doc`.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project"]])]
pub struct DesignLayout {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(choices, default = "rows")]
    pub view: DesignView,
    /// The serialised `layout_doc::LayoutDoc`. Capped well above any real
    /// document (24 groups × 40-char names); the column allows more so an
    /// oversized reject is still inspectable in the admin.
    #[umbral(string, max_length = 65_536, widget = "textarea")]
    pub layout_json: String,
    #[umbral(string, max_length = 120)]
    pub updated_by: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}
```

- [ ] **Step 2: Register the model** in `src/lib.rs` `models()`

```rust
    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::DesignFile>(),
            umbral::migrate::ModelMeta::for_::<models::DesignComment>(),
            umbral::migrate::ModelMeta::for_::<models::DesignLayout>(),
        ]
    }
```

- [ ] **Step 3: Generate the migration**

Run: `cd backend && cargo run -- makemigrations`
Expected: a new file `migrations/taskflow_design/0002_*.json`. **The tool names it after the change, not `_auto`** — and `MigrationFile.id` must match the filename stem, so never rename it.

- [ ] **Step 4: Verify the generated migration touched ONLY the new table**

Run:
```bash
cd backend && python3 -c "
import json
import glob; f = sorted(glob.glob('migrations/taskflow_design/0002_*.json'))[0]
d = json.load(open(f))
print('id:', d['id'], '| ops:', [ (o['kind'], o.get('table')) for o in d['operations'] ])
"
```
Expected: exactly one operation, `('CreateTable', 'design_layout')`.

**If it lists any operation touching `design_file` or `design_comment`, STOP and report** — that means an applied migration drifted, and applying a rewritten `0001` to an existing database would silently do nothing (see Global Constraints).

- [ ] **Step 5: Verify the migration applies and is idempotent**

Run: `cd backend && cargo run -- migrate && cargo run -- showmigrations 2>&1 | tail -20`
Expected: the `0002_*` migration listed as applied; re-running `cargo run -- migrate` reports nothing to do.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/models.rs \
        backend/plugins/taskflow-design/src/lib.rs \
        backend/migrations/taskflow_design/0002_create_design_layout.json
git commit -m "feat(design): design_layout row (one per project) + migration"
```

---

### Task 3: Backend — `GET`/`PUT /api/design/{project}/layout`

**Files:**
- Modify: `backend/plugins/taskflow-design/src/views.rs` (add near `get_manifest`, ~line 143)
- Modify: `backend/plugins/taskflow-design/src/urls.rs` (add beside the `comments` routes)
- Create: `backend/plugins/taskflow-design/tests/phase7_layout_endpoint.rs`

**Interfaces:**
- Consumes: `layout_doc::*` (Task 1), `DesignLayout` (Task 2), existing `ensure_member` / `load_caller` / `operator_attribution` / `store::list_files` / `manifest::build`.
- Produces: `GET /api/design/{project}/layout` and `PUT /api/design/{project}/layout`, both returning the document as `{"view","routeOrder","groups"}`.

- [ ] **Step 1: Write the failing tests** — `tests/phase7_layout_endpoint.rs`

```rust
//! Phase 4 acceptance: the shared layout document endpoint.
//!
//! A project with no arrangement reads the default (never a 404 to special-case
//! on the client); a PUT stores and echoes it; unknown routes are refused on
//! write but filtered out on read.

mod support;

use serde_json::json;
use support::TestApp;

async fn app_with_project() -> (TestApp, i64, i64) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    (app, project, user.id)
}

#[tokio::test(flavor = "multi_thread")]
async fn get_returns_the_default_layout_for_a_fresh_project() {
    let (app, project, user) = app_with_project().await;
    let res = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let v = res.json();
    assert_eq!(v["view"], "rows");
    assert_eq!(v["groups"].as_array().unwrap().len(), 0);
    assert!(v["routeOrder"].is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn put_then_get_round_trips_the_document() {
    let (app, project, user) = app_with_project().await;
    let body = json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [{ "id": "g1", "name": "Auth", "routes": [] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["view"], "groups");

    let read = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    let v = read.json();
    assert_eq!(v["view"], "groups");
    assert_eq!(v["groups"][0]["name"], "Auth");
}

#[tokio::test(flavor = "multi_thread")]
async fn put_rejects_a_route_that_is_not_a_page() {
    let (app, project, user) = app_with_project().await;
    let body = json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [{ "id": "g1", "name": "Auth", "routes": ["/nope"] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn put_ignores_unknown_fields_and_defaults_a_missing_view() {
    // Review Focus #3.
    let (app, project, user) = app_with_project().await;
    let body = json!({ "routeOrder": [], "groups": [], "somethingNew": true });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["view"], "rows");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_member_cannot_read_or_write_the_layout() {
    let (app, project, _user) = app_with_project().await;
    let (outsider, _other_project) = app.create_member_with_project().await;
    let get = app.get_as(outsider.id, &format!("/api/design/{project}/layout")).await;
    assert_eq!(get.status(), 403);
    let put = app
        .put_json_as(outsider.id, &format!("/api/design/{project}/layout"), &json!({"groups":[]}))
        .await;
    assert_eq!(put.status(), 403);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && cargo test --workspace -p taskflow-design --test phase7_layout_endpoint`
Expected: 404s / assertion failures — the route does not exist yet.

- [ ] **Step 3: Write the handlers** — append to `src/views.rs`

```rust
/// The manifest's route paths — the set a layout document is allowed to name.
/// Built from the same files `get_manifest` reads, so the two can never
/// disagree about which pages exist.
async fn known_routes(project_id: i64) -> Vec<String> {
    let files = store::list_files(project_id).await;
    let manifest = manifest::build(project_id, &files, 0);
    manifest.routes.iter().map(|r| r.path.clone()).collect()
}

/// `GET /api/design/{project}/layout` — the shared arrangement.
///
/// Always 200: a project that has never been arranged reads the default
/// document, so the client has one code path. A stored document that will not
/// parse (hand-edited, or written by a build with a different shape) degrades
/// to the default rather than failing the read — the alternative is a canvas
/// that cannot load and no way for the operator to repair it from the UI.
pub async fn get_layout(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let known = known_routes(project_id).await;

    let stored = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let doc = stored
        .and_then(|row| layout_doc::parse(&row.layout_json).ok())
        .unwrap_or_else(layout_doc::default_doc);

    Ok(Json(layout_doc::to_value(&layout_doc::filter_to_known(doc, &known))))
}

/// `PUT /api/design/{project}/layout` — replace the arrangement.
///
/// Last-write-wins: this is a settings document, not versioned content, so
/// there is no `base_version` 409 here (contrast `DesignFile`, where a stale
/// write would destroy an agent's work).
pub async fn put_layout(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<layout_doc::LayoutDoc>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let caller = load_caller(user_id).await?;
    let known = known_routes(project_id).await;

    let doc = layout_doc::validate(input, &known).map_err(|_| StatusCode::BAD_REQUEST)?;
    let json = layout_doc::to_json_string(&doc);
    let by = operator_attribution(&caller);

    let existing = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match existing {
        Some(row) => {
            DesignLayout::objects()
                .filter(design_layout::ID.eq(row.id))
                // `update_values` takes a Map, not a Value — this wrapper is the
                // house idiom, identical to `store.rs:173-183`.
                .update_values(
                    serde_json::json!({
                        "view": doc.view,
                        "layout_json": json,
                        "updated_by": by,
                        "updated_at": chrono::Utc::now(),
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                )
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        None => {
            DesignLayout::objects()
                .create(DesignLayout {
                    id: 0,
                    project: umbral::orm::ForeignKey::new(project_id),
                    view: doc.view,
                    layout_json: json,
                    updated_by: by,
                    created_at: None,
                    updated_at: None,
                })
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }

    Ok(Json(layout_doc::to_value(&doc)))
}
```

Add to the `use` block at the top of `views.rs`:

```rust
use crate::layout_doc;
use crate::models::{design_layout, DesignLayout};
```

- [ ] **Step 4: Add the routes** to `src/urls.rs`, beside the `comments` entries

```rust
        .route(
            "/api/design/{project}/layout",
            get(views::get_layout).put(views::put_layout),
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && cargo test --workspace -p taskflow-design --test phase7_layout_endpoint`
Expected: 5 passed.

- [ ] **Step 6: Run the whole workspace suite**

Run: `cd backend && cargo test --workspace`
Expected: all green. **Not** a bare `cargo test` — that skips plugin crates.

- [ ] **Step 7: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/plugins/taskflow-design/src/views.rs \
        backend/plugins/taskflow-design/src/urls.rs \
        backend/plugins/taskflow-design/tests/phase7_layout_endpoint.rs
git commit -m "feat(design): GET/PUT /layout backed by the shared arrangement document"
```

---

### Task 4: Frontend — chrome-aware board metrics, gutter 140, updated `layoutRows`

**Files:**
- Modify: `v2_fe/package.json` (add `dexie`, `dexie-react-hooks`)
- Modify: `v2_fe/src/lib/design-devices.ts:137-184`
- Modify: `v2_fe/src/lib/design-devices.test.ts`

**Interfaces:**
- Produces: `const GUTTER = 140`, `const HEADER_H = 28`, `boardWidth(device: DevicePreset): number`, `boardHeight(device: DevicePreset): number`; `layoutRows` keeps its signature but returns the new geometry.

- [ ] **Step 1: Install the dependencies**

Run: `cd v2_fe && npm install dexie@^4.3.0 dexie-react-hooks@^4.2.0`
Expected: both appear in `dependencies`. (Installed here rather than in Task 9 so every later `npm test` run has them.)

- [ ] **Step 2: Update the existing `layoutRows` test to the new geometry** — in `src/lib/design-devices.test.ts`, replace the body of `it("layoutRows: one row per route, one column per device, no overlaps", ...)` with:

```ts
  it("layoutRows: one row per route, one column per device, no overlaps", () => {
    const boards = layoutRows(["/", "/about"], ["iphone-16-pro", "laptop"])
    expect(boards).toHaveLength(4)

    const iphone = deviceById("iphone-16-pro")
    const laptop = deviceById("laptop")

    const row0 = boards.filter((b) => b.route === "/")
    const row1 = boards.filter((b) => b.route === "/about")
    expect(row0).toHaveLength(2)
    expect(row1).toHaveLength(2)

    for (const b of row0) expect(b.y).toBe(0)

    // Columns step by the board's REAL width — device px plus its bezel — not
    // by the bare iframe width. A phone is 26px wider than `width` claims.
    const row0Iphone = row0.find((b) => b.deviceId === "iphone-16-pro")!
    const row0Laptop = row0.find((b) => b.deviceId === "laptop")!
    expect(row0Iphone.x).toBe(0)
    expect(row0Laptop.x).toBe(boardWidth(iphone) + GUTTER)
    expect(boardWidth(iphone)).toBe(393 + 12 + 12 + 2)

    // The next row clears the tallest board AND its header, which renders
    // above the board and so is not covered by the board's own height.
    const rowHeight = Math.max(boardHeight(iphone), boardHeight(laptop))
    for (const b of row1) expect(b.y).toBe(HEADER_H + rowHeight + GUTTER)

    expect(row0Iphone.key).toBe("/@iphone-16-pro")
    expect(row0Laptop.key).toBe("/@laptop")
    expect(row1.find((b) => b.deviceId === "iphone-16-pro")!.key).toBe("/about@iphone-16-pro")
    expect(row1.find((b) => b.deviceId === "laptop")!.key).toBe("/about@laptop")
  })
```

Update that file's import list to pull in the new names:

```ts
  GUTTER,
  HEADER_H,
  boardHeight,
  boardWidth,
```

- [ ] **Step 3: Add the new metric tests** to the same file

```ts
  it("boardWidth/boardHeight count the bezel and the 1px border", () => {
    // Phone bezel is 12 left + 12 right; tablet is 14 all round.
    expect(boardWidth(deviceById("iphone-16-pro"))).toBe(393 + 24 + 2)
    expect(boardHeight(deviceById("iphone-16-pro"))).toBe(852 + 44 + 2)
    expect(boardWidth(deviceById("ipad-mini"))).toBe(744 + 28 + 2)
    // Laptops and breakpoints are flush on the sides.
    expect(boardWidth(deviceById("laptop"))).toBe(1280 + 0 + 2)
    expect(boardWidth(deviceById("bp-sm"))).toBe(640 + 0 + 2)
  })
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-devices`
Expected: FAIL — `boardWidth is not a function` / `GUTTER is not defined`.

- [ ] **Step 5: Implement** — in `src/lib/design-devices.ts`, replace the `layoutRows` block (from the `Artboard` doc comment at line 137 through the end of the file) with:

```ts
/// An artboard: one route rendered at one device size. Position is derived,
/// not persisted — the `layout*` functions recompute x/y from the open routes
/// and selected devices on every render, so the canvas geometry is chrome
/// state, not design data.
export type Artboard = {
  /** Stable key: `${route}@${deviceId}` */
  key: string
  route: string
  deviceId: string
  x: number
  y: number
}

export function artboardKey(route: string, deviceId: string): string {
  return `${route}@${deviceId}`
}

export function makeArtboard(route: string, deviceId: string, x: number, y: number): Artboard {
  return { key: artboardKey(route, deviceId), route, deviceId, x, y }
}

/** Screen-space gap between two boards. Wide enough that a board's header —
 *  the route name plus its action buttons — cannot reach the next board. */
export const GUTTER = 140

/** Height of the per-board header row (`ArtboardHeader`). It renders ABOVE the
 *  board, so every stacking calculation has to add it: the board's own height
 *  does not include it, and a row that only cleared the board would put the
 *  next row's header *inside* this one's frame. */
export const HEADER_H = 28

/** The 1px border `DeviceChrome` draws around the bezel. */
const CHROME_BORDER = 1

/** How wide a board actually renders: the iframe's true device px plus the
 *  decorative bezel and border around it. Phone bezels are 12px a side, so a
 *  phone board is 26px wider than `device.width` — the old layout maths used
 *  the bare width and quietly overlapped neighbours. */
export function boardWidth(device: DevicePreset): number {
  const padding = chromeStyleForGroup(device.group).padding
  return device.width + padding.left + padding.right + CHROME_BORDER * 2
}

/** How tall a board actually renders (see `boardWidth`). */
export function boardHeight(device: DevicePreset): number {
  const padding = chromeStyleForGroup(device.group).padding
  return device.height + padding.top + padding.bottom + CHROME_BORDER * 2
}

/// Today's arrangement: one ROW per page, one COLUMN per selected device.
/// PURE: same inputs always produce the same boards, in the same order, so
/// callers can memoize on `[openRoutes, deviceIds]`.
export function layoutRows(openRoutes: string[], deviceIds: string[], gutter = GUTTER): Artboard[] {
  const devices = deviceIds.map((id) => deviceById(id))
  const rowHeight = devices.length ? Math.max(...devices.map(boardHeight)) : 0

  const boards: Artboard[] = []
  let y = 0
  for (const route of openRoutes) {
    let x = 0
    for (const device of devices) {
      boards.push(makeArtboard(route, device.id, x, y))
      x += boardWidth(device) + gutter
    }
    y += HEADER_H + rowHeight + gutter
  }
  return boards
}

/// The transpose of `layoutRows`: one BAND per device, that device's pages
/// running left→right across the band, the next device's band below it. Lets
/// you read one device's whole flow in a single line.
export function layoutBands(openRoutes: string[], deviceIds: string[], gutter = GUTTER): Artboard[] {
  const boards: Artboard[] = []
  let y = 0
  for (const deviceId of deviceIds) {
    const device = deviceById(deviceId)
    let x = 0
    for (const route of openRoutes) {
      boards.push(makeArtboard(route, deviceId, x, y))
      x += boardWidth(device) + gutter
    }
    y += HEADER_H + boardHeight(device) + gutter
  }
  return boards
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-devices`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/package.json v2_fe/package-lock.json \
        v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts
git commit -m "feat(design): chrome-aware board metrics, gutter 140, bands layout"
```

---

### Task 5: Frontend — `layoutGroups`

**Files:**
- Modify: `v2_fe/src/lib/design-layout.ts` (create it here — it holds only types, no device imports)
- Modify: `v2_fe/src/lib/design-devices.ts`
- Modify: `v2_fe/src/lib/design-devices.test.ts`

**Interfaces:**
- Consumes: `boardWidth`/`boardHeight`/`HEADER_H`/`GUTTER`/`makeArtboard` (Task 4).
- Produces: `layoutGroups(openRoutes: string[], deviceIds: string[], groups: LayoutGroup[], gutter?: number): Artboard[]`, and imports `LayoutGroup` from `./design-layout`.

- [ ] **Step 1: Create `src/lib/design-layout.ts` with just the types** (the edit helpers arrive in Task 7)

```ts
/// The canvas arrangement document — mirrors the backend's `layout_doc::LayoutDoc`
/// serde shape exactly.
///
/// Deliberately free of any device/preset import so `design-devices.ts` can
/// depend on it one-way; the layout *engines* live there.

export type CanvasView = "rows" | "bands" | "groups"

export type LayoutGroup = { id: string; name: string; routes: string[] }

export type LayoutDoc = {
  view: CanvasView
  routeOrder: string[]
  groups: LayoutGroup[]
}

export const DEFAULT_LAYOUT: LayoutDoc = { view: "rows", routeOrder: [], groups: [] }
```

- [ ] **Step 2: Write the failing tests** — append to `src/lib/design-devices.test.ts`

```ts
  it("layoutGroups: groups are vertical columns, ungrouped flows right in one row", () => {
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Ops", routes: ["/ops"] },
    ]
    const open = ["/", "/login", "/signup", "/ops", "/about"]
    const boards = layoutGroups(open, ["laptop"], groups)
    expect(boards).toHaveLength(5)

    const at = (route: string) => boards.find((b) => b.route === route)!
    const laptop = deviceById("laptop")
    const colStep = boardWidth(laptop) + GUTTER
    const rowStep = HEADER_H + boardHeight(laptop) + GUTTER

    // Group 1 is the first column: its pages stack downward.
    expect(at("/login").x).toBe(0)
    expect(at("/login").y).toBe(0)
    expect(at("/signup").x).toBe(0)
    expect(at("/signup").y).toBe(rowStep)

    // Group 2 is the next column, starting back at the band top.
    expect(at("/ops").x).toBe(colStep)
    expect(at("/ops").y).toBe(0)

    // Ungrouped pages flow right of every group column, all on the band's top row.
    expect(at("/").x).toBe(colStep * 2)
    expect(at("/").y).toBe(0)
    expect(at("/about").x).toBe(colStep * 3)
    expect(at("/about").y).toBe(0)
  })

  it("layoutGroups: only OPEN pages appear, and an empty group takes no space", () => {
    const groups = [
      { id: "g1", name: "Auth", routes: ["/login", "/signup"] },
      { id: "g2", name: "Empty", routes: ["/gone"] },
    ]
    const boards = layoutGroups(["/", "/signup"], ["laptop"], groups)
    expect(boards.map((b) => b.route).sort()).toEqual(["/", "/signup"])

    const colStep = boardWidth(deviceById("laptop")) + GUTTER
    // The emptied group takes no space, so the ungrouped row sits one column
    // in — not two — even though it is the third group in document order.
    expect(boards.find((b) => b.route === "/")!.x).toBe(colStep)
    expect(boards.find((b) => b.route === "/signup")!.x).toBe(0)
  })

  it("layoutGroups: bands per device, each device starting its own band", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    const boards = layoutGroups(["/", "/login"], ["laptop", "bp-sm"], groups)
    const laptop = deviceById("laptop")
    const bandStep = HEADER_H + boardHeight(laptop) + GUTTER
    const bpRow = boards.filter((b) => b.deviceId === "bp-sm")
    for (const b of bpRow) expect(b.y).toBe(bandStep)
  })

  it("layoutGroups is deterministic", () => {
    const groups = [{ id: "g1", name: "Auth", routes: ["/login"] }]
    expect(layoutGroups(["/", "/login"], ["laptop"], groups)).toEqual(
      layoutGroups(["/", "/login"], ["laptop"], groups),
    )
  })
```

Add `layoutGroups` to that file's imports from `./design-devices`.

- [ ] **Step 3: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-devices`
Expected: FAIL — `layoutGroups is not a function`.

- [ ] **Step 4: Implement** — append to `src/lib/design-devices.ts`, and add `import type { LayoutGroup } from "./design-layout"` at the top.

```ts
/// The free-form arrangement: still one band per device, but within a band each
/// named group is a vertical COLUMN of its pages, and pages in no group flow
/// right of every group column.
///
/// Ungrouped pages deliberately stay on ONE row (no wrapping): the band grows
/// wider rather than deeper. Balanced packing of a long ungrouped tail is a
/// real design choice and is deferred — see the spec's §C.
export function layoutGroups(
  openRoutes: string[],
  deviceIds: string[],
  groups: LayoutGroup[],
  gutter = GUTTER,
): Artboard[] {
  const grouped = new Set(groups.flatMap((g) => g.routes))
  const ungrouped = openRoutes.filter((r) => !grouped.has(r))

  const boards: Artboard[] = []
  let y = 0

  for (const deviceId of deviceIds) {
    const device = deviceById(deviceId)
    const columnStep = boardWidth(device) + gutter
    const rowStep = HEADER_H + boardHeight(device) + gutter

    // One column per group (document order), then the ungrouped tail. A column
    // with nothing open takes no space, so no phantom gap appears.
    const columns: string[][] = groups.map((g) => g.routes.filter((r) => openRoutes.includes(r)))
    // Each ungrouped page is its OWN one-board column. Pushing `ungrouped` as a
    // single column would STACK the tail vertically, which is the opposite of
    // the spec's "single row, top-aligned, no wrapping" — and it fails this
    // task's own first test.
    for (const route of ungrouped) columns.push([route])

    let x = 0
    let bandHeight = 0
    for (const routes of columns) {
      if (!routes.length) continue
      for (let i = 0; i < routes.length; i++) {
        boards.push(makeArtboard(routes[i], deviceId, x, y + i * rowStep))
      }
      // The deepest board's BOTTOM, as a footprint measured from the band's
      // top: `(n-1)` full row steps plus one board-with-header. NOT `n * S` —
      // that under-counts the gaps between stacked boards, leaving no clearance
      // at depth 2 and a `gutter`-sized OVERLAP at depth 3+. The `+ gutter`
      // below is what supplies the inter-band gutter; this value is a
      // footprint, not an advance.
      bandHeight = Math.max(
        bandHeight,
        (routes.length - 1) * rowStep + HEADER_H + boardHeight(device),
      )
      x += columnStep
    }
    y += bandHeight + gutter
  }

  return boards
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-devices`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-layout.ts \
        v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts
git commit -m "feat(design): groups layout — vertical group columns, ungrouped tail flows right"
```

---

### Task 6: Frontend — `boardsForView` selector

**Files:**
- Modify: `v2_fe/src/lib/design-devices.ts`
- Modify: `v2_fe/src/lib/design-devices.test.ts`

**Interfaces:**
- Consumes: `layoutRows`/`layoutBands`/`layoutGroups` (Tasks 4–5), `LayoutDoc` (Task 5).
- Produces: `boardsForView(doc: LayoutDoc, openRoutes: string[], deviceIds: string[]): Artboard[]`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/design-devices.test.ts`

```ts
  it("boardsForView dispatches on the document's view", () => {
    const open = ["/", "/login"]
    const devices = ["laptop"]
    const rows = { view: "rows" as const, routeOrder: open, groups: [] }
    const bands = { view: "bands" as const, routeOrder: open, groups: [] }
    const groups = {
      view: "groups" as const,
      routeOrder: open,
      groups: [{ id: "g1", name: "Auth", routes: ["/login"] }],
    }

    expect(boardsForView(rows, open, devices)).toEqual(layoutRows(open, devices))
    expect(boardsForView(bands, open, devices)).toEqual(layoutBands(open, devices))
    expect(boardsForView(groups, open, devices)).toEqual(
      layoutGroups(open, devices, groups.groups),
    )
  })

  it("boardsForView treats an unknown view as rows rather than crashing", () => {
    // A document from a newer build must still render something.
    const open = ["/"]
    const weird = { view: "diagonal" as never, routeOrder: open, groups: [] }
    expect(boardsForView(weird, open, ["laptop"])).toEqual(layoutRows(open, ["laptop"]))
  })
```

Add `boardsForView`, `layoutBands` to that file's imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-devices`
Expected: FAIL — `boardsForView is not a function`.

- [ ] **Step 3: Implement** — append to `src/lib/design-devices.ts`, and widen the import to `import type { LayoutDoc, LayoutGroup } from "./design-layout"`.

```ts
/// The single entry point the surface calls: turn the arrangement document plus
/// the user's open pages and devices into positioned boards. Everything
/// downstream (canvas, selection, pins, focus) is keyed on `route@device` and
/// does not care which arrangement produced them.
export function boardsForView(
  doc: LayoutDoc,
  openRoutes: string[],
  deviceIds: string[],
): Artboard[] {
  switch (doc.view) {
    case "bands":
      return layoutBands(openRoutes, deviceIds)
    case "groups":
      return layoutGroups(openRoutes, deviceIds, doc.groups)
    // `rows` and anything unrecognised: a document written by a newer build
    // must still render *something* rather than blanking the canvas.
    case "rows":
    default:
      return layoutRows(openRoutes, deviceIds)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-devices`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts
git commit -m "feat(design): boardsForView selects the arrangement engine"
```

---

### Task 7: Frontend — layout document edits + tolerant normalise

**Files:**
- Modify: `v2_fe/src/lib/design-layout.ts`
- Create: `v2_fe/src/lib/design-layout.test.ts`

**Interfaces:**
- Produces: `CANVAS_VIEWS`, `MAX_GROUPS`, `MAX_GROUP_NAME`, `normalizeLayout(raw: unknown): LayoutDoc`, `createGroup(doc, name): { doc: LayoutDoc; id: string }`, `assignRoute(doc, route, groupId: string | null): LayoutDoc`, `removeGroup(doc, id): LayoutDoc`, `groupOf(doc, route): LayoutGroup | undefined`.

**No `renameGroup`.** Renaming is a real want but nothing in this plan consumes it, and an exported helper with one caller — its own test — is dead weight a reviewer is right to flag. It is listed under Deferred with the rest of the ordering work.

- [ ] **Step 1: Write the failing tests** — `src/lib/design-layout.test.ts`

```ts
import { describe, it, expect } from "vitest"
import {
  DEFAULT_LAYOUT,
  MAX_GROUPS,
  normalizeLayout,
  createGroup,
  assignRoute,
  removeGroup,
  groupOf,
} from "./design-layout"

describe("normalizeLayout", () => {
  it("passes a well-formed document through", () => {
    const doc = { view: "bands", routeOrder: ["/"], groups: [{ id: "g1", name: "Auth", routes: ["/login"] }] }
    expect(normalizeLayout(doc)).toEqual({ ...doc, view: "bands" })
  })

  it("falls back to rows for an unknown or missing view", () => {
    expect(normalizeLayout({ view: "diagonal", routeOrder: [], groups: [] }).view).toBe("rows")
    expect(normalizeLayout({}).view).toBe("rows")
  })

  it("drops malformed groups instead of crashing", () => {
    const doc = normalizeLayout({
      view: "groups",
      routeOrder: ["/"],
      groups: [
        { id: "g1", name: "Auth", routes: ["/login"] },
        { id: "g2", name: "No routes" },
        { name: "No id", routes: [] },
        "nonsense",
        null,
      ],
    })
    // g2 SURVIVES: a missing `routes` is not malformed. The server's field is
    // `#[serde(default)]`, so `{id, name}` IS the shape of an empty group — and
    // dropping it here would delete, on the next save, a group the server
    // stores and serves happily. Only a group missing an id or a name is
    // dropped, along with non-objects.
    expect(doc.groups.map((g) => g.id)).toEqual(["g1", "g2"])
    expect(doc.groups[1].routes).toEqual([])
  })

  it("returns the default document for non-objects", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout("nope")).toEqual(DEFAULT_LAYOUT)
  })

  it("coerces non-string route entries away", () => {
    const doc = normalizeLayout({
      view: "groups",
      routeOrder: ["/", 7, null],
      groups: [{ id: "g1", name: "Auth", routes: ["/login", 7] }],
    })
    expect(doc.routeOrder).toEqual(["/"])
    expect(doc.groups[0].routes).toEqual(["/login"])
  })
})

describe("layout edits", () => {
  it("createGroup appends a group with a fresh id", () => {
    const { doc, id } = createGroup(DEFAULT_LAYOUT, "Auth")
    expect(doc.groups).toHaveLength(1)
    expect(doc.groups[0].name).toBe("Auth")
    expect(doc.groups[0].id).toBe(id)
    const { doc: second } = createGroup(doc, "Ops")
    expect(second.groups[1].id).not.toBe(id)
  })

  it("createGroup refuses to exceed the cap or duplicate a name", () => {
    let doc = DEFAULT_LAYOUT
    for (let i = 0; i < MAX_GROUPS; i++) doc = createGroup(doc, `G${i}`).doc
    expect(createGroup(doc, "One more").doc).toBe(doc)
    // The duplicate check needs a document that ALREADY has the name:
    // `createGroup(DEFAULT_LAYOUT, "Auth")` *creates* the group, so nothing is
    // refused and no unchanged document can come back. Refusal is by identity —
    // the input document itself is returned, which is how the caller reads
    // "nothing happened".
    const withAuth = createGroup(DEFAULT_LAYOUT, "Auth").doc
    expect(createGroup(withAuth, "Auth").doc).toBe(withAuth)
    expect(createGroup(createGroup(DEFAULT_LAYOUT, "Auth").doc, "  auth  ").doc.groups).toHaveLength(1)
  })

  it("assignRoute moves a page into exactly one group", () => {
    const a = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const b = createGroup(a, "Ops").doc
    const [g1, g2] = b.groups.map((g) => g.id)

    const inAuth = assignRoute(b, "/login", g1)
    expect(groupOf(inAuth, "/login")!.id).toBe(g1)

    const moved = assignRoute(inAuth, "/login", g2)
    expect(groupOf(moved, "/login")!.id).toBe(g2)
    expect(moved.groups.find((g) => g.id === g1)!.routes).toEqual([])
  })

  it("assignRoute with null ungroups", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const inGroup = assignRoute(doc, "/login", doc.groups[0].id)
    expect(groupOf(assignRoute(inGroup, "/login", null), "/login")).toBeUndefined()
  })

  it("removeGroup drops the group and leaves its pages ungrouped", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const id = doc.groups[0].id
    const withRoute = assignRoute(doc, "/login", id)
    const removed = removeGroup(withRoute, id)
    expect(removed.groups).toEqual([])
    expect(groupOf(removed, "/login")).toBeUndefined()
  })

  it("edits never mutate the input document", () => {
    const doc = createGroup(DEFAULT_LAYOUT, "Auth").doc
    const before = JSON.stringify(doc)
    assignRoute(doc, "/login", doc.groups[0].id)
    removeGroup(doc, doc.groups[0].id)
    expect(JSON.stringify(doc)).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-layout`
Expected: FAIL — the module exports only types.

- [ ] **Step 3: Implement** — append to `src/lib/design-layout.ts`

```ts
export const MAX_GROUPS = 24
export const MAX_GROUP_NAME = 40

/** Toolbar order and labels for the arrangement picker. */
export const CANVAS_VIEWS: { id: CanvasView; label: string; hint: string }[] = [
  { id: "rows", label: "Rows", hint: "One row per page, a column per device" },
  { id: "bands", label: "Bands", hint: "One band per device, its pages across" },
  { id: "groups", label: "Groups", hint: "Named groups as columns, the rest flow right" },
]

const VIEW_IDS: CanvasView[] = ["rows", "bands", "groups"]

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/// Tolerant read-side parse of a server document.
///
/// The backend already validates and self-heals, so this is belt-and-braces for
/// the cases it cannot cover: a response from a newer build, a schema that moved
/// under a cached tab, or a proxy returning something unexpected. A canvas that
/// renders the default is recoverable; one that throws on load is not.
export function normalizeLayout(raw: unknown): LayoutDoc {
  if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT
  const obj = raw as Record<string, unknown>
  const view = VIEW_IDS.includes(obj.view as CanvasView) ? (obj.view as CanvasView) : "rows"
  const groups: LayoutGroup[] = Array.isArray(obj.groups)
    ? obj.groups.flatMap((g): LayoutGroup[] => {
        if (!g || typeof g !== "object") return []
        const candidate = g as Record<string, unknown>
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return []
        return [{ id: candidate.id, name: candidate.name, routes: asStrings(candidate.routes) }]
      })
    : []
  return { view, routeOrder: asStrings(obj.routeOrder), groups }
}

/** The group a route belongs to, if any. */
export function groupOf(doc: LayoutDoc, route: string): LayoutGroup | undefined {
  return doc.groups.find((g) => g.routes.includes(route))
}

/// Group ids are opaque to the server; a counter plus a nonce is enough (they
/// only need to be unique inside one document and stable across a save).
let groupSeq = 0
function nextGroupId(): string {
  groupSeq += 1
  return `g${Date.now().toString(36)}${groupSeq.toString(36)}`
}

/** A new empty group, or the document unchanged when the cap is hit or the name
 *  is already taken (matching the server's rule, so the UI cannot build a
 *  document the server will reject). */
export function createGroup(doc: LayoutDoc, name: string): { doc: LayoutDoc; id: string } {
  const trimmed = name.trim()
  const taken = doc.groups.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (!trimmed || trimmed.length > MAX_GROUP_NAME || taken || doc.groups.length >= MAX_GROUPS) {
    return { doc, id: "" }
  }
  const id = nextGroupId()
  return { doc: { ...doc, groups: [...doc.groups, { id, name: trimmed, routes: [] }] }, id }
}

/** Move a route into `groupId`, or out of every group when it is null. A route
 *  lives in at most one group, so this removes it from wherever it was. */
export function assignRoute(doc: LayoutDoc, route: string, groupId: string | null): LayoutDoc {
  return {
    ...doc,
    groups: doc.groups.map((g) => {
      const without = g.routes.filter((r) => r !== route)
      const withRoute = g.id === groupId ? [...without, route] : without
      return withRoute.length === g.routes.length && without.length === g.routes.length
        ? g
        : { ...g, routes: withRoute }
    }),
  }
}

/// Remove a group. Its pages are not deleted — they fall back to the ungrouped
/// tail, which is what "remove this grouping" should mean.
export function removeGroup(doc: LayoutDoc, id: string): LayoutDoc {
  return { ...doc, groups: doc.groups.filter((g) => g.id !== id) }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-layout`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-layout.ts v2_fe/src/lib/design-layout.test.ts
git commit -m "feat(design): layout document edits + tolerant client-side normalise"
```

---

### Task 8: Frontend — layout API client

**Files:**
- Modify: `v2_fe/src/lib/design-api.ts`

**Interfaces:**
- Consumes: the existing unexported `designFetch`/`jsonInit` in the same file, and `normalizeLayout`/`LayoutDoc` (Task 7).
- Produces: `fetchLayout(projectId: number): Promise<LayoutDoc>`, `saveLayout(projectId: number, doc: LayoutDoc): Promise<LayoutDoc>`.

- [ ] **Step 1: Implement** — append to `src/lib/design-api.ts`, and add `import { normalizeLayout, type LayoutDoc } from "@/lib/design-layout"` to its imports

```ts
/// The project's shared canvas arrangement. The server answers with the default
/// document for a project nobody has arranged, so this never 404s — but it is
/// still normalised, because a stale tab can outlive a schema change.
export async function fetchLayout(projectId: number): Promise<LayoutDoc> {
  const res = await designFetch(`/api/design/${projectId}/layout`)
  if (!res.ok) throw new Error(`Could not load the canvas layout (${res.status}).`)
  return normalizeLayout(await readJson(res))
}

/// Replace the project's arrangement. Last-write-wins on the server.
export async function saveLayout(projectId: number, doc: LayoutDoc): Promise<LayoutDoc> {
  const res = await designFetch(`/api/design/${projectId}/layout`, jsonInit("PUT", doc))
  if (!res.ok) throw new Error(`Could not save the canvas layout (${res.status}).`)
  return normalizeLayout(await readJson(res))
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd v2_fe && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/lib/design-api.ts
git commit -m "feat(design): fetch/save the shared canvas layout"
```

---

### Task 9: Frontend — Dexie per-user viewport store

**Files:**
- Create: `v2_fe/src/pages/design/design-ui-state.ts`
- Create: `v2_fe/src/pages/design/design-ui-state.test.ts`

**Interfaces:**
- Consumes: `MIN_SCALE`/`MAX_SCALE`/`CanvasTransform` from `./design-canvas`; `DEVICE_PRESETS` from `@/lib/design-devices`; `CanvasTool` from `./canvas-tools`; `DesignTab` from `./design-tabs`.
- Produces: `type DesignUIState`, `type DesignUIKey = [number, number]`, `parseUIState(raw: unknown, userId, projectId): DesignUIState | null`, `readUIState(userId, projectId): Promise<DesignUIState | null>`, `writeUIState(state: DesignUIState): Promise<void>`, `db` (the Dexie instance).

- [ ] **Step 1: Write the failing tests** — `src/pages/design/design-ui-state.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { DEFAULT_DEVICE_ID } from "@/lib/design-devices"
import { parseUIState } from "./design-ui-state"

const valid = {
  openRoutes: ["/", "/login"],
  deviceIds: ["laptop"],
  transform: { x: 10, y: 20, scale: 1 },
  canvasTool: "pan",
  rightTab: "tokens",
  theme: "dark",
}

describe("parseUIState", () => {
  it("accepts a well-formed record", () => {
    const state = parseUIState(valid, 4, 2)
    expect(state).toMatchObject({
      userId: 4,
      projectId: 2,
      openRoutes: ["/", "/login"],
      deviceIds: ["laptop"],
      canvasTool: "pan",
      rightTab: "tokens",
      theme: "dark",
    })
  })

  it("returns null only for a non-object, and defaults an empty record", () => {
    expect(parseUIState(null, 4, 2)).toBeNull()
    expect(parseUIState(undefined, 4, 2)).toBeNull()
    expect(parseUIState("nope", 4, 2)).toBeNull()
    // `{}` is a *valid object*, so it does not take the null return — every
    // field defaults instead. That is the right contract ("anything in, a
    // usable state out"), and it still converges for the caller: an empty
    // openRoutes makes `shouldSeedRoutes` return true, so the manifest seed
    // runs either way.
    const empty = parseUIState({}, 4, 2)!
    expect(empty.openRoutes).toEqual([])
    expect(empty.deviceIds).toEqual([DEFAULT_DEVICE_ID])
    expect(empty.canvasTool).toBe("select")
  })

  it("clamps a scale outside the legal range or non-finite", () => {
    // Review Focus #5: a hand-edited or foreign-build record must not be able
    // to render the canvas at scale 9 or NaN.
    const huge = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: 9 } }, 4, 2)!
    expect(huge.transform.scale).toBeLessThanOrEqual(2)
    expect(huge.transform.scale).toBeGreaterThan(0)

    const tiny = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: 0.001 } }, 4, 2)!
    expect(tiny.transform.scale).toBeGreaterThanOrEqual(0.25)

    const nan = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: Number.NaN } }, 4, 2)!
    expect(Number.isFinite(nan.transform.scale)).toBe(true)

    const junk = parseUIState({ ...valid, transform: { x: "a", y: null, scale: 1 } }, 4, 2)!
    expect(junk.transform.x).toBe(0)
    expect(junk.transform.y).toBe(0)
  })

  it("drops device ids the preset table no longer knows", () => {
    const state = parseUIState({ ...valid, deviceIds: ["laptop", "nokia-3310"] }, 4, 2)!
    expect(state.deviceIds).toEqual(["laptop"])
  })

  it("falls back for an unknown tool, tab or empty device list", () => {
    const state = parseUIState(
      { ...valid, canvasTool: "laser", rightTab: "nope", deviceIds: [] },
      4,
      2,
    )!
    expect(state.canvasTool).toBe("select")
    expect(state.rightTab).toBe("pages")
    expect(state.deviceIds.length).toBeGreaterThan(0)
  })

  it("drops non-string entries from openRoutes", () => {
    const state = parseUIState({ ...valid, openRoutes: ["/", 7, null] }, 4, 2)!
    expect(state.openRoutes).toEqual(["/"])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-ui-state`
Expected: FAIL — cannot resolve `./design-ui-state`.

- [ ] **Step 3: Implement** — `src/pages/design/design-ui-state.ts`

```ts
/// Per-user canvas viewport state, in Dexie (IndexedDB).
///
/// This is the "what am I looking at right now" half of the design state split:
/// open pages, selected devices, zoom/pan, tool, panel tab, preview theme. It is
/// per-user and per-browser on purpose — none of it is a fact about the project.
/// The SHARED half (which arrangement, how pages are grouped) lives on the
/// server as a `design_layout` row; see `design-layout.ts`.
///
/// Keyed `[userId, projectId]` rather than by project alone: IndexedDB is per
/// browser profile, so two accounts signing in on the same machine would
/// otherwise inherit each other's canvas.
///
/// Lives in `pages/design/` rather than `lib/` so it can take the zoom bounds
/// straight from `design-canvas`, the same way `canvas-view.ts` does.

import Dexie, { type EntityTable } from "dexie"

import { DEVICE_PRESETS, DEFAULT_DEVICE_ID } from "@/lib/design-devices"
import { MAX_SCALE, MIN_SCALE, type CanvasTransform } from "./design-canvas"
import { type CanvasTool } from "./canvas-tools"
import { type DesignTab } from "./design-tabs"

export type DesignUIState = {
  userId: number
  projectId: number
  openRoutes: string[]
  deviceIds: string[]
  transform: CanvasTransform
  canvasTool: CanvasTool
  rightTab: DesignTab
  theme: string
  updatedAt: number
}

const TOOLS: CanvasTool[] = ["select", "pan"]
const TABS: DesignTab[] = ["inspect", "components", "tokens", "pages"]
const DEVICE_IDS = new Set(DEVICE_PRESETS.map((d) => d.id))

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback

/// Tolerant parse. Returns null when the record is too damaged to trust, so the
/// caller seeds a fresh one instead of hydrating a half-state.
///
/// Every field is clamped or defaulted rather than rejected: a record written by
/// another build (or edited by hand in devtools) must degrade to something
/// renderable, because the alternative is a canvas stuck at an impossible zoom
/// with no UI to fix it.
export function parseUIState(raw: unknown, userId: number, projectId: number): DesignUIState | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>

  const openRoutes = asStrings(obj.openRoutes)
  const deviceIds = asStrings(obj.deviceIds).filter((id) => DEVICE_IDS.has(id))
  if (!deviceIds.length) deviceIds.push(DEFAULT_DEVICE_ID)

  const t = (obj.transform ?? {}) as Record<string, unknown>
  const transform: CanvasTransform = {
    x: num(t.x, 40),
    y: num(t.y, 40),
    // Clamped, not merely defaulted: a stale scale is the one field that can
    // make the canvas unreadable.
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, num(t.scale, 0.6))),
  }

  const canvasTool = TOOLS.includes(obj.canvasTool as CanvasTool)
    ? (obj.canvasTool as CanvasTool)
    : "select"
  const rightTab = TABS.includes(obj.rightTab as DesignTab) ? (obj.rightTab as DesignTab) : "pages"
  const theme = typeof obj.theme === "string" ? obj.theme : "light"

  return {
    userId,
    projectId,
    openRoutes,
    deviceIds,
    transform,
    canvasTool,
    rightTab,
    theme,
    updatedAt: num(obj.updatedAt, Date.now()),
  }
}

/// One table. The compound key is what makes "this user in this project" the
/// identity, so a second project starts clean.
const db = new Dexie("taskflow_design_ui") as Dexie & {
  canvas: EntityTable<DesignUIState, "userId" | "projectId">
}
db.version(1).stores({ canvas: "[userId+projectId]" })

export { db }

export async function readUIState(
  userId: number,
  projectId: number,
): Promise<DesignUIState | null> {
  try {
    const row = await db.canvas.get([userId, projectId])
    return row ? parseUIState(row, userId, projectId) : null
  } catch {
    // IndexedDB can be unavailable (private window, blocked site data). A
    // canvas that works but forgets is strictly better than one that throws.
    return null
  }
}

export async function writeUIState(state: DesignUIState): Promise<void> {
  try {
    await db.canvas.put({ ...state, updatedAt: Date.now() })
  } catch {
    // Losing a viewport is not worth surfacing.
  }
}
```

`EntityTable` requires Dexie ≥ 4 — installed in Task 4. If the local Dexie version's types disagree, fall back to `Table<DesignUIState, [number, number]>` from `dexie`; the runtime call is identical.

- [ ] **Step 4: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-ui-state`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-ui-state.ts \
        v2_fe/src/pages/design/design-ui-state.test.ts
git commit -m "feat(design): Dexie store for per-user canvas viewport state"
```

---

### Task 10: Frontend — view picker, hydration gate, shared layout wiring

**Files:**
- Create: `v2_fe/src/pages/design/design-view.ts`
- Create: `v2_fe/src/pages/design/design-view.test.ts`
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4–9.
- Produces: `shouldSeedRoutes(stored: DesignUIState | null, alreadySeeded: boolean): boolean` and a `ViewPicker` component in `DesignSurfacePage.tsx`.

- [ ] **Step 1: Write the failing test** — `src/pages/design/design-view.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { shouldSeedRoutes } from "./design-view"

describe("shouldSeedRoutes", () => {
  it("seeds from the manifest when nothing was stored", () => {
    expect(shouldSeedRoutes(null, false)).toBe(true)
  })

  it("does NOT seed when a stored viewport exists", () => {
    // The whole point of persistence: reopening the page must not re-open every
    // route the user deliberately closed.
    expect(shouldSeedRoutes({ openRoutes: ["/"] } as never, false)).toBe(false)
  })

  it("seeds a stored viewport that has no routes at all", () => {
    // A user who closed every page on purpose still gets the manifest default
    // rather than an empty canvas they cannot recover from.
    expect(shouldSeedRoutes({ openRoutes: [] } as never, false)).toBe(true)
  })

  it("never seeds twice for the same project", () => {
    expect(shouldSeedRoutes(null, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npm test -- design-view`
Expected: FAIL — cannot resolve `./design-view`.

- [ ] **Step 3: Implement** — `src/pages/design/design-view.ts`

```ts
/// The decision that persistence introduces: when a stored viewport exists, it
/// beats the manifest seed. Otherwise reopening the design page silently
/// re-opens every page the user closed.
///
/// A stored viewport with NO open routes is the exception — that reads as "the
/// record is empty", not as a deliberate choice, and seeding is the recoverable
/// behaviour (an empty canvas has no affordance to bring the pages back).

import type { DesignUIState } from "./design-ui-state"

export function shouldSeedRoutes(stored: DesignUIState | null, alreadySeeded: boolean): boolean {
  if (alreadySeeded) return false
  if (!stored) return true
  return stored.openRoutes.length === 0
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v2_fe && npm test -- design-view`
Expected: all green.

- [ ] **Step 5: Wire the surface** — in `DesignSurfacePage.tsx`

Replace the `artboards` memo (line 119) with:

```ts
  const artboards = useMemo(
    () => boardsForView(layout, openRoutes, deviceIds),
    [layout, openRoutes, deviceIds],
  )
```

Add state beside the existing canvas state (near line 114):

```ts
  /** The SHARED arrangement (view + groups). Server-owned; see `design-layout`. */
  const [layout, setLayout] = useState<LayoutDoc>(DEFAULT_LAYOUT)
  /** False until the per-user viewport has been read from Dexie. Writes are
   *  suppressed until then so a blank first render cannot overwrite it. */
  const hydratedRef = useRef(false)
```

Extend the manifest-load effect (line 147) to fetch the layout in the same `Promise.all`, and to consult the stored viewport before seeding:

```ts
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    Promise.all([fetchDesignManifest(projectId), fetchSandboxToken(projectId), fetchLayout(projectId)])
      .then(([m, token, doc]) => {
        if (cancelled) return
        setManifest(m)
        setSandboxToken(token)
        setLayout(doc)
        setError(null)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [projectId])
```

Add the hydration effect (this replaces the seeding that used to happen inside the manifest effect, because the seed decision now depends on Dexie):

```ts
  // --- hydrate the per-user viewport, then seed if nothing was stored -------
  // Runs at most ONCE per project. Without the guard the effect would re-run
  // whenever `manifest` changes identity and overwrite the user's live edits
  // with the (debounced, therefore stale) stored copy.
  const hydratedProjectRef = useRef<number | null>(null)
  useEffect(() => {
    if (!projectId || !currentUser || !manifest) return
    if (hydratedProjectRef.current === projectId) return
    hydratedProjectRef.current = projectId
    let cancelled = false
    ;(async () => {
      const stored = await readUIState(currentUser.id, projectId)
      if (cancelled) return

      if (stored) {
        setOpenRoutes(stored.openRoutes)
        setDeviceIds(stored.deviceIds)
        setTransform(stored.transform)
        setCanvasTool(stored.canvasTool)
        setRightTab(stored.rightTab)
        setTheme(stored.theme)
      }
      // "Already seeded" is per PROJECT, not a global flag — switching projects
      // must seed the new project's manifest rather than read the old one's.
      const alreadySeeded = seededProjectRef.current === projectId
      if (shouldSeedRoutes(stored, alreadySeeded)) {
        setOpenRoutes(manifest.routes.map((r) => r.path))
      }
      seededProjectRef.current = projectId
      hydratedRef.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, currentUser, manifest])
```

Add the persistence effect:

```ts
  // --- persist the viewport (debounced: panning fires on every pointermove) --
  useEffect(() => {
    if (!projectId || !currentUser || !hydratedRef.current) return
    const timer = window.setTimeout(() => {
      void writeUIState({
        userId: currentUser.id,
        projectId,
        openRoutes,
        deviceIds,
        transform,
        canvasTool,
        rightTab,
        theme,
        updatedAt: Date.now(),
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [projectId, currentUser, openRoutes, deviceIds, transform, canvasTool, rightTab, theme])
```

Add the layout save handler and pass it to the picker:

```ts
  // The server decides validity, so a rejected save is surfaced rather than
  // swallowed — otherwise the toolbar would show a view the project does not
  // actually have.
  const updateLayout = useCallback(
    (next: LayoutDoc) => {
      const previous = layout
      setLayout(next)
      if (!projectId) return
      saveLayout(projectId, next).catch((err: Error) => {
        setLayout(previous)
        setError(err.message)
      })
    },
    [layout, projectId],
  )
```

`responsiveReview` (line 243) still calls `layoutRows` directly, which would make "Responsive review" fit a rows-arrangement bounding box while the canvas is showing bands or groups. Point it at the active arrangement instead:

```ts
  const responsiveReview = useCallback(() => {
    if (!openRoutes.length) return
    const nextDeviceIds = [...RESPONSIVE_REVIEW_DEVICES]
    setDeviceIds(nextDeviceIds)
    const el = canvasContainerRef.current
    const viewport = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1200, h: 800 }
    setTransform(fitTransform(boardsForView(layout, openRoutes, nextDeviceIds), viewport))
  }, [openRoutes, layout])
```

That is the last `layoutRows` call site in the file, so remove `layoutRows` from the `@/lib/design-devices` import.

Render the picker in the toolbar, immediately after `<DevicePicker … />`:

```tsx
        <ViewPicker view={layout.view} onChange={(view) => updateLayout({ ...layout, view })} />
```

And add the component beside `DevicePicker`:

```tsx
function ViewPicker({ view, onChange }: { view: CanvasView; onChange: (v: CanvasView) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {CANVAS_VIEWS.map((v) => (
        <Button
          key={v.id}
          variant={view === v.id ? "default" : "ghost"}
          size="icon-sm"
          title={`${v.label} — ${v.hint}`}
          aria-label={v.label}
          aria-pressed={view === v.id}
          onClick={() => onChange(v.id)}
        >
          {v.id === "rows" ? (
            <RowsIcon className="size-3.5" />
          ) : v.id === "bands" ? (
            <ColumnsIcon className="size-3.5" />
          ) : (
            <LayoutGridIcon className="size-3.5" />
          )}
        </Button>
      ))}
    </div>
  )
}
```

New imports for that file: `ColumnsIcon`, `LayoutGridIcon`, `RowsIcon` (lucide-react); `fetchLayout`, `saveLayout` from `@/lib/design-api`; `boardsForView` from `@/lib/design-devices`; `CANVAS_VIEWS`, `DEFAULT_LAYOUT`, `type CanvasView`, `type LayoutDoc` from `@/lib/design-layout`; `readUIState`, `writeUIState` from `./design-ui-state`; `shouldSeedRoutes` from `./design-view`.

- [ ] **Step 6: Typecheck and run the suite**

Run: `cd v2_fe && npx tsc -b && npm test`
Expected: no type errors; all tests green.

- [ ] **Step 7: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-view.ts \
        v2_fe/src/pages/design/design-view.test.ts \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): view picker + viewport hydration and persistence"
```

---

### Task 11: Frontend — extract `PagesPanel`, add the group picker

**Files:**
- Create: `v2_fe/src/pages/design/pages-panel.tsx`
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx`
- Modify: `v2_fe/src/pages/design/design-layout.test.ts` (a helper used here is already covered; no new test file)

**Interfaces:**
- Consumes: `createGroup`/`assignRoute`/`renameGroup`/`removeGroup`/`groupOf` (Task 7).
- Produces: `PagesPanel({ manifest, openRoutes, onToggleRoute, groups, onLayoutChange })`.

- [ ] **Step 1: Create `pages-panel.tsx`** — move the existing `PagesPanel` out of `DesignSurfacePage.tsx` verbatim and add the group picker.

A native `<select>` is used deliberately instead of the app's Base UI `Select`: that component renders the raw value unless the root is given an `items` value→label map, which is an easy way to ship a picker that shows `g1` instead of `Auth`. A native select has no such failure mode and needs no extra client state.

```tsx
/// The Pages tab: every manifest route with an open/closed toggle, plus a group
/// picker per page for the `groups` arrangement.
///
/// Extracted from `DesignSurfacePage.tsx` (already ~1000 lines) when the group
/// picker landed; it is the one panel with per-row local interaction.

import type { DesignManifest } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import { assignRoute, createGroup, groupOf, type LayoutDoc } from "@/lib/design-layout"

const UNGROUPED = "__ungrouped__"

export function PagesPanel({
  manifest,
  openRoutes,
  onToggleRoute,
  layout,
  onLayoutChange,
}: {
  manifest: DesignManifest | null
  openRoutes: string[]
  onToggleRoute: (route: string) => void
  layout: LayoutDoc
  onLayoutChange: (next: LayoutDoc) => void
}) {
  const routes = manifest?.routes ?? []

  const assign = (route: string, value: string) => {
    onLayoutChange(assignRoute(layout, route, value === UNGROUPED ? null : value))
  }

  const addGroup = () => {
    const name = window.prompt("Group name")
    if (!name) return
    const { doc, id } = createGroup(layout, name)
    // `createGroup` returns the input unchanged when the name is taken or the
    // cap is hit, so an empty id means "nothing happened" — do not claim else.
    if (!id) return
    onLayoutChange(doc)
  }

  return (
    <div className="flex flex-col py-1">
      {routes.map((route) => {
        const open = openRoutes.includes(route.path)
        const current = groupOf(layout, route.path)
        return (
          <div key={route.path} className="flex items-center gap-1 px-2 py-1">
            <button
              className={cn(
                "flex min-w-0 flex-1 items-center justify-between rounded px-1 py-0.5 text-left text-sm hover:bg-muted",
                open && "bg-muted/60 font-medium",
              )}
              onClick={() => onToggleRoute(route.path)}
            >
              <span className="truncate">{route.title}</span>
              <span className="ml-2 shrink-0 font-mono text-[11px] text-muted-foreground">
                {route.path}
              </span>
            </button>
            {/* Kept native on purpose — see the file header. */}
            <select
              className="max-w-24 shrink-0 rounded border bg-transparent px-1 py-0.5 text-[11px]"
              aria-label={`Group for ${route.path}`}
              value={current?.id ?? UNGROUPED}
              onChange={(e) => assign(route.path, e.target.value)}
            >
              <option value={UNGROUPED}>—</option>
              {layout.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        )
      })}
      {layout.groups.length ? (
        <button
          className="mt-1 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={addGroup}
        >
          + New group
        </button>
      ) : null}
      {!routes.length ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Point the surface at the new module** — in `DesignSurfacePage.tsx`, delete the old `PagesPanel` definition (around line 855) and the now-unused `cn` import if nothing else uses it, then add `import { PagesPanel } from "./pages-panel"`, and update the call site (line 545):

```tsx
              <PagesPanel
                manifest={manifest}
                openRoutes={openRoutes}
                onToggleRoute={toggleRouteFromPanel}
                layout={layout}
                onLayoutChange={updateLayout}
              />
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `cd v2_fe && npx tsc -b && npm test`
Expected: no type errors; all tests green.

- [ ] **Step 4: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/pages-panel.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): per-page group picker in an extracted Pages panel"
```

---

### Task 12: Frontend — header containment + dark-mode frame backdrop

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`

**Interfaces:**
- Consumes: `boardWidth` (Task 4) via the `ArtboardCard` render path.
- Produces: no new exports; `ArtboardHeader` gains a `width` prop.

- [ ] **Step 1: Clamp the header to its board and collapse the dead buttons**

In `ArtboardCard` (line ~298), pass the board's real width down:

```tsx
      <ArtboardHeader
        route={board.route}
        device={device}
        projectId={projectId}
        width={boardWidth(device)}
      />
```

Replace `ArtboardHeader`'s signature and its row of buttons (lines ~325–393). The five buttons moved into the menu (`rotate`, `duplicate`, `open in new tab`, `reload`, `remove`) have **no handlers today** — they are placeholders. Keep them as menu items with their existing titles so the intent is preserved, but nothing about behaviour changes:

```tsx
function ArtboardHeader({
  route,
  device,
  projectId,
  width,
}: {
  route: string
  device: DevicePreset
  projectId: number | null
  /** The board's rendered width. The header is clamped to it so a narrow
   *  device's label and actions can never spill into the neighbouring board —
   *  which is what the old unconstrained flex row did. */
  width: number
}) {
```

```tsx
  return (
    <div
      className="mb-2 flex items-center gap-1.5 overflow-hidden text-xs text-zinc-400"
      style={{ width }}
    >
      <span className="truncate font-medium text-zinc-200">
        {route === "/" ? "Dashboard" : route.slice(1)}
      </span>
      <span className="shrink-0 text-zinc-500">·</span>
      <span className="shrink-0">{device.label}</span>
      <button
        className="ml-auto shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
        title="Copy HTML"
        disabled={projectId == null}
        onClick={copyHtml}
      >
        <ClipboardCopyIcon className="size-3.5" />
      </button>
      <button
        className="shrink-0 rounded p-1 hover:bg-zinc-800 disabled:opacity-40"
        title="Download"
        disabled={projectId == null}
        onClick={downloadHtml}
      >
        <DownloadIcon className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="shrink-0 rounded p-1 hover:bg-zinc-800" title="More actions" />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem>
            <RotateCwIcon className="size-3.5" />
            Rotate
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CopyIcon className="size-3.5" />
            Duplicate at another device
          </DropdownMenuItem>
          <DropdownMenuItem>
            <ExternalLinkIcon className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem>
            <RefreshCwIcon className="size-3.5" />
            Reload
          </DropdownMenuItem>
          <DropdownMenuItem>
            <XIcon className="size-3.5" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
```

Add `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` to that file's imports from `@/components/ui/dropdown-menu`, and `boardWidth` to the `@/lib/design-devices` import. The dims span and the standalone `EllipsisIcon` are gone — the width is already implied by the device label and the readout is in the device picker.

- [ ] **Step 2: Darken the three light surfaces behind the frames**

These are only ever visible *around* or *behind* the iframe, which paints its own token background once loaded — so on the dark canvas a light backdrop is both wrong-looking and, at fractional zoom, shows as a bright fringe.

Line ~446, the screen cut-out:

```tsx
      <div className="overflow-hidden bg-zinc-950" style={{ borderRadius: chrome.innerRadius }}>
```

Line ~518, the frame host:

```tsx
    <div ref={hostRef} style={{ width, height }} className="relative bg-zinc-900">
```

Line ~567, the lazy placeholder:

```tsx
      className="flex h-full w-full items-center justify-center bg-gradient-to-b from-zinc-900 to-zinc-800"
```

and its icon:

```tsx
      <MaximizeIcon className="size-5 text-zinc-700" />
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `cd v2_fe && npx tsc -b && npm test`
Expected: no type errors; all tests green.

- [ ] **Step 4: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add v2_fe/src/pages/design/design-canvas.tsx
git commit -m "fix(design): clamp artboard headers to their board; dark frame backdrop"
```

---

### Task 13: Realtime for the shared layout (optional — cut freely)

Cutting this task leaves the layout refreshing on page load only. It is the one item in the spec flagged cuttable, because it extends the cross-language suffix contract that has **no drift guard** — a missed frontend suffix compiles fine and fails silently.

**Files:**
- Modify: `backend/src/realtime.rs:34` (import), `:67-68` (const), `:289-291` (expose), `ALL_SUFFIXES` (~line 404)
- Modify: `backend/plugins/taskflow-design/src/views.rs:542-543` (the SSE group set)
- Modify: `v2_fe/src/lib/taskflow-api.ts:84-85` (the suffix map + `taskflowTables`)
- Modify: `v2_fe/src/App.tsx:881` (the dispatch condition)
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (the realtime effect at ~line 135)

- [ ] **Step 1: Backend — declare the suffix, expose the model, add the SSE group**

```rust
// realtime.rs, beside DESIGN_COMMENTS (line 68)
const DESIGN_LAYOUT: &str = "design_layout";
```

```rust
// realtime.rs, beside the DesignComment expose (line 291)
        .expose::<DesignLayout>(Expose::to_group_with(|ev| group_for(DESIGN_LAYOUT, &ev.instance)))
```

```rust
// realtime.rs line 34
use taskflow_design::models::{DesignComment, DesignFile, DesignLayout};
```

Add `DESIGN_LAYOUT,` to `ALL_SUFFIXES` (the list ending at line 405). Without it, `is_public_group` rejects the group and the events never reach the client.

```rust
// views.rs, in design_events (line 543)
    groups.insert(format!("project:{project_id}:design_layout"));
```

- [ ] **Step 2: Frontend — mirror the suffix and the dispatch**

```ts
// taskflow-api.ts, beside designComments (line 85)
  [taskflowTables.designLayout]: "design_layout",
```

Add `designLayout: "design_layout"` to the `taskflowTables` object in the same file, narrowing `TaskflowRealtimeTable` accordingly.

```ts
// App.tsx line 881
        if (
          event.table === taskflowTables.designFiles ||
          event.table === taskflowTables.designComments ||
          event.table === taskflowTables.designLayout
        ) {
          emitDesignRealtimeEvent(event)
        }
```

- [ ] **Step 3: Refetch the layout on an event** — in `DesignSurfacePage.tsx`, extend the existing design-realtime effect (line ~135):

```ts
      } else if (event.table === taskflowTables.designLayout) {
        // Another viewer changed the shared arrangement; adopt it. The viewport
        // half of the state is per-user and deliberately untouched.
        void fetchLayout(projectId).then(setLayout).catch(() => null)
      }
```

- [ ] **Step 4: Verify the contract holds across the language boundary**

Run:
```bash
cd /home/dalmas/E/projects/local_task_tracker
grep -n "design_layout" backend/src/realtime.rs v2_fe/src/lib/taskflow-api.ts | sed 's/^/  /'
```
Expected: `design_layout` present in **both** files. If it is in only one, the connection silently drops — that is the failure mode this step exists to catch.

- [ ] **Step 5: Run both suites**

Run: `cd backend && cargo test --workspace` then `cd ../v2_fe && npx tsc -b && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/local_task_tracker
git add backend/src/realtime.rs \
        backend/plugins/taskflow-design/src/views.rs \
        v2_fe/src/lib/taskflow-api.ts v2_fe/src/App.tsx \
        v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): broadcast layout changes so a regrouping reaches other viewers"
```

---

### Task 14: Verification — run the stack, look at it, publish

**Files:**
- No source changes expected. Any fix this task finds gets its own commit.

**Interfaces:**
- Consumes: every task above.

- [ ] **Step 1: Point a local backend at a COPY of the dev database**

Never run against the live `backend/backend.db`.

```bash
cd /home/dalmas/E/projects/local_task_tracker/backend
cp backend.db /tmp/taskflow-phase4.db
```

`umbral.toml` sets `database_url = "sqlite://backend.db?mode=rwc"`, and any `UMBRAL_*` env var overrides the file. So run against the copy with:

```bash
UMBRAL_DATABASE_URL="sqlite:///tmp/taskflow-phase4.db?mode=rwc" cargo run -- migrate
UMBRAL_DATABASE_URL="sqlite:///tmp/taskflow-phase4.db?mode=rwc" cargo run -- serve
```

Confirm the migration applied to the copy:

```bash
cargo run -- showmigrations 2>&1 | grep -A2 taskflow_design
```

Expected: `0001_auto` and `0002_create_design_layout` both applied.

- [ ] **Step 2: Start both halves and open the design page**

Run the backend, then `cd v2_fe && npm run dev`, and open `/dashboard/design` against a project that has design pages.

- [ ] **Step 3: Verify each arrangement visually**

- `Rows` — one row per page, a column per device; unchanged from before apart from the wider gutter.
- `Bands` — one band per device, that device's pages running across, the next device below it.
- `Groups` — assign two pages to a group in the Pages panel and confirm they stack in a column, with the rest flowing to the right of it on the same top row.

A board's **title and action buttons must not reach the next board** at the narrowest preset (`galaxy-s24`). That was the reported defect.

- [ ] **Step 4: Verify the dark-mode backdrop**

Toggle the preview theme to dark and inspect at 100% and at an odd zoom (e.g. 73%, reachable with the toolbar zooms). **No white or light-grey fringe around or behind a device frame.** This is the one claim in the spec that unit tests cannot make.

- [ ] **Step 5: Verify persistence and the shared/server split**

- Close a page, reload → it stays closed (Dexie won).
- Zoom and pan, reload → the viewport is restored.
- Switch to `Groups` and group two pages, reload → the arrangement survives, because it came from the server.
- Confirm the split holds: the layout is in the `design_layout` table, and **nothing about the arrangement is in IndexedDB**. In devtools → Application → IndexedDB → `taskflow_design_ui` → `canvas`, the record must contain `openRoutes`, `deviceIds`, `transform`, `canvasTool`, `rightTab`, `theme` — and **no** `view` or `groups`.

- [ ] **Step 6: Check a second user sees the same arrangement** (only if Task 13 was kept)

Sign in as a different project member, open the design page, and confirm the same grouping. With Task 13 cut, this requires a reload — note which behaviour was shipped.

- [ ] **Step 7: Build — the build IS the deploy**

Run: `cd v2_fe && npm run build`

Expected: success. Then confirm the new code is actually in the bundle rather than assuming it:

```bash
grep -c "taskflow_design_ui" v2_fe/dist/assets/*.js
```

Expected: a non-zero count. A stale bundle is indistinguishable from code that silently reverted itself, and this is the only check that separates "the code is right" from "the app has it".

- [ ] **Step 8: Commit anything the verification changed** (stage explicit paths)

```bash
cd /home/dalmas/E/projects/local_task_tracker
git status --short
```

If the run surfaced a fix, commit it alone with a message naming the defect. If it surfaced nothing, there is nothing to commit — do not create an empty one.

---

## Deferred (recorded, not in scope)

- **The reported zoom pixelation.** The spec carries three hypotheses built as minimal cross-origin repros and **all rejected** (will-change, rounded-clip/mask, frame size — each rendered crisp at 2×). No root cause exists yet, so no task here touches it. It needs a screenshot from the user plus: which device preset, the zoom readout, and whether it settles crisp (→ `LazyFrame` remounting at `design-canvas.tsx:484`) or stays pixelated (→ rasterization). **Do not re-derive the rejected hypotheses.**
- **Balanced packing of the ungrouped tail** in the `groups` view — deliberately a single non-wrapping row for now (spec §C). This is the intended next collaboration point: the policy choice should be made against real page counts.
- **Renaming a group.** `createGroup` exists and is wired; a rename helper was cut before execution rather than shipped as an export whose only caller is its own test. Add it with the reorder work below, when the Pages panel grows a group-management surface to put it in.
- **Drag-to-reorder groups and pages.** Ordering currently follows `routeOrder` / group creation.
