# Agent layout-write tools — create/rename/reorder groups, place pages

**Date:** 2026-09-27
**Status:** design approved in conversation; ready for an implementation plan
**Surface:** `backend/plugins/taskflow-design` (Rust) + `mcp/src` (TypeScript)

## 1. Summary

The Design Surface's arrangement — which page groups exist, what they are called,
what order they come in, and what order pages flow in — is readable by an agent
and was, deliberately, not writable by one. `urls.rs:91` mounts the agent layout
path as `get()` only, and `agent_views.rs:254` records why: *"arranging someone's
board is a curatorial act, and the write has a contract change to make first."*

This spec makes that contract change and adds the four tools that follow:

| Tool | Purpose |
|---|---|
| `design_create_group` | Add a named group |
| `design_update_group` | Rename a group |
| `design_reorder_group` | Move a group within the group list |
| `design_reorder_page` | Place a page into a group and/or at a position |

Motivating case: the Pamoja project has 40 screens, six of them ungrouped (`/`
plus five `workout-*` routes), with "Player" holding its own group while the
workout screens float outside one. Fixing that class of thing is currently
operator-only.

## 2. Non-goals

- **No `design_delete_group`.** Removing a group silently dumps its pages into
  ungrouped; it is the destructive half and nobody asked for it.
- **No page deletion.** Agents can create a route and never remove one — a real
  gap, but a separate piece of work from this one.
- **No frontend changes.** The panel already reacts to layout events by
  refetching (`DesignSurfacePage.tsx:249`), so agent rearrangements appear live
  with no `v2_fe` work.
- **No change to how the operator writes.** `put_layout` keeps last-write-wins.

## 3. What exists today

- **One row per project.** Table `design_layout`
  (`migrations/taskflow_design/0002_create_design_layout.json`), model at
  `models.rs:183`. `unique_together: [["project"]]`. Columns: `id`, `project`,
  `view`, `layout_json` (max 65536), `updated_by`, `created_at`, `updated_at`.
- **The document** (`layout_doc.rs`): `{view, route_order, groups[], page_labels}`.
  `route_order` is **sparse** — `resolve_route_order` (`:169`) appends pages it
  does not name, so the stored list alone is not an arrangement. A group's
  `routes` array is **assignment order** (`assignRoute` appends), not display
  order.
- **Validation is strict and rejects unknown routes** — `layout_doc.rs:108`
  (`groups`), `:124` (`route_order`), `:136` (`labels`) all return
  `Err("\"{route}\" is not a page in this project")`.
- **Reads degrade silently.** `load_layout` (`views.rs:190`) falls back to
  `default_doc()` if the row fails to parse, then `filter_to_known` drops routes
  whose pages are gone.
- **No concurrency token.** `design_layout` has no `version` column; the sibling
  `design_file` does (`models.rs:74`). `put_layout` says so explicitly at
  `views.rs:227`.
- **Events already work.** Updates emit on `project:{id}:design_layout`
  (`signals.rs:79`, bridged at `signals.rs:114`), payload id-only, and the panel
  refetches on receipt.

## 4. Decisions

**D1 — Version the row; the version is auto-computed by default.**
Migration `0003_add_design_layout_version.json` mirrors `design_file`: `version`
BigInt, not null, default 1.

`base_version` on the write tools is **optional**:

- **Omitted** — the handler reads the current version, applies the operation and
  writes with a conditional UPDATE at that version. This never returns a 409 on
  staleness. The UPDATE is still guarded by `VERSION.eq(row.version)` +
  `version + 1`, so a true concurrent interleave cannot slip through.
- **Supplied** — if it does not match the current version, the write is refused
  with `409 version_conflict` carrying the current version and the current
  document, so the caller can merge and retry.

This is affordable because the operations are **incremental**: they merge into
whatever the server currently holds rather than replacing the document. What the
auto-computed path gives up is *positional* precision, not data — an agent whose
`position 3` came from a stale read gets a valid arrangement that may not match
the picture it had. No existing arrangement is destroyed.

The operator's `put_layout` gains the same `version + 1` bump and still checks
nothing: a human saving from the panel always wins.

