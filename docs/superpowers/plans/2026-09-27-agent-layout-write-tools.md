# Agent Layout-Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent arrange the Design Surface's board — create and rename page groups, reorder groups, and place pages into groups at a position — where today it can only read the arrangement.

**Architecture:** Four operations, one new agent-authed `PUT` route, and pure functions in `layout_doc.rs` that transform an in-memory document. A new `version` column on `design_layout` powers optional optimistic concurrency: `base_version` omitted means the backend computes it from the current row and the write proceeds; supplied and stale means a 409 carrying the current document. The write path runs inside the existing per-project lock and begins from the *served* view of the document, because `validate` rejects unknown routes while `load_layout` filters them.

**Tech Stack:** Rust (axum, umbral ORM, sqlx/Postgres, tokio), TypeScript (`@modelcontextprotocol/sdk`), vitest for the frontend, `#[tokio::test(flavor = "multi_thread")]` integration tests against a real DB.

**Spec:** `docs/superpowers/specs/2026-09-27-agent-layout-write-tools-design.md`

## Global Constraints

- **Maxima, copied verbatim from `layout_doc.rs`:** `MAX_GROUPS: usize = 24`, `MAX_GROUP_NAME: usize = 40`, `MAX_LABEL: usize = 40`, `MAX_GROUP_ID: usize = 64` (private).
- **Positions are 1-based everywhere.** A position below 1 or above `len` is refused with a message naming the valid range. Never clamp.
- **Name and id uniqueness are per-project.** Never global. The `design_layout` row is per project (`unique_together: [["project"]]`); two projects may each have a "Player" group.
- **`base_version` is `Option<i64>` on the wire.** Omitted is the normal case and must never produce a 409.
- **The write must never accept a document as input.** Operations only. The read response is lossy and must not be round-tripped into storage.
- **`views.rs` `put_layout` must bump `version`,** without checking one. The operator's save always wins.
- **Every integration test is `#[tokio::test(flavor = "multi_thread")]`** — required by the blocking membership check.
- **Rust formatting:** run `cargo fmt` before each commit; the repo is formatted.

## Review Focus

These are the failure modes a person using this software will hit that no task's
own tests would otherwise catch. Each gets a test in the owning task.

1. **A page deleted since the last arrangement save.** A group still names it; `validate` would reject the whole write with a message about a page that does not exist, permanently wedging every future edit. Owned by Task 5.
2. **An existing layout row whose JSON will not parse.** `load_layout` degrades to `default_doc()` for reads; a write that did the same would persist `default + op` and silently discard the real arrangement. Owned by Task 5.
3. **Two groups claiming the same route.** `panel_sections` shows it under the first only, so the document can claim it twice while the panel shows it once. Owned by Task 4.
4. **A `position` that means something other than expected.** It is 1-based and
   section-relative — a numbering the caller has to derive from the panel's
   view, while storage keeps one global flow. An agent that reads a position off
   the flow instead of off a section lands one page off, silently and validly.
   Owned by Task 4.
5. **A concurrent operator save landing between an agent's read and its write.** Owned by Task 6.

---

### Task 1: `version` on `design_layout`

**Files:**
- Create: `backend/migrations/taskflow_design/0003_add_design_layout_version.json`
- Modify: `backend/plugins/taskflow-design/src/models.rs:183-202`
- Modify: `backend/plugins/taskflow-design/src/views.rs:232-305` (`put_layout`)
- Test: `backend/plugins/taskflow-design/tests/layout_version.rs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `DesignLayout.version: i64`, defaulting to 1. Later tasks read and write it.

- [ ] **Step 1: Write the failing test**

Create `backend/plugins/taskflow-design/tests/layout_version.rs`:

```rust
//! The layout row carries a version, and the operator's save maintains it.
//!
//! This is the token an agent's `base_version` is checked against (spec §4 D1).
//! The operator never *sends* one — a human saving from the panel always wins —
//! but their save must still move the number, or an agent holding a stale
//! version would never be told.

mod support;

use support::TestApp;

fn layout_body() -> serde_json::Value {
    serde_json::json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [],
        "pageLabels": {}
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn an_operators_first_save_creates_the_row_at_version_one() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.version, 1, "a first save lands at version 1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_save_bumps_the_version() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    app.put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.version, 2, "the operator's save moves the number");
}
```

Add to `tests/support/mod.rs`, beside `seed_agent` (and add
`use taskflow_design::models::{DesignLayout, design_layout};` inside the
function, the way `seed_agent` imports its own models locally):

```rust
/// The project's layout row as stored. Panics if there is none — every caller
/// here has already saved one.
pub async fn latest_layout_row(&self, project: i64) -> taskflow_design::models::DesignLayout {
    use taskflow_design::models::{DesignLayout, design_layout};
    DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project))
        .first()
        .await
        .expect("layout query")
        .expect("a layout row")
}
```

Note: the harness calls are **methods** — `app.create_member_with_project()`,
`res.status()`, `res.text()` — and `seed_agent` is a free function taking
`(project, display_name)`. Match those; do not invent a `&app` argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && cargo test -p taskflow-design --test layout_version`
Expected: compile failure — `no field 'version'`, and `latest_layout_row` not found.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/taskflow_design/0003_add_design_layout_version.json`, modelled on `backend/migrations/taskflow_agents/0008_add_taskflow_agent_prompt_answer_json.json` (the AddColumn shape) and on `0001_auto.json`'s `design_file.version` column:

```json
{
  "id": "0003_add_design_layout_version",
  "plugin": "taskflow_design",
  "depends_on": [],
  "operations": [
    {
      "kind": "AddColumn",
      "table": "design_layout",
      "column": {
        "name": "version",
        "ty": "BigInt",
        "primary_key": false,
        "nullable": false,
        "noform": false,
        "noedit": false,
        "is_string_repr": false,
        "max_length": 0,
        "default": "1"
      }
    }
  ],
  "snapshot_after": {
    "models": []
  }
}
```

⚠️ **The `default` is load-bearing, not cosmetic.** Existing rows must satisfy
`nullable: false`, and the engine lifts an `AddColumn` default into the rendered
`ALTER TABLE` for exactly this reason (`migrate.rs:1111`). Then copy the three
model entries — `DesignComment`, `DesignFile`, `DesignLayout` — from
`0002_create_design_layout.json`'s `snapshot_after.models` into this file's
`snapshot_after.models`, and add to the copied `DesignLayout`'s `fields` the same
column object used in `operations[0].column`. Leave the other two models
untouched.

- [ ] **Step 4: Add the model field**

In `models.rs`, in `DesignLayout`, after `layout_json`:

```rust
    /// Bumped by every write to this row. An agent may hand a read version back
    /// as `base_version` to be told when someone else moved the arrangement
    /// under it; the operator sends none and always wins. See `spec §4 D1`.
    #[umbral(default = "1")]
    pub version: i64,
```

- [ ] **Step 5: Bump the version in `put_layout`**

In `views.rs`, the update branch of `put_layout` currently sets
`view`, `layout_json`, `updated_by`, `updated_at`. Add the version bump to that
`json!({...})`:

```rust
                            json!({
                                "view": doc.view,
                                "layout_json": json,
                                "updated_by": by,
                                "updated_at": chrono::Utc::now(),
                                // No predicate on this write: the operator is
                                // looking at the board and their save wins. The
                                // number still moves so an agent holding an
                                // older one is told rather than clobbering.
                                "version": row.version + 1,
                            })
```

In the create branch (`:282-296`), the inserted values gain `"version": 1`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test layout_version`
Expected: PASS, both tests.

- [ ] **Step 7: Run the whole design suite for regressions**

Run: `cd backend && cargo test -p taskflow-design`
Expected: PASS. A failure in `phase7_layout_endpoint` or `realtime_bulk_bridge` means the extra column changed a serialised row shape — fix before proceeding.

- [ ] **Step 8: Commit**

```bash
cd backend && cargo fmt
git add backend/migrations/taskflow_design/0003_add_design_layout_version.json \
        backend/plugins/taskflow-design/src/models.rs \
        backend/plugins/taskflow-design/src/views.rs \
        backend/plugins/taskflow-design/tests/layout_version.rs \
        backend/plugins/taskflow-design/tests/support/mod.rs
git commit -m "feat(design): a version on the layout row, moved by the operator's save"
```

