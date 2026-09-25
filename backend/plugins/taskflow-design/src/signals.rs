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
//! ## Scope: the BULK signal only
//!
//! The per-row `post_save` half is already covered by the `Expose`
//! registrations in `backend/src/realtime.rs`; subscribing to it here as well
//! would broadcast every per-row write twice. Comments (`design_comment`) are
//! written with `Manager::save` only, so they need no bridge at all — and no
//! design row is ever deleted (only a project cascade removes them), so there
//! is no `bulk_post_delete` half to cover either.
//!
//! ## What it emits
//!
//! Indistinguishable from `Expose`'s own output, so the client's existing
//! handlers work unchanged: the same `project:{id}:{suffix}` group, the same
//! `created` / `updated` event name, an ID-ONLY payload, and the same
//! `Realtime::to_group(..).send(..)` call `Expose` itself makes. Design rows
//! are id-only by contract — the chrome refetches the file and recomputes the
//! manifest over REST, and refetches the arrangement — so nothing richer is
//! projected here.

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
        // Page files: `store::write_file` edits an existing row via
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

/// Broadcast one id-only page-file event. The row is re-read by id — the bulk
/// payload carries no instance, and the signal fires after the write commits —
/// which also resolves the `project` FK the group is keyed on. One re-read per
/// edited page, bounded by `validation::MAX_FILE_BYTES` (128 KB); a row that is
/// gone by now (or unreadable) is skipped rather than guessed at.
async fn emit_file(id: i64, created: bool) {
    let Ok(row) = DesignFile::objects().get(design_file::ID.eq(id)).await else {
        return;
    };
    Realtime::to_group(files_group(row.project.id()))
        .send(action_name(created), &json!({ "id": row.id }))
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