**D2 — `design_read_layout` reports the layout's own version.**
It currently returns `revision`, which is the *manifest's* max file version
(`agent_views.rs:335` via `manifest.rs:70`) — the wrong number for this purpose.
It gains `version`: the `design_layout` row's version, or `0` when no row exists
yet (so `0` is the base for a project's first-ever arrangement).

**D3 — Name and id uniqueness are per-project.** `validate` operates on one
project's document, and the row is per project, so its `seen_names` set is
per-project by construction. Two projects may each have a "Player" group. Group
ids need only be unique within a project.

**D4 — One route, tagged operation.** `PUT
/api/taskflow/agents/design/layout`, body:

```json
{ "project": 13, "base_version": 7, "op": { "create_group": { "name": "Player" } } }
```

House style already favours single-path PUTs for agent writes (`asset`,
`tokens`). Four operations are edits to one resource, not four resources.

**D5 — The write path starts from the filtered document.** Because `validate`
*rejects* unknown routes while `load_layout` *filters* them, a write that began
from the raw stored row would hard-fail the moment any page had been deleted
since the last save. The write loads via the served view (`filter_to_known`),
so dead routes are pruned as a consequence of any write rather than breaking it.

**D6 — `place_page` materialises the flow.** `route_order` is sparse by design.
Placing a page reliably requires knowing where its neighbours are, so the
operation writes back the *resolved* flow, after which `route_order` names every
page. This is behaviourally invisible — `resolve_route_order` already treats an
unnamed page as appended — and it makes the arrangement explicit rather than
partly implied.

**D7 — A write refuses to overwrite an unparseable row.** Reads degrading to
`default_doc()` is right for a read and catastrophic for a write: it would
persist `default + op`, silently discarding the real arrangement. If a row
exists and fails to parse, the write returns `500` and changes nothing.

**D8 — The write tools take operations, never a document.** `agent_views.rs:264`
carries a warning addressed to whoever builds this: the read response *"is the
panel's view of the arrangement, not the stored document, and the difference is
lossy in both directions"* — group routes are read in flow order while storage
keeps assignment order, `flow` is resolved, and `pages[].name` is a composite.
A tool that PUT that shape back *"would silently reorder every group by the flow
and claim a flow the operator never set."* This design never accepts a document
as input, so the trap cannot be reached: the client sends one operation and the
server reads, merges and writes the stored form itself.

## 5. The write path

Inside `project_locks().with_lock(project_id, …)` — the same lock `put_layout`
and `put_file` take (`views.rs:39`, `store.rs:36`):

1. Load the `design_layout` row. **Exists but unparseable → `500` (D7).**
   Absent → start from `default_doc()`, current version `0`.
2. `filter_to_known(doc, known)` — the served view (D5).
3. If `base_version` was supplied and differs from the row's version →
   `409 version_conflict` with `current_version` and the current document,
   shaped like `conflict_response` (`views.rs:374`).
4. Apply the operation as a pure function (§7).
5. `layout_doc::validate(result, known)` → `400` with the validator's own
   message on failure.
6. Serialise with `to_json_string`; refuse with `400` if it exceeds the column's
   65536.
7. Persist with a conditional UPDATE filtered on `ID.eq(row.id) &
   VERSION.eq(row.version)` setting `version: row.version + 1`; `flipped == 0`
   is a conflict. Create branch sets `version: 1`.

## 6. Tool specifications

All four take `project?`, `profile?`, and `base_version?` (§4 D1).

| Tool | Args | Effect |
|---|---|---|
| `design_create_group` | `name` | Appends `{id, name, routes: []}`; returns the new `group_id` |
| `design_update_group` | `group_id`, `name` | Rename only — membership lives in `reorder_page` |
| `design_reorder_group` | `group_id`, `position` | 1-based move within `doc.groups`, **move not swap** (matches the panel's `moveGroup`) |
| `design_reorder_page` | `route`, `group_id?`, `position?` | `group_id` sets membership, removing the route from any other group; `position` is 1-based **within the resulting section** |

`design_reorder_page` cases: both args → move and place; `group_id` alone →
append to that group's section; `position` alone → reorder inside the section
that already claims it (or ungrouped); neither → `400`.

**Response** — deliberately small, so ten edits cost ten small payloads rather
than ten copies of a 40-page document:

```json
{ "ok": true, "version": 8, "changed": { "groups": ["g…"], "routes": ["/workout"] } }
```

`version` lets an agent chain writes without re-reading; `changed` names what
moved. `design_read_layout` remains the way to see the whole arrangement.

**Group ids** are minted server-side as `g` + 12 base36 chars, checked against
the document's existing ids (per-project uniqueness only, D3), so they read as
the same family as the panel's `g{time36}{seq36}`.

## 7. `layout_doc` operations

Pure functions, no IO, so they unit-test beside the existing cases in
`tests/layout_doc.rs`:

- `create_group(doc, name) -> Result<(LayoutDoc, String), String>`
- `rename_group(doc, group_id, name) -> Result<LayoutDoc, String>`
- `move_group(doc, group_id, position) -> Result<LayoutDoc, String>`
- `place_page(doc, known_routes, route, group_id, position) -> Result<LayoutDoc, String>`

`place_page`'s position resolution: take the resolved flow, drop `route` from it,
list the target section's members in flow order (after the membership change),
then insert so the route lands at 1-based `position` of that list — or after its
last element when `position` is absent or `len + 1`. Translate the anchor back to
a global flow index and write the materialised flow (D6).

## 8. Errors

| Case | Response |
|---|---|
| Supplied `base_version` stale | `409 version_conflict` + current version + current document |
| Unknown `group_id` | `400`, naming the id |
| Duplicate group name | `400`, from `validate` (`:98`, case-insensitive) |
| Blank / >40-char name, >24 groups | `400`, from `validate` |
| Route not in the manifest | `400`, from `validate` |
| `position` outside `1..=len` | `400` naming the valid range — refused, not clamped |
| Serialised document > 65536 | `400` before writing |
| Row exists but is unparseable | `500`, nothing written (D7) |

## 9. Testing

- **`tests/layout_doc.rs`** — pure cases per operation: happy path, bounds,
  duplicate names, unknown route, move-not-swap, position semantics, and the
  **filter-then-validate interaction** (D5) proving a deleted page does not break
  an edit. Plus a `to_json_string` → `parse` round-trip, since a document the
  parser cannot read degrades every project to "unarranged" in silence.
- **`tests/agent_layout_write.rs`** (new, mirroring `agent_layout_read.rs`) —
  `put_as_agent`, field-by-field assertions, and **negative assertions carrying a
  positive control**, that file's established discipline. Includes the 409 on a
  supplied stale version, modelled on `phase1_storage_composer.rs:682`, and a
  cross-project refusal: an agent of project A cannot write project B's layout.
- **`tests/realtime_bulk_bridge.rs`** — an agent write emits exactly one
  `"updated"` on `project:{id}:design_layout`, proving the panel live-updates.
- **`tests/agent_layout_read.rs`** — `the_layout_read_is_not_a_write_surface`
  (`:311`) asserts the layout cannot be written. That becomes false by design; it
  is **rewritten to pin the new boundary** (reads stay GET-only, `PUT` to the
  agent layout path is the only write) rather than deleted.
- **`mcp/src/server.test.ts`** — the four tools registered, descriptions
  asserted, client method calls verified, following the `design_read_layout`
  pattern at `:507`.

## 10. Deployment

The live backend is hosted (`api.taskflow.supercodehive.com`), so the agreed
route is **local first**: run the backend against the local Postgres, create a
scratch design project, drive all four tools end-to-end through the MCP until
they genuinely work, then hand over a deploy. Unit tests alone are not the bar —
the screenshot 503 sat unnoticed precisely because nothing exercised the real
request path.

The MCP is installed globally from `mcp/`; it needs a rebuild and reinstall for
the tools to appear.

## 11. Known limits

- **The operator's save can still clobber an agent's arrangement.**
  `saveLayout` (`design-api.ts:517`) PUTs the whole document from a browser copy
  with no version. Approach A protects an agent from *you*; it does not protect
  *your* panel from itself. Closing that needs the version to reach `v2_fe`,
  which is out of scope.
- **A placement renumbers at most two sections, not one.** Moving a page
  changes the visible position of other pages in the section it LEFT and the
  section it JOINED, because in-section position is derived from the global
  flow — and when the page does not change section those two are the SAME
  section, so there is one. A third section is unaffected — its members'
  relative flow order is untouched — which is the opposite of what a global
  flow first suggests. The `changed.routes` list names every page whose visible
  position moved, so neither case is a surprise.
- **`route_order` becomes total** after any `place_page` (D6).
- **No group deletion**, so an unwanted group must be removed from the panel.

## 12. Follow-on work

- `design_delete_page` — agents can create routes and never remove them.
- Layout version on the operator path, closing §11's first limit.
- `design_delete_group`, guarded by a refusal that names the pages it holds.

## 13. Text that must change with the code

Three places currently assert the opposite of what this spec builds. Leaving any
of them is a contradiction a reader will hit before the code:

- **`mcp/src/server.ts:1052`** — the `design_read_layout` description ends
  *"Read-only: arranging the board is the operator's, and there is no tool that
  writes it."* Both clauses become false. It should point at the four write
  tools instead.
- **`mcp/src/server.test.ts:507`** — asserts that description matches
  `/read-only/i`. That assertion must be replaced, not merely loosened.
- **`backend/plugins/taskflow-design/src/urls.rs:91`** — the comment *"The layout
  is READ-ONLY here on purpose: an agent can see how the pages are grouped and
  ordered, and cannot rearrange someone's board"* needs to describe the new
  boundary: `GET` stays, `PUT` is now the single op-tagged write route.
- **`agent_views.rs:254`** — the `read_layout` doc comment's rationale ("READ
  ONLY, deliberately… the write has a contract change to make first") is
  discharged by D1; the D8 warning below it stays, since it still binds whoever
  edits that read.