---

### Task 2: Minting ids, `create_group`, `rename_group`

**Files:**
- Modify: `backend/plugins/taskflow-design/src/layout_doc.rs`
- Test: `backend/plugins/taskflow-design/tests/layout_doc.rs` (append)

**Interfaces:**
- Consumes: `DesignLayout.version` (Task 1) — not directly, these are pure.
- Produces:
  - `pub fn mint_group_id(existing: &[String]) -> String`
  - `pub fn create_group(doc: LayoutDoc, name: &str) -> (LayoutDoc, String)`
  - `pub fn rename_group(doc: LayoutDoc, group_id: &str, name: &str) -> Result<LayoutDoc, String>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/layout_doc.rs`:

```rust
#[test]
fn a_minted_id_is_a_g_and_does_not_collide() {
    let existing = vec!["gabc".to_string(), "gdef".to_string()];
    let id = mint_group_id(&existing);
    assert!(id.starts_with('g'), "same family as the panel's: {id}");
    assert_eq!(id.len(), 13, "g + 12 base36 chars: {id}");
    assert!(
        id[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='z').contains(&c)),
        "lowercase base36 only: {id}"
    );
    assert!(!existing.contains(&id), "and not already taken");
}

#[test]
fn minted_ids_differ_across_calls() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..64 {
        assert!(seen.insert(mint_group_id(&[])), "two draws collided");
    }
}

#[test]
fn create_group_appends_an_empty_group_and_returns_its_id() {
    let (doc, id) = create_group(doc(vec![]), "  Player  ");
    assert_eq!(doc.groups.len(), 1);
    assert_eq!(doc.groups[0].id, id);
    assert_eq!(doc.groups[0].name, "Player", "the name is trimmed");
    assert!(doc.groups[0].routes.is_empty(), "a new group holds nothing");
}

#[test]
fn create_group_refuses_through_validate_not_here() {
    // The rules live in `validate` and nowhere else, so this function does not
    // duplicate them — the caller validates the result. A duplicate name is
    // therefore still produced here and refused there.
    let (doc, _) = create_group(doc(vec![group("g1", "Player", &[])]), "player");
    assert_eq!(doc.groups.len(), 2);
    assert!(validate(doc, &known(vec!["/a"])).is_err(), "refused by validate, case-insensitively");
}

#[test]
fn rename_group_changes_only_the_name() {
    let before = doc(vec![group("g1", "Old", &["/a"])]);
    let after = rename_group(before.clone(), "g1", "New").expect("renames");
    assert_eq!(after.groups[0].name, "New");
    assert_eq!(after.groups[0].routes, vec!["/a".to_string()], "membership untouched");
    assert_eq!(after.route_order, before.route_order);
}

#[test]
fn rename_group_refuses_an_unknown_id() {
    let err = rename_group(doc(vec![group("g1", "A", &[])]), "nope", "B").unwrap_err();
    assert!(err.contains("nope"), "the message names the id: {err}");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: compile failure — `mint_group_id`, `create_group`, `rename_group` not found.

- [ ] **Step 3: Implement**

Add to `layout_doc.rs`, after the constants:

```rust
/// The id alphabet for minted group ids: lowercase base36, so an id is a single
/// URL-safe token with nothing to escape.
const ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
/// 36^12 is a shade under 2^63, so one `u64` of entropy fills an id exactly.
const GROUP_ID_DIGITS: usize = 12;

/// Mint a group id not already present in `existing`.
///
/// The panel mints its own as `g{time36}{seq36}` (`design-layout.ts:91`) from a
/// clock and a module-level counter, neither of which a server has. Uniqueness
/// is per-project only (spec §4 D3), so a random draw checked against this
/// document's ids is enough, and the `g` prefix keeps a minted id in the same
/// family as one the panel made.
pub fn mint_group_id(existing: &[String]) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    loop {
        // `RandomState` is seeded per process from the OS, so this is not a
        // predictable counter — and it needs no dependency the plugin lacks.
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_usize(existing.len());
        let mut n = hasher.finish();

        let mut id = String::with_capacity(1 + GROUP_ID_DIGITS);
        id.push('g');
        for _ in 0..GROUP_ID_DIGITS {
            id.push(ID_ALPHABET[(n % 36) as usize] as char);
            n /= 36;
        }

        if !existing.iter().any(|e| e == &id) {
            return id;
        }
    }
}

/// Append a new empty group. Returns the document and the minted id.
///
/// The name rules — non-blank, length, uniqueness, the group cap — live in
/// `validate` and are deliberately NOT duplicated here, so create and rename
/// refuse a bad name through exactly the code that refuses it on the operator
/// route. A caller must validate the result before storing it.
pub fn create_group(doc: LayoutDoc, name: &str) -> (LayoutDoc, String) {
    let existing: Vec<String> = doc.groups.iter().map(|g| g.id.clone()).collect();
    let id = mint_group_id(&existing);
    let mut groups = doc.groups;
    groups.push(LayoutGroup {
        id: id.clone(),
        name: name.trim().to_string(),
        routes: Vec::new(),
    });
    (LayoutDoc { groups, ..doc }, id)
}

/// Rename one group. Membership and order are untouched — moving pages is
/// `place_page`'s job, so a rename can never empty a group by accident.
pub fn rename_group(doc: LayoutDoc, group_id: &str, name: &str) -> Result<LayoutDoc, String> {
    let mut groups = doc.groups;
    let group = groups
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| format!("no group with id \"{group_id}\""))?;
    group.name = name.trim().to_string();
    Ok(LayoutDoc { groups, ..doc })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/layout_doc.rs \
        backend/plugins/taskflow-design/tests/layout_doc.rs
git commit -m "feat(design): mint group ids, create and rename groups"
```

---

### Task 3: `move_group`

**Files:**
- Modify: `backend/plugins/taskflow-design/src/layout_doc.rs`
- Test: `backend/plugins/taskflow-design/tests/layout_doc.rs` (append)

**Interfaces:**
- Consumes: nothing from Task 2.
- Produces: `pub fn move_group(doc: LayoutDoc, group_id: &str, position: usize) -> Result<LayoutDoc, String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn move_group_moves_rather_than_swaps() {
    // The panel's `moveGroup` is a move: the group at the target index is
    // displaced, not exchanged. Agent and operator must agree.
    let before = doc(vec![group("g1", "A", &[]), group("g2", "B", &[]), group("g3", "C", &[])]);
    let after = move_group(before, "g1", 2).expect("moves");
    let order: Vec<&str> = after.groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(order, vec!["B", "A", "C"], "A moves to slot 2; B slides up");
}

#[test]
fn move_group_to_the_same_place_is_a_no_op() {
    let before = doc(vec![group("g1", "A", &[]), group("g2", "B", &[])]);
    let after = move_group(before.clone(), "g1", 1).expect("moves");
    assert_eq!(after.groups, before.groups);
}

#[test]
fn move_group_refuses_a_position_outside_the_list() {
    let before = doc(vec![group("g1", "A", &[]), group("g2", "B", &[])]);
    let err = move_group(before.clone(), "g1", 3).unwrap_err();
    assert!(err.contains("1..=2"), "names the valid range: {err}");
    assert!(move_group(before.clone(), "g1", 0).unwrap_err().contains("1..=2"));
    // Refused, not clamped: a clamped move would land somewhere unasked.
    assert_eq!(before.groups.len(), 2);
}

