//! Realtime bridge for the design tables' BULK writes.
//!
//! ## Why this exists
//!
//! `backend/src/realtime.rs` exposes `DesignFile` and `DesignLayout` through
//! `Expose`, which subscribes to the ORM's PER-ROW `post_save:<table>` signal.
//! But each of those two tables has a second write path that never fires it:
//!
//! - `Manager::save` and a queryset `create` — the first write of a page, the
//!   first save of an arrangement, every comment edit — fire
//!   `post_save:<table>` with the full `instance`, so `Expose` already covers
//!   them.
//! - a queryset `update_values` — `store::write_file`'s update branch (every
//!   edit of an EXISTING page) and `put_layout`'s update branch (every
//!   RE-arrangement of an existing document) — fires
//!   `bulk_post_save:<table>` ONLY, carrying `{ids, created}` and no instance.
//!   `Expose` never sees it, so the change is silent.
//!
//! The visible bug: a second viewer keeps a stale canvas until they reload,
//! and the page that made the edit never learns it happened. It is the same
//! trap `taskflow_tasks::session_timer` bridges for tasks — see its module
//! docs for the two-signal reasoning.
//!
//! ## Scope: BOTH save signals, one payload builder
//!
//! #665 merged what used to be two emitters. `backend/src/realtime.rs` exposed
//! `DesignFile` through `Expose`, which subscribes to the per-row
//! `post_save:<table>` signal; this module subscribed to the bulk one. Two
//! emitters meant two payload definitions, and widening the payload (to carry
//! `affected_routes`) would have meant widening both and keeping them in step
//! forever. Now BOTH signals land here:
//!
//! - `post_save:design_file` — a `Manager::save` or a queryset `create`: the
//!   first write of a page, and any per-row update. Subscribed HERE, not by the
//!   backend's realtime plugin: a registration there as well broadcast every
//!   create twice (both subscriptions fire for one write), so the backend
//!   deliberately registers nothing for `DesignFile` — see the comment where
//!   that registration used to be, in `backend/src/realtime.rs`.
//! - `bulk_post_save:design_file` — a queryset `update_values`:
//!   `store::write_file`'s update branch, i.e. every edit of an EXISTING page,
//!   which fires `bulk_post_save` ONLY (carrying `{ids, created}` and no
//!   instance).
//!
//! Both funnel into [`emit_file`], so there is exactly one payload shape.
//!
//! ## What it emits
//!
//! Every page-file event carries `{id, version, path, affected_routes}`:
//!
//! - `affected_routes` names the routes whose rendered output changed, so the
//!   canvas remounts only those boards instead of the whole epoch. An EMPTY
//!   list is authoritative ("nothing renders this file" — e.g. a component
//!   delete that was allowed only because no page used it); ABSENT or null
//!   would mean "scope unknown, remount everything", which is what a client
//!   meeting a design-file event without the field must do.
//! - `version` is the row's version AFTER the write, for cache keys client-side.
//!
//! The payload is still small (a page write names one route); a token write
//! names every route, which is exactly the truth: tokens feed every document.
//!
//! ## Deletes: neither half, and neither could
//!
//! This module deliberately does NOT subscribe to any delete signal, and that
//! is not the same claim it used to make ("no design row is ever deleted"). A
//! `design_file` row IS deleted now — `agent_views::delete_component` retires a
//! component, and `store::trash_file` soft-deletes a page — and the ORM's
//! delete payloads cannot route:
//!
//! - The per-row `post_delete` **does** fire (`QuerySet::delete` emits it,
//!   `umbral-core/src/orm/queryset/mod.rs`), but with the primary key alone —
//!   `{ "instance": { "id": N } }` — because the row is gone by then.
//! - `bulk_post_delete` carries `{ "ids": [...] }` and no instance at all, and
//!   a soft delete fires ONLY this one (the soft path is an UPDATE that emits
//!   no `bulk_post_save`: `soft_delete_update`).
//!
//! So neither could resolve a project from the payload. Deletes are served by
//! the WRITER instead — `views::trash_page_by_route` and
//! `agent_views::delete_component` call [`emit_file_event`] themselves, where
//! the project id is in hand and cannot be lost in a payload — and the backend
//! registration drops `ModelAction::Deleted` so a misrouted event is never
//! sent. See that registration's comment for the frontend handler a misroute
//! would have triggered.

use serde_json::json;
use umbral_realtime::Realtime;

use crate::models::{DesignFile, DesignLayout, design_file, design_layout};