#[test]
fn move_group_refuses_an_unknown_id() {
    let err = move_group(doc(vec![group("g1", "A", &[])]), "nope", 1).unwrap_err();
    assert!(err.contains("nope"), "names the id: {err}");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: compile failure — `move_group` not found.

- [ ] **Step 3: Implement**

```rust
/// Move one group to a 1-based slot in the group list.
///
/// A MOVE, not a swap: removing then inserting displaces the groups between,
/// which is what the panel's `moveGroup` does (`design-layout.ts:209`) and what
/// "put this group third" means to a person.
pub fn move_group(doc: LayoutDoc, group_id: &str, position: usize) -> Result<LayoutDoc, String> {
    let mut groups = doc.groups;
    let from = groups
        .iter()
        .position(|g| g.id == group_id)
        .ok_or_else(|| format!("no group with id \"{group_id}\""))?;
    let len = groups.len();
    if position < 1 || position > len {
        return Err(format!(
            "position {position} is out of range: there are {len} group(s), so 1..={len} is valid"
        ));
    }
    let group = groups.remove(from);
    groups.insert(position - 1, group);
    Ok(LayoutDoc { groups, ..doc })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/layout_doc.rs \
        backend/plugins/taskflow-design/tests/layout_doc.rs
git commit -m "feat(design): move a group within the list"
```

---

### Task 4: `place_page`

**Files:**
- Modify: `backend/plugins/taskflow-design/src/layout_doc.rs`
- Test: `backend/plugins/taskflow-design/tests/layout_doc.rs` (append)

**Interfaces:**
- Consumes: `resolve_route_order(doc, known_routes) -> Vec<String>` (`layout_doc.rs:169`).
- Produces: `pub fn place_page(doc: LayoutDoc, known_routes: &[String], route: &str, group_id: Option<&str>, position: Option<usize>) -> Result<LayoutDoc, String>`

**This is the task that carries Review Focus 3 and 4.** Position is 1-based
within the route's *resulting section*, and because the flow is global, placing
a page can shift the visible numbering of other sections — the tests below pin
that rather than pretend otherwise.

- [ ] **Step 1: Write the failing tests**

```rust
/// A flow over /a /b /c /d where g1 claims /a and /b, so the ungrouped section
/// is /c /d. Mirrors the fixture style used by the other cases in this file.
fn placed_doc() -> LayoutDoc {
    doc_with_flow(
        vec!["/a", "/b", "/c", "/d"],
        vec![group("g1", "One", &["/a", "/b"])],
    )
}

#[test]
fn place_page_moves_a_page_into_a_group() {
    let before = placed_doc();
    let after = place_page(before, &known(vec!["/a", "/b", "/c", "/d"]), "/c", Some("g1"), None)
        .expect("places");
    assert_eq!(after.groups[0].routes.len(), 3, "g1 now claims three pages");
    assert!(after.groups[0].routes.contains(&"/c".to_string()));
    let (groups, ungrouped) = panel_sections(&after, &known(vec!["/a", "/b", "/c", "/d"]));
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/a", "/b", "/c"], "appended: no position asked for");
    assert_eq!(ungrouped, vec!["/d".to_string()]);
}

#[test]
fn place_page_removes_the_route_from_whatever_claimed_it() {
    // Review Focus 3: the panel shows a doubly-claimed route under the FIRST
    // group only, so a document claiming it twice displays it once — a
    // discrepancy nothing else would catch.
    let before = placed_doc();
    let after = place_page(before, &known(vec!["/a", "/b", "/c", "/d"]), "/a", Some("g2"), None)
        .expect("places");
    let claims: Vec<&str> = after
        .groups
        .iter()
        .filter(|g| g.routes.iter().any(|r| r == "/a"))
        .map(|g| g.id.as_str())
        .collect();
    assert_eq!(claims.len(), 1, "claimed exactly once: {claims:?}");
    assert_eq!(claims[0], "g2");
}
```

Wait — `placed_doc` above names a group `g2` that does not exist. Fix the fixture
to hold two groups before writing the test:

```rust
fn placed_doc() -> LayoutDoc {
    doc_with_flow(
        vec!["/a", "/b", "/c", "/d"],
        vec![group("g1", "One", &["/a", "/b"]), group("g2", "Two", &[])],
    )
}
```

And add the `doc_with_flow` helper beside the file's existing `doc()` helper:

```rust
/// A document with an explicit stored flow, for the placement cases: the
/// arrangement is the ORDER here, so a positional case has to state one.
fn doc_with_flow(flow: &[&str], groups: Vec<LayoutGroup>) -> LayoutDoc {
    LayoutDoc {
        view: DesignView::Groups,
        route_order: flow.iter().map(|s| s.to_string()).collect(),
        groups,
        page_labels: HashMap::new(),
    }
}
```

The remaining cases:

```rust
#[test]
fn place_page_puts_the_route_at_the_requested_position_in_its_section() {
    let before = placed_doc();
    // /d is the only ungrouped page; move it into g1 at position 1.
    let after = place_page(before, &known(vec!["/a", "/b", "/c", "/d"]), "/d", Some("g1"), Some(1))
        .expect("places");
    let (groups, _) = panel_sections(&after, &known(vec!["/a", "/b", "/c", "/d"]));
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/d", "/a", "/b"], "lands first, displacing the rest");
}

#[test]
fn place_page_reorders_within_the_current_section_when_no_group_is_given() {
    // /c and /d are ungrouped. Put /d first without touching membership.
    let before = placed_doc();
    let after = place_page(before, &known(vec!["/a", "/b", "/c", "/d"]), "/d", None, Some(1))
        .expect("places");
    let (_, ungrouped) = panel_sections(&after, &known(vec!["/a", "/b", "/c", "/d"]));
    assert_eq!(ungrouped, vec!["/d".to_string(), "/c".to_string()]);
    assert_eq!(after.groups[0].routes.len(), 2, "membership untouched");
}

#[test]
fn place_page_appends_past_the_last_member() {
    // Review Focus 4: `len + 1` is the append slot and is legal. Anything
    // beyond it is refused rather than clamped — a clamped placement lands
    // somewhere the caller did not ask for, which is worse than a re-read.
    let known_routes = known(vec!["/a", "/b", "/c", "/d"]);
    let before = placed_doc();
    let after = place_page(before, &known_routes, "/d", Some("g1"), Some(3)).expect("places");
    let (groups, _) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/a", "/b", "/d"]);
}

#[test]
fn place_page_refuses_a_position_beyond_the_append_slot() {
    let known_routes = known(vec!["/a", "/b", "/c", "/d"]);
    let before = placed_doc();
    // g1 currently holds two pages, so 1..=3 is the valid range.
    let err = place_page(before.clone(), &known_routes, "/c", Some("g1"), Some(4)).unwrap_err();
    assert!(err.contains("1..=3"), "names the valid range: {err}");
    let err_zero = place_page(before, &known_routes, "/c", Some("g1"), Some(0)).unwrap_err();
    assert!(err_zero.contains("1..=3"), "1-based, so 0 is out: {err_zero}");
}

#[test]
fn place_page_refuses_an_unknown_route_or_group() {
    let known_routes = known(vec!["/a", "/b", "/c", "/d"]);
    let err = place_page(placed_doc(), &known_routes, "/nope", None, None).unwrap_err();
    assert!(err.contains("/nope"), "names the route: {err}");
    let err = place_page(placed_doc(), &known_routes, "/c", Some("ghost"), None).unwrap_err();
    assert!(err.contains("ghost"), "names the group: {err}");
}

#[test]
fn placing_a_page_leaves_other_sections_alone() {
    // It is tempting to think a global flow means a placement ripples outward
    // through every section's numbering. It does not: a section's numbering is
    // that section's members in flow order, and inserting a page that is not a
    // member cannot reorder them. A placement touches the section it LEFT and
    // the section it JOINED — never a third. Pinned because the opposite is an
    // easy thing to believe and a hard thing to notice.
    let known_routes = known(vec!["/a", "/b", "/c", "/d", "/e"]);
    let before = doc_with_flow(
        vec!["/a", "/b", "/c", "/d", "/e"],
        vec![group("g1", "One", &["/a", "/b"]), group("g3", "Three", &["/e"])],
    );
    let after = place_page(before, &known_routes, "/c", Some("g1"), Some(1)).expect("places");

    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let three: Vec<&str> = groups
        .iter()
        .find(|g| g.id == "g3")
        .expect("g3 survives")
        .routes
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(three, vec!["/e"], "a section the write never named is untouched");
    assert_eq!(ungrouped, vec!["/d".to_string()], "and only the vacated section lost a page");
}

#[test]
fn placing_a_page_keeps_the_flow_a_permutation() {
    // The invariant the whole document rests on: every page exactly once.
    let known_routes = known(vec!["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/d", Some("g1"), Some(2)).expect("places");
    let mut sorted = after.route_order.clone();
    sorted.sort();
    let mut expected = known_routes.clone();
    expected.sort();
    assert_eq!(sorted, expected, "no page dropped and none duplicated");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: compile failure — `place_page` and `doc_with_flow` not found.

- [ ] **Step 3: Implement**

```rust
/// Place `route` into a group and/or at a position.
///
/// Membership lives in a group's `routes`; position lives in the global
/// `route_order`. This writes both, so "move it and put it here" is one call
/// rather than two that can half-succeed (spec §6).
///
/// `position` is 1-based WITHIN THE RESULTING SECTION — the numbering the Pages
/// panel shows, not an index into the flow, which is global and sparse and
/// which no reader ever sees. `len + 1` is the append slot; anything outside
/// `1..=len + 1` is refused rather than clamped.
///
/// The flow comes back MATERIALISED (spec §4 D6): `route_order` names every page
/// afterwards. Behaviourally invisible — `resolve_route_order` already appends
/// an unnamed page — but it means a placement expresses the whole arrangement
/// rather than part of it, which is what makes a position mean anything.
///
/// A placement touches exactly two sections: the one the page LEFT and the one
/// it JOINED. A third section's numbering cannot move, because its members'
/// relative order in the flow is untouched by inserting a page that is not one
/// of them — worth stating because the opposite is an easy thing to believe
/// about a global flow, and `placing_a_page_leaves_other_sections_alone` pins
/// it. Within the two affected sections, the other pages DO renumber.
pub fn place_page(
    doc: LayoutDoc,
    known_routes: &[String],
    route: &str,
    group_id: Option<&str>,
    position: Option<usize>,
) -> Result<LayoutDoc, String> {
    if !known_routes.iter().any(|r| r == route) {
        return Err(format!("\"{route}\" is not a page in this project"));
    }
    if let Some(gid) = group_id {
        if !doc.groups.iter().any(|g| g.id == gid) {
            return Err(format!("no group with id \"{gid}\""));
        }
    }

    // The section the route lands in: the named group, else whatever claims it
    // today, else ungrouped. Read from the ORIGINAL document, before the
    // membership edit below, because that is what "its current section" means.
    let target: Option<String> = match group_id {
        Some(gid) => Some(gid.to_string()),
        None => doc
            .groups
            .iter()
            .find(|g| g.routes.iter().any(|r| r == route))
            .map(|g| g.id.clone()),
    };

    // Membership: exactly one group claims a route. A route two groups claim
    // displays under the first only (`panel_sections`), so leaving it in both
    // would store a claim no reader ever shows.
    let mut groups = doc.groups;
    for group in groups.iter_mut() {
        group.routes.retain(|r| r != route);
    }
    if let Some(gid) = &target {
        if let Some(group) = groups.iter_mut().find(|g| &g.id == gid) {
            // Assignment order — `assignRoute` appends, and position is carried
            // by the flow, not by this array.
            group.routes.push(route.to_string());
        }
    }

    let in_section = |candidate: &str, groups: &[LayoutGroup]| -> bool {
        match &target {
            Some(gid) => groups
                .iter()
                .any(|g| &g.id == gid && g.routes.iter().any(|r| r == candidate)),
            None => !groups.iter().any(|g| g.routes.iter().any(|r| r == candidate)),
        }
    };

    let mut flow = resolve_route_order(&doc, known_routes);
    flow.retain(|r| r != route);

    // Indices in `flow` of the pages already in the target section, in order.
    let section: Vec<usize> = flow
        .iter()
        .enumerate()
        .filter(|(_, candidate)| in_section(candidate, &groups))
        .map(|(i, _)| i)
        .collect();

    let len = section.len();
    let at = match position {
        // No position asked for: join at the end of the section.
        None => len,
        Some(0) => {
            return Err(format!(
                "position 0 is out of range: positions start at 1, so 1..={} is valid",
                len + 1
            ))
        }
        Some(p) if p > len + 1 => {
            return Err(format!(
                "position {p} is out of range: this section holds {len} page(s), so 1..={} is valid",
                len + 1
            ))
        }
        Some(p) => p - 1,
    };

    // `at < len` sits the route immediately before the page currently holding
    // that slot. `at == len` (the append slot) sits it immediately after the
    // last member, or at the end of the flow when the section is empty.
    let insert_at = if at < len {
        section[at]
    } else {
        section.last().map(|i| i + 1).unwrap_or(flow.len())
    };
    flow.insert(insert_at, route.to_string());

    Ok(LayoutDoc {
        view: doc.view,
        route_order: flow,
        groups,
        page_labels: doc.page_labels,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test layout_doc`
Expected: PASS. If `placing_a_page_keeps_the_flow_a_permutation` fails, the insertion index is wrong — check the `at == len` branch first.

- [ ] **Step 5: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/layout_doc.rs \
        backend/plugins/taskflow-design/tests/layout_doc.rs
git commit -m "feat(design): place a page into a group at a position"
```

---

### Task 5: The agent write route

**Files:**
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs`
- Modify: `backend/plugins/taskflow-design/src/urls.rs:91-96`
- Test: `backend/plugins/taskflow-design/tests/agent_layout_write.rs` (create)

**Interfaces:**
- Consumes: `create_group`, `rename_group`, `move_group`, `place_page` (Tasks 2–4); `DesignLayout.version` (Task 1); `authorized_project`, `project_locks`, `layout_doc::{parse, filter_to_known, validate, to_json_string, to_value}`, `views::known_routes`.
- Produces: `PUT /api/taskflow/agents/design/layout` accepting `{project, base_version?, op}` and returning `{ok: true, version, changed: {groups: [], routes: []}}`.

**This task carries Review Focus 1 and 2** — the deleted page, and the
unparseable row.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent_layout_write.rs`. Copy the harness idiom from
`agent_layout_read.rs` verbatim: `app.create_member_with_project()` is a method,
`seed_agent(project, name)` is a free function returning `(agent_id, key)`,
`seed_page` writes through the operator file route so the manifest has a real
route, and `TestResponse` exposes `status()`, `text()` and `json()` as methods.

```rust
//! The agent layout write: four operations over one route.
//!
//! The read is in `agent_layout_read.rs`; this file owns everything that
//! CHANGES the arrangement.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

/// An app, a member with a project, and an agent credential for that project.
async fn app_with_agent() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Builder").await;
    (app, project, user.id, key)
}

/// One real page, through the operator file route, so the manifest has a route
/// a layout document can name.
async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str, name: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": format!("<main class=\"p-4\">{name}</main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
}

fn layout_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

fn read_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_creates_a_group_and_reads_it_back() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], 1, "the first write creates the row at version 1");
    let group_id = body["changed"]["groups"][0].as_str().expect("the new group id");

    // And it is really there, through the read the agent already has.
    let read = app.get_as_agent(&key, &read_path(project)).await;
    let doc = read.json();
    assert_eq!(doc["groups"][0]["id"], group_id);
    assert_eq!(doc["groups"][0]["name"], "Player");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_page_does_not_wedge_future_writes() {
    // Review Focus 1. The stored document still names a page that is gone;
    // `validate` REJECTS unknown routes while `load_layout` FILTERS them, so a
    // write that began from the raw row would fail forever on a page nobody can
    // see. The write must begin from the served view.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;
    seed_page(&app, project, user, "pages/b.html", "B").await;

    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let group_id = created["changed"]["groups"][0].as_str().unwrap().to_string();

    // Arrange /b into that group, then delete /b behind the document's back.
    app.put_as_agent(
        &key,
        &layout_path(project),
        json!({ "project": project, "op": { "reorder_page": { "route": "/b", "group_id": group_id } } }),
    )
    .await;
    app.delete_page_row(project, "pages/b.html").await;

    // A fresh, unrelated write must still succeed.
    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "a dead route must not block an edit: {}", res.text());

    let after = app.get_as_agent(&key, &read_path(project)).await.json();
    let named: Vec<String> = after["flow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(!named.contains(&"/b".to_string()), "and the dead route is gone: {named:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unparseable_row_is_refused_rather_than_reset() {
    // Review Focus 2. `load_layout` degrades to `default_doc()` on a row that
    // will not parse. Doing that on the WRITE side would persist `default + op`
    // and silently discard the real arrangement.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // The operator arranges something real, then the bytes go bad underneath.
    app.put_json_as(
        user,
        &format!("/api/design/{project}/layout"),
        &json!({
            "view": "groups",
            "routeOrder": ["/a"],
            "groups": [{ "id": "gkeep", "name": "Keep Me", "routes": ["/a"] }],
            "pageLabels": {}
        }),
    )
    .await;
    app.write_layout_json(project, "{ this is not json").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 500, "refused, not repaired: {}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.layout_json, "{ this is not json", "and nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_write_another_projects_layout() {
    let (app, project, _user, key) = app_with_agent().await;
    let (_other_user, other_project) = app.create_member_with_project().await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(other_project),
            json!({ "project": other_project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert!(res.status() >= 400, "the credential's own project only: {}", res.text());

    // Positive control: the SAME credential and the SAME body against its own
    // project is accepted, so the refusal above is about the project and not
    // about the request being malformed.
    let ok = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_arguments_are_refused_with_a_reason() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // A blank name is refused by `validate`, which owns the name rules.
    let blank = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "   " } } }),
        )
        .await;
    assert_eq!(blank.status(), 400, "{}", blank.text());
    assert!(
        blank.json()["message"].as_str().unwrap_or_default().contains("empty"),
        "validate's own message is surfaced: {}",
        blank.text()
    );

    // An unknown group id names the id.
    let ghost = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "update_group": { "group_id": "ghost", "name": "X" } } }),
        )
        .await;
    assert_eq!(ghost.status(), 400, "{}", ghost.text());
    assert!(ghost
        .json()["message"]
        .as_str()
        .unwrap_or_default()
        .contains("ghost"));
}
```

Add to `tests/support/mod.rs`, beside `latest_layout_row`:

```rust
/// Drop a page row directly, standing in for "the operator deleted a page while
/// the arrangement still named it".
pub async fn delete_page_row(&self, project: i64, path: &str) {
    use taskflow_design::models::{DesignFile, design_file};
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project) & design_file::PATH.eq(path))
        .delete()
        .await
        .expect("delete the page");
}

/// Force the stored document to arbitrary bytes, standing in for a row written
/// by a build with a different shape.
pub async fn write_layout_json(&self, project: i64, raw: &str) {
    use taskflow_design::models::{DesignLayout, design_layout};
    let row = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project))
        .first()
        .await
        .expect("layout query")
        .expect("a layout row");
    DesignLayout::objects()
        .filter(design_layout::ID.eq(row.id))
        .update_values(json!({ "layout_json": raw }).as_object().cloned().unwrap_or_default())
        .await
        .expect("force layout json");
}
```

**No test for the 65536 guard**, deliberately. `validate` caps groups at 24 and
names at 40 characters, so no document reachable through this route comes close
to the column's limit — the check is defence against a future change, and a test
for it would have to fabricate a state the route cannot produce.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-design --test agent_layout_write`
Expected: compile failure — the helpers do not exist; then 404/405 once they do, because the route is GET-only.

- [ ] **Step 3: Implement the operations and the handler**

In `agent_views.rs`, in the writes section:

```rust
/// The four arrangement edits an agent may make.
///
/// One enum on one route because these are four edits to ONE resource — the
/// document — not four resources. Never a document in, either: the read
/// response is the panel's view and is lossy in both directions, so a payload
/// that PUT it back would silently reorder every group by the flow
/// (`agent_views.rs` read_layout, "This response is NOT the document").
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutOp {
    /// Add an empty group. The name rules live in `validate`.
    CreateGroup { name: String },
    /// Rename one group. Membership is `ReorderPage`'s job.
    UpdateGroup { group_id: String, name: String },
    /// Move a group to a 1-based slot in the group list.
    ReorderGroup { group_id: String, position: usize },
    /// Move a page into a group and/or to a 1-based position in its section.
    ReorderPage {
        route: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        position: Option<usize>,
    },
}

#[derive(Debug, Deserialize)]
pub struct AgentLayoutWrite {
    pub project: i64,
    #[serde(default)]
    pub base_version: Option<i64>,
    pub op: LayoutOp,
}

/// What one write did, resolved inside the lock so the response can be built
/// without holding it.
enum LayoutOutcome {
    Written {
        version: i64,
        groups: Vec<String>,
        routes: Vec<String>,
    },
    Conflict {
        current: i64,
        doc: serde_json::Value,
    },
    Invalid(String),
}

/// `PUT /api/taskflow/agents/design/layout` — the agent's arrangement write.
///
/// Read-modify-write inside the project lock, exactly as the operator's
/// `put_layout` does, so an agent's edit and the operator's save cannot
/// interleave.
///
/// It begins from the SERVED view (`filter_to_known`), not the stored row.
/// `validate` REJECTS a route the manifest no longer has, while `load_layout`
/// FILTERS one out; a write that started from the raw row would therefore fail
/// forever the moment a page was deleted, naming a page nobody can see. That
/// asymmetry is deliberate on both sides — see `layout_doc`'s module docs — and
/// this is the composition that respects it.
///
/// A row that exists but will not PARSE is a 500 and nothing is written. The
/// read's fallback to `default_doc()` is right for a read and catastrophic
/// here: it would persist `default + op` and discard the real arrangement.
pub async fn write_layout(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentLayoutWrite>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let project_id = agent.project_id;
    let by = format!("{} ({})", agent.display_name, agent.agent_id);
    let known = crate::views::known_routes(project_id).await;

    let outcome = crate::views::project_locks()
        .with_lock(project_id, || async {
            let existing = DesignLayout::objects()
                .filter(design_layout::PROJECT.eq(project_id))
                .first()
                .await
                .map_err(|err| {
                    eprintln!("design layout read: {err}");
                    StatusCode::INTERNAL_SERVER_ERROR
                })?;

            let current_version = existing.as_ref().map(|row| row.version).unwrap_or(0);

            let stored = match existing.as_ref() {
                Some(row) => layout_doc::parse(&row.layout_json).map_err(|err| {
                    eprintln!(
                        "design layout write refused: the stored document will not parse: {err}"
                    );
                    StatusCode::INTERNAL_SERVER_ERROR
                })?,
                None => layout_doc::default_doc(),
            };
            let doc = layout_doc::filter_to_known(stored, &known);

            // A supplied base that does not match is refused; an OMITTED base
            // is the normal case and simply proceeds at the current version,
            // which is what makes the tool safe for an agent that never read.
            if let Some(base) = input.base_version {
                if base != current_version {
                    return Ok(LayoutOutcome::Conflict {
                        current: current_version,
                        doc: layout_doc::to_value(&doc),
                    });
                }
            }

            let before_doc = doc.clone();
            let mut minted: Option<String> = None;

            // Matched by REFERENCE: `input.op` is read again below to say what
            // changed, and matching by value would move it out from under that.
            let next = match &input.op {
                LayoutOp::CreateGroup { name } => {
                    let (next, id) = layout_doc::create_group(doc, name);
                    minted = Some(id);
                    next
                }
                LayoutOp::UpdateGroup { group_id, name } => {
                    match layout_doc::rename_group(doc, &group_id, name) {
                        Ok(next) => next,
                        Err(message) => return Ok(LayoutOutcome::Invalid(message)),
                    }
                }
                LayoutOp::ReorderGroup { group_id, position } => {
                    match layout_doc::move_group(doc, &group_id, *position) {
                        Ok(next) => next,
                        Err(message) => return Ok(LayoutOutcome::Invalid(message)),
                    }
                }
                LayoutOp::ReorderPage { route, group_id, position } => {
                    match layout_doc::place_page(doc, &known, route, group_id.as_deref(), *position) {
                        Ok(next) => next,
                        Err(message) => return Ok(LayoutOutcome::Invalid(message)),
                    }
                }
            };

            // Note the `return Ok(...)`: the closure's error type is
            // `StatusCode`, and a rule failure is a 400 with `validate`'s or the
            // operation's own message, not a 500. `?` cannot do this conversion,
            // so every fallible step is matched explicitly.
            let validated = match layout_doc::validate(next, &known) {
                Ok(doc) => doc,
                Err(message) => return Ok(LayoutOutcome::Invalid(message)),
            };

            let json = layout_doc::to_json_string(&validated);
            if json.len() > 65536 {
                return Ok(LayoutOutcome::Invalid(
                    "the arrangement is too large to store".to_string(),
                ));
            }

            let next_version = current_version + 1;
            match existing.as_ref() {
                Some(row) => {
                    let updated = DesignLayout::objects()
                        .filter(design_layout::ID.eq(row.id) & design_layout::VERSION.eq(row.version))
                        .update_values(
                            json!({
                                "view": validated.view,
                                "layout_json": json,
                                "updated_by": by,
                                "updated_at": chrono::Utc::now(),
                                "version": next_version,
                            })
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                        )
                        .await
                        .map_err(|err| {
                            eprintln!("design layout agent update: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                    if updated == 0 {
                        // Slipped past the lock. Report the current row rather
                        // than pretending the write landed.
                        return Ok(LayoutOutcome::Conflict {
                            current: row.version,
                            doc: layout_doc::to_value(&validated),
                        });
                    }
                }
                None => {
                    DesignLayout::objects()
                        .create(json!({
                            "project": project_id,
                            "view": validated.view,
                            "layout_json": json,
                            "updated_by": by,
                            "updated_at": chrono::Utc::now(),
                            "version": 1,
                        }))
                        .await
                        .map_err(|err| {
                            eprintln!("design layout agent create: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                }
            }

            // A create reports the id it minted; the other three report the
            // group the caller named, since that is what was asked about.
            let changed_groups: Vec<String> = match (&minted, &input.op) {
                (Some(id), _) => vec![id.clone()],
                (None, LayoutOp::UpdateGroup { group_id, .. })
                | (None, LayoutOp::ReorderGroup { group_id, .. }) => vec![group_id.clone()],
                (None, LayoutOp::ReorderPage { group_id, .. }) => {
                    group_id.iter().cloned().collect()
                }
                (None, LayoutOp::CreateGroup { .. }) => Vec::new(),
            };

            // Which pages changed VISIBLE position. A positional diff of the raw
            // flow would flag pages whose global index moved while nothing a
            // reader can see changed — and a placement materialises the flow
            // (D6), so that is most of them. Compare each page's 1-based index
            // WITHIN ITS SECTION instead, which is the numbering the panel
            // shows: that is what "did anything move?" means.
            let section_index = |doc: &LayoutDoc| {
                let (groups, ungrouped) = layout_doc::panel_sections(doc, &known);
                let mut map: std::collections::HashMap<String, usize> =
                    std::collections::HashMap::new();
                for group in groups {
                    for (index, route) in group.routes.into_iter().enumerate() {
                        map.insert(route, index + 1);
                    }
                }
                for (index, route) in ungrouped.into_iter().enumerate() {
                    map.insert(route, index + 1);
                }
                map
            };
            let before_positions = section_index(&before_doc);
            let after_positions = section_index(&validated);
            let mut changed_routes: Vec<String> = after_positions
                .iter()
                .filter(|(route, position)| before_positions.get(*route) != Some(*position))
                .map(|(route, _)| route.clone())
                .collect();
            // A page that changed SECTION but happened to keep its index would
            // not show up above, and it is the very page the caller named.
            if let LayoutOp::ReorderPage { route, .. } = &input.op {
                if !changed_routes.contains(route) {
                    changed_routes.push(route.clone());
                }
            }
            changed_routes.sort();

            Ok(LayoutOutcome::Written {
                version: next_version,
                groups: changed_groups,
                routes: changed_routes,
            })
        })
        .await?;

    Ok(match outcome {
        LayoutOutcome::Written { version, groups, routes } => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "version": version,
                "changed": { "groups": groups, "routes": routes },
            })),
        )
            .into_response(),
        LayoutOutcome::Conflict { current, doc } => conflict_response_values(current, doc),
        LayoutOutcome::Invalid(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "invalid_operation", "message": message })),
        )
            .into_response(),
    })
}
```

Add `conflict_response_values` beside `conflict_response` in `views.rs`,
returning the same shape so an agent meets one conflict vocabulary across the
whole design surface:

```rust
/// The layout's 409: the same shape `conflict_response` uses for a file.
pub fn conflict_response_values(current_version: i64, doc: serde_json::Value) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "ok": false,
            "error": "version_conflict",
            "message": "Someone else rearranged this board after your read. Re-read, merge and retry.",
            "current_version": current_version,
            "current_document": doc,
        })),
    )
        .into_response()
}
```

- [ ] **Step 4: Register the route**

In `urls.rs`, replace the GET-only layout route (`:91-96`) with:

```rust
        // The arrangement. GET is the panel's view of it; PUT is the four
        // agent operations, and the ONLY way an agent changes it — an agent can
        // see how the pages are grouped and ordered, and may now arrange them
        // through `agent_views::write_layout`'s op-tagged body rather than by
        // sending a document.
        .route(
            "/api/taskflow/agents/design/layout",
            get(agent_views::read_layout).put(agent_views::write_layout),
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test agent_layout_write`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/agent_views.rs \
        backend/plugins/taskflow-design/src/urls.rs \
        backend/plugins/taskflow-design/src/views.rs \
        backend/plugins/taskflow-design/tests/agent_layout_write.rs \
        backend/plugins/taskflow-design/tests/support/mod.rs
git commit -m "feat(design): the agent layout write route -- four arrangement operations"
```

---

### Task 6: Version semantics end to end

**Files:**
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`read_layout`)
- Test: `backend/plugins/taskflow-design/tests/agent_layout_write.rs` (append)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `design_read_layout`'s response gains `version: i64` — the layout row's version, `0` when no row exists.

**This task carries Review Focus 5.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn the_read_reports_the_layouts_own_version() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // Nobody has arranged anything yet.
    let fresh = app.get_as_agent(&key, &read_path(project)).await.json();
    assert_eq!(fresh["version"], 0, "no row yet, so 0 is the base to write from");

    app.put_as_agent(
        &key,
        &layout_path(project),
        json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
    )
    .await;

    let after = app.get_as_agent(&key, &read_path(project)).await.json();
    assert_eq!(after["version"], 1);
    assert_ne!(
        after["version"], after["revision"],
        "the manifest revision is a different number and must not be mistaken for this one"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_base_version_is_refused_with_the_current_document() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let first = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let stale = first["version"].as_i64().unwrap();

    // Someone else moves the board on.
    app.put_as_agent(
        &key,
        &layout_path(project),
        json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
    )
    .await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": stale,
                "op": { "create_group": { "name": "Three" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 409, "{}", res.text());
    let body = res.json();
    assert_eq!(body["error"], "version_conflict");
    assert_eq!(body["current_version"], stale + 1);
    assert_eq!(
        body["current_document"]["page_labels"], json!({}),
        "the current document comes back so a caller can merge rather than guess"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_omitted_base_version_never_conflicts() {
    // Review Focus 5, and the whole point of D1: an agent that never read is
    // never blocked. Ten writes in a row, none of them sending a version.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    for n in 0..10 {
        let res = app
            .put_as_agent(
                &key,
                &layout_path(project),
                json!({ "project": project, "op": { "create_group": { "name": format!("G{n}") } } }),
            )
            .await;
        assert_eq!(res.status(), 200, "write {n}: {}", res.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_round_trip_base_version_is_accepted() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let read = app.get_as_agent(&key, &read_path(project)).await.json();
    let version = read["version"].as_i64().unwrap();

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": version,
                "op": { "create_group": { "name": "One" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 200, "the version the read just handed out is current: {}", res.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_operator_save_makes_a_held_version_stale() {
    // The operator sends no version and always wins, but their save must move
    // the number or an agent holding an old one would never be told.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let first = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let held = first["version"].as_i64().unwrap();

    let op = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/layout"),
            &json!({
                "view": "groups",
                "routeOrder": ["/a"],
                "groups": [{ "id": "goperator", "name": "Operator", "routes": ["/a"] }],
                "pageLabels": {}
            }),
        )
        .await;
    assert_eq!(op.status(), 200, "{}", op.text());

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": held,
                "op": { "create_group": { "name": "Two" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 409, "the operator's save moved the number: {}", res.text());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-design --test agent_layout_write`
Expected: FAIL — `fresh["version"]` is null (the read does not report it yet).

- [ ] **Step 3: Implement**

In `agent_views.rs::read_layout`, the `load_layout` call already returns the row
it read. Change `views::load_layout` to also return the version, or read it
alongside — the simplest change that keeps one loader:

```rust
    let (doc, m) = crate::views::load_layout(agent.project_id).await?;
    // The layout ROW's version, not the manifest's `revision` below: that one
    // is `max(design_file.version)` and answers a different question — which
    // fragments changed — so an agent must never hand it back as a base.
    let version: i64 = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(agent.project_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(|row| row.version)
        .unwrap_or(0);
```

and add `"version": version,` to the response `json!({...})`, above `"revision"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-design --test agent_layout_write`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/agent_views.rs \
        backend/plugins/taskflow-design/tests/agent_layout_write.rs
git commit -m "feat(design): the layout read reports its own version, and a stale base is refused"
```

---

### Task 7: The panel sees an agent's rearrangement

**Files:**
- Modify: `backend/plugins/taskflow-design/tests/realtime_bulk_bridge.rs` (append)

**Interfaces:**
- Consumes: the write route (Task 5).
- Produces: nothing new — this pins that the existing bridge covers agent writes too.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn an_agents_rearrangement_broadcasts_to_the_project_group() {
    // The bridge (`signals.rs:114`) covers `bulk_post_save:design_layout`, which
    // is what any `update_values` on the row fires. An agent's write must reach
    // the same group as the operator's, or the panel would show a stale board
    // until someone reloaded — the exact silence the bridge was built to end.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Builder").await;

    // One real page, so the manifest has a route a document may name.
    let seeded = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/a.html", "content": "<main class=\"p-4\">A</main>" }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());

    let path = format!("/api/taskflow/agents/design/layout?project={project}");

    // The first write CREATES the row, which belongs to `Expose`, not the
    // bridge — so it is deliberately outside the watch below.
    let created = app
        .put_as_agent(&key, &path, json!({ "project": project, "op": { "create_group": { "name": "One" } } }))
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());

    let mut watch = app.watch();
    let second = app
        .put_as_agent(&key, &path, json!({ "project": project, "op": { "create_group": { "name": "Two" } } }))
        .await;
    assert_eq!(second.status(), 200, "{}", second.text());

    let events = drain(&mut watch).await;
    let layout: Vec<_> = events
        .iter()
        .filter(|(channel, _, _)| channel == &format!("project:{project}:design_layout"))
        .collect();
    assert_eq!(layout.len(), 1, "exactly one event, not one per field: {events:?}");
    assert_eq!(layout[0].1, "updated");
}
```

- [ ] **Step 2: Run the test**

Run: `cd backend && cargo test -p taskflow-design --test realtime_bulk_bridge an_agents_rearrangement`
Expected: PASS if the bridge already covers it. If it reports zero events, the agent path is updating the row in a way that bypasses `update_values` — re-check Task 5 Step 3 before changing anything here.

- [ ] **Step 3: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/tests/realtime_bulk_bridge.rs
git commit -m "test(design): an agent's rearrangement reaches the panel's event group"
```

---

### Task 8: Retire the read-only claims

**Files:**
- Modify: `backend/plugins/taskflow-design/tests/agent_layout_read.rs:311-359`
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`read_layout`'s doc comment and the response `note`)
- Modify: `backend/plugins/taskflow-design/src/urls.rs` (comment — done in Task 5 Step 4)

**Interfaces:**
- Consumes: the write route (Task 5).
- Produces: nothing.

Spec §13. Four pieces of text assert the opposite of what now exists; three are
Rust-side and live here. The `note` string and the doc comment are the ones an
agent actually reads, so they matter more than the comment.

- [ ] **Step 1: Rewrite the test to pin the NEW boundary**

`agent_layout_read.rs:311`'s `the_layout_read_is_not_a_write_surface` asserts
the layout cannot be written. It is **rewritten, not deleted** — it was guarding
exactly the thing this work changes, and the boundary worth pinning now is
narrower: reads stay GET-only, and writes go only through the op route.

```rust
#[tokio::test(flavor = "multi_thread")]
async fn the_layout_write_takes_an_operation_and_not_a_document() {
    // This test used to assert the layout had NO write surface at all. That
    // changed deliberately: an agent may now arrange the board through
    // `PUT .../design/layout`, whose body is an OPERATION. What survives is the
    // narrower guarantee that mattered — a document built from this read can
    // never be PUT back, because the route does not accept one.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;

    // GET is unchanged.
    let read = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/layout?project={project}"))
        .await;
    assert_eq!(read.status, 200);

    // A document PUT at the read's own path is refused: the body must be an
    // operation, so the lossy read response can never be round-tripped into
    // storage.
    let res = app
        .put_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/layout?project={project}"),
            serde_json::json!({
                "project": project,
                "view": "groups",
                "routeOrder": [],
                "groups": [],
                "pageLabels": {}
            }),
        )
        .await;
    assert!(
        res.status() >= 400,
        "a document is not an operation, so it is refused: {}",
        res.text()
    );

    // And nothing changed — this is what carries the weight, since the exact
    // code is axum's extractor to choose and a 4xx that had stored the body on
    // its way out would look identical from the status alone.
    let after = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(after.json()["groups"], json!([]), "the refused document left no group");

    // Positive control: the same credential, a real operation, accepted.
    let ok = app
        .put_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/layout?project={project}"),
            serde_json::json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(ok.status, 200, "{:?}", ok.text);
}
```

Delete the original assertion block, keep the file's other cases untouched.

- [ ] **Step 2: Run the test**

Run: `cd backend && cargo test -p taskflow-design --test agent_layout_read`
Expected: PASS.

- [ ] **Step 3: Update the prose an agent reads**

In `agent_views.rs::read_layout`'s doc comment, replace the paragraph beginning
`/// READ ONLY, deliberately.` with:

```rust
/// The arrangement is readable here and writable at the same path by
/// `write_layout`, whose body is an OPERATION rather than a document — the
/// contract change this read was waiting on (it is no longer last-write-wins:
/// the row carries a `version`). The warning below still binds: this response
/// is the panel's view, lossy in both directions, and must never be PUT back.
```

In the response `note`'s final sentence, replace
`"Read-only: arranging pages is the operator's."` with:

```rust
                 "Arrange it with the layout write tools, which take an "
                 "operation — never PUT a document built from this response " \
                 "back, because this is the panel's view and not the stored " \
                 "form."
```

- [ ] **Step 4: Run the whole suite**

Run: `cd backend && cargo test -p taskflow-design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && cargo fmt
git add backend/plugins/taskflow-design/src/agent_views.rs \
        backend/plugins/taskflow-design/tests/agent_layout_read.rs
git commit -m "docs(design): the layout is writable now, and the read says so"
```

---

### Task 9: The MCP tools

**Files:**
- Modify: `mcp/src/client.ts` (beside `designReadLayout`, `:497`)
- Modify: `mcp/src/server.ts` (beside `design_read_layout`, `:1051`)
- Test: `mcp/src/server.test.ts` (append; and update the assertion at `:507`)

**Interfaces:**
- Consumes: `PUT /agents/design/layout` (Tasks 5–6).
- Produces: four MCP tools; `designClient.writeLayoutOp`.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/src/server.test.ts`, following the `design_read_layout`
registration assertions at `:507`:

```ts
describe('layout write tools', () => {
  // These go over the REAL transport like every other case in this file — the
  // parts that go wrong are the parts a helper test cannot see, and for these
  // tools that is the SHAPE of the operation object that reaches the client.

  it('registers all four', async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const name of [
      'design_create_group',
      'design_update_group',
      'design_reorder_group',
      'design_reorder_page',
    ]) {
      expect(names, `${name} must be registered`).toContain(name);
    }
  });

  it('says the version is optional, because omitting it is the normal case', async () => {
    // An agent that never read must not be told it has to read first.
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'design_reorder_page');
    const description = tool?.description ?? '';
    expect(description).toMatch(/base_version/i);
    expect(description).toMatch(/optional|omit/i);
  });

  it('sends an operation and nothing else', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'design_create_group',
      arguments: { profile: 'main', name: 'Player' },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain('writeLayoutOp:2');
    expect(JSON.parse(harness.layoutOps.at(-1) ?? '{}')).toEqual({
      op: { create_group: { name: 'Player' } },
    });
  });

  it('forwards a supplied base_version untouched', async () => {
    const client = await connectedClient();
    await client.callTool({
      name: 'design_reorder_group',
      arguments: { profile: 'main', group_id: 'g1', position: 2, base_version: 7 },
    });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? '{}')).toEqual({
      base_version: 7,
      op: { reorder_group: { group_id: 'g1', position: 2 } },
    });
  });

  it('omits base_version entirely rather than sending null', async () => {
    // `null` would fail the route's `Option<i64>` deserialisation differently
    // from an absent key, so "not supplied" has to mean "key absent".
    const client = await connectedClient();
    await client.callTool({
      name: 'design_update_group',
      arguments: { profile: 'main', group_id: 'g1', name: 'X' },
    });
    const sent = JSON.parse(harness.layoutOps.at(-1) ?? '{}');
    expect('base_version' in sent).toBe(false);
  });
});
```

**The harness needs two additions** to support the above, both in the
`vi.hoisted` block and the fake client at the top of `server.test.ts`:

```ts
// in the hoisted block, beside `calls`
  /** The body of each writeLayoutOp the tools sent, as JSON. */
  layoutOps: [] as string[],