/// Group suffixes. The `DESIGN_FILES` / `DESIGN_LAYOUT` constants in
/// `backend/src/realtime.rs` are the source of truth for these strings, and
/// they must stay byte-identical to the names in
/// `v2_fe/src/lib/taskflow-api.ts`. This crate cannot import the backend's
/// constants (the backend binary depends on this plugin, not the reverse), so
/// they are mirrored here — once per suffix, shared by this module and the SSE
/// handler in `views.rs` so the two can never drift apart.
const FILES_SUFFIX: &str = "design_files";
const LAYOUT_SUFFIX: &str = "design_layout";

/// The realtime group a page file's events belong on.
pub fn files_group(project_id: i64) -> String {
    format!("project:{project_id}:{FILES_SUFFIX}")
}

/// The realtime group the shared arrangement's events belong on.
pub fn layout_group(project_id: i64) -> String {
    format!("project:{project_id}:{LAYOUT_SUFFIX}")
}

/// Register the bulk-write bridge. Called once from
/// [`TaskflowDesignPlugin::on_ready`](crate::TaskflowDesignPlugin).
pub fn subscribe() {
    // The signal registry is process-global, so a second `on_ready` in one
    // process (every test binary boots the app more than once) must not stack a
    // second copy of these handlers — that would broadcast every bulk write
    // twice.
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Page files, per-row path: `Manager::save` and queryset `create` —
        // the first write of a page.
        umbral::signals::subscribe_async("post_save:design_file", |payload| {
            let id = payload["instance"]["id"].as_i64();
            let created = created_from(payload);
            async move {
                if let Some(id) = id {
                    emit_file(id, created).await;
                }
            }
        });

        // Page files, bulk path: `store::write_file` edits an existing row via
        // `update_values`.
        umbral::signals::subscribe_async("bulk_post_save:design_file", |payload| {
            let ids = ids_from(payload);
            let created = created_from(payload);
            async move {
                for id in ids {
                    emit_file(id, created).await;
                }
            }
        });

        // The shared arrangement: `views::put_layout` replaces an existing
        // document via `update_values`.
        umbral::signals::subscribe_async("bulk_post_save:design_layout", |payload| {
            let ids = ids_from(payload);
            let created = created_from(payload);
            async move {
                for id in ids {
                    emit_layout(id, created).await;
                }
            }
        });
    });
}

/// The affected primary keys from a `bulk_post_save` payload (`{ids, created}`,
/// with no `instance` — contrast the per-row `post_save`).
fn ids_from(payload: &serde_json::Value) -> Vec<i64> {
    payload["ids"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default()
}

/// Whether the bulk write was an INSERT (`bulk_create`) rather than an UPDATE.
/// Mapped to the wire name the same way `Expose` maps it, so both paths emit
/// the same event name for the same write.
fn created_from(payload: &serde_json::Value) -> bool {
    payload["created"].as_bool().unwrap_or(false)
}

fn action_name(created: bool) -> &'static str {
    if created {
        "created"
    } else {
        "updated"
    }
}

/// Broadcast one page-file event for a row that still exists. The row is
/// re-read by id — the bulk payload carries no instance, and the signal fires
/// after the write commits — which also resolves the `project` FK the group is
/// keyed on. One re-read per write, bounded by `validation::MAX_FILE_BYTES`
/// (128 KB); a row that is gone by now (or unreadable) is skipped rather than
/// guessed at.
pub async fn emit_file(id: i64, created: bool) {
    let Ok(row) = DesignFile::objects().get(design_file::ID.eq(id)).await else {
        return;
    };
    // The manifest build is only needed for token/component writes — see
    // `views::affected_routes_for`, whose page fast path is pure.
    let affected = crate::views::affected_routes_for(&row.path, row.project.id()).await;
    emit_file_event(
        row.project.id(),
        action_name(created),
        row.id,
        &row.path,
        row.version,
        affected,
    )
    .await;
}

/// Broadcast one design-file event from explicit values — for writers that
/// hold the project id directly and whose row may already be gone (a trash, a
/// component delete), or whose update signal is not one this module bridges
/// (restores are plain `update_values`, so `emit_file` covers them; a trash is
/// a soft delete, which fires only `bulk_post_delete`).
///
/// `action` is the wire event name: `"created" | "updated" | "deleted"`.
pub async fn emit_file_event(
    project_id: i64,
    action: &str,
    id: i64,
    path: &str,
    version: i64,
    affected_routes: Vec<String>,
) {
    Realtime::to_group(files_group(project_id))
        .send(
            action,
            &json!({
                "id": id,
                "version": version,
                "path": path,
                "affected_routes": affected_routes,
            }),
        )
        .await;
}

/// Broadcast one id-only arrangement event. See [`emit_file`].
async fn emit_layout(id: i64, created: bool) {
    let Ok(row) = DesignLayout::objects()
        .get(design_layout::ID.eq(id))
        .await
    else {
        return;
    };
    Realtime::to_group(layout_group(row.project.id()))
        .send(action_name(created), &json!({ "id": row.id }))
        .await;
}