```

```ts
// on the fake client, beside its readDesignLayout
  async writeLayoutOp(input: unknown) {
    harness.calls.push(`writeLayoutOp:${this.project}`);
    harness.layoutOps.push(JSON.stringify(input));
    return { ok: true, version: 2, changed: { groups: ['g1'], routes: [] } };
  }
```

(Match whatever the fake's existing `readDesignLayout` does for the project —
the `:2` in the assertion is the project the tool resolved to, the same `2` the
existing read case asserts.)

And the existing `design_read_layout` case at `:507` ends with
`expect(description).toMatch(/read-only/i)` — replace that single line with:

```ts
    // It points at the write tools rather than claiming there are none. This
    // sentence used to read "there is no tool that writes it", which is exactly
    // the kind of prose that goes stale silently.
    expect(description).toMatch(/design_create_group/);
    expect(description).not.toMatch(/no tool that writes it/i);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm test -- server.test.ts`
Expected: FAIL — the four tools are unregistered and the description still says read-only.

- [ ] **Step 3: Implement the client method**

In `client.ts`, after `designReadLayout`:

```ts
  /** `PUT /agents/design/layout` — one arrangement operation.
   *
   * The body is an OPERATION, never a document: the read response is the
   * panel's view of the arrangement and is lossy in both directions, so a
   * document built from it must never be sent back. `base_version` is optional
   * — omitted, the server works from whatever it currently holds. */
  writeLayoutOp(input: {
    project: number
    op: DesignLayoutOp
    base_version?: number
  }): Promise<unknown> {
    return this.request("PUT", `${API_PREFIX}/agents/design/layout`, {
      body: {
        project: input.project,
        ...(input.base_version === undefined ? {} : { base_version: input.base_version }),
        op: input.op,
      },
    })
  }
```

with the operation type beside the other design types:

```ts
/** The four arrangement edits. One of these, tagged, is the whole body. */
export type DesignLayoutOp =
  | { create_group: { name: string } }
  | { update_group: { group_id: string; name: string } }
  | { reorder_group: { group_id: string; position: number } }
  | { reorder_page: { route: string; group_id?: string; position?: number } }
```

- [ ] **Step 4: Implement the four tools**

In `server.ts`, after `design_read_layout`:

```ts
  server.tool(
    "design_create_group",
    "Add a named page group to the project's arrangement — the Pages panel's groups, which decide how screens are sectioned. The name must be non-blank, at most 40 characters, and not already used in THIS project (another project may use the same name). Returns the new group's id; put pages in it with design_reorder_page. Requires no version: if you have not read the board, the write simply applies.",
    { ...designProjectArg, name: z.string().describe("The group name."), ...profileArg, ...baseVersionArg },
    async ({ project, name, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.writeLayoutOp({
          project: await resolveDesignProject(client, project),
          op: { create_group: { name } },
          ...(base_version === undefined ? {} : { base_version }),
        }));
      } catch (err) {
        return fail(err);
      }
    },
  )
```

Repeat that shape for the other three, changing the description, the schema and
the `op`:

- **`design_update_group`** — `group_id`, `name`. Description: renames a group;
  membership is untouched, so renaming can never empty a group; `group_id` comes
  from `design_read_layout`.
- **`design_reorder_group`** — `group_id`, `position` (`z.number().int()`).
  Description: moves a group to a 1-based slot in the group list; it is a MOVE,
  not a swap, so groups between slide along.
- **`design_reorder_page`** — `route`, `group_id` (optional), `position`
  (optional). Description: places a page into a group and/or at a 1-based
  position within that section — the numbering the panel shows, not an index
  into the flow. Passing only `group_id` appends to that group; only `position`
  reorders within the section that already holds the page. Both together do
  both in one write. Moving a page renumbers the section it left and the one it
  joined; other sections are unaffected. The response's `changed.routes` names
  every page whose visible position moved.

with, beside `designProjectArg`:

```ts
// Shared by the layout writes. Optional on purpose: omitted, the server works
// from the version it currently holds, so an agent that never read is never
// blocked. Supply one (from design_read_layout's `version`) to be TOLD when
// someone else moved the board instead of writing over them.
const baseVersionArg = {
  base_version: z
    .number()
    .int()
    .optional()
    .describe(
      "The layout version you read. Optional: omit and the write applies to the current board. Supply it to get a 409 instead of overwriting a change you have not seen.",
    ),
}
```

**And update `design_read_layout`'s description** (`:1052`) — the
`Read-only: arranging the board is the operator's, and there is no tool that
writes it.` clause is now false. Replace it with:

```ts
    " ... `view` is the canvas arrangement (rows/bands/groups) and the grouping reads the same in all three. `version` is THIS arrangement's version — hand it to a layout write as `base_version` to be told if someone rearranged the board under you. (Note `revision` next to it is a different number: the manifest's, which moves when a page changes.) Arrange the board with design_create_group, design_update_group, design_reorder_group and design_reorder_page, which take an operation — never PUT a document built from this response back, because this is the panel's view and not the stored form.",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd mcp && npm test -- server.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and build**

Run: `cd mcp && npm run build`
Expected: clean. The committed `dist/` is what the global install runs.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/client.ts mcp/src/server.ts mcp/src/server.test.ts mcp/dist
git commit -m "feat(mcp): four tools that arrange the board"
```

---

### Task 10: Prove it end to end, locally

**Files:** none — this task produces evidence, not code.

**Interfaces:**
- Consumes: everything.
- Produces: a run against a real request path, which is the bar the spec sets
  (§10) and the gap that let the screenshot 503 sit unnoticed.

- [ ] **Step 1: Stand up the backend locally**

The local Postgres is already listening on `:5432`. Build and run the backend
against it, applying migrations, then confirm the new column exists:

```bash
cd backend && cargo run --bin taskflow 2>&1 | tail -20
psql -h localhost -U postgres -d taskflow -c "\d design_layout" | grep version
```

Expected: a `version | bigint | not null | 1` line. If migrations did not run,
follow `backend/README.md` rather than inventing a path.

- [ ] **Step 2: Point a scratch profile at it**

Create a scratch project and an agent key on the local backend, then write a
`.taskflow.json` **in a scratch directory** — never over the zoezi one, whose
project 13 lives on the hosted backend:

```json
{ "server": "http://localhost:8000", "project": <scratch>, "default_profile": "main",
  "profiles": { "main": { "agent_id": <id>, "key": "tfk_...", "display_name": "Probe" } } }
```

- [ ] **Step 3: Install the rebuilt MCP and drive it**

```bash
cd mcp && npm run build && npm install -g .
```

Then, in a session rooted at the scratch directory, exercise every tool against
real data and confirm each against the read:

1. `design_create_group` ×2 — read back, assert both exist in order.
2. `design_reorder_group` — move the second to slot 1; read back, assert order.
3. `design_update_group` — rename; read back.
4. `design_reorder_page` — place a page into a group at position 1; read back,
   assert the section order.
5. `design_reorder_page` with a `base_version` from a stale read → **assert a
   409** and that `current_document` reflects reality.
6. Omit `base_version` and write again → **assert 200**.

- [ ] **Step 4: Record what actually happened**

Post the transcript to the Design room (channel 36) and attach a comment on the
TaskFlow task, including anything that behaved differently from this plan. A
step that "worked" without the read-back is not evidence.

- [ ] **Step 5: Hand over the deploy**

The hosted backend still runs the old build. Summarise what needs deploying
(backend + migration 0003 + the rebuilt MCP) for the human to run — do not
deploy without being asked.

```
