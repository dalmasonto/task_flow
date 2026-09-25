//! Make sure every project has its two rooms — the public room and the design
//! room — however its project row was written.
//!
//! ## Why a signal
//!
//! The rooms belong to `taskflow-agents`, but a project is created by
//! `taskflow-projects` — which `taskflow-agents` already depends on, so the
//! project code calling the channel code would be a dependency cycle. A signal
//! is the way to run channel work at project-write time without inverting the
//! crate graph, and it is the pattern already used in this repo
//! (`taskflow-design/src/signals.rs`, `taskflow-tasks/src/session_timer.rs`).
//!
//! ## Why TWO signals — and the honest limit
//!
//! The ORM emits different signals on different write paths, and a subscriber to
//! one of them misses the others (the recorded trap this module exists to
//! respect):
//!
//! - `post_save:taskflow_project` — `Manager::save`, `QuerySet::create`, and
//!   umbral-rest/admin's `insert_json` (which fires it after commit).
//! - `bulk_post_save:taskflow_project` — a queryset `update_values`, i.e. what
//!   umbral-rest's dashboard PATCH runs (payload is `{ids, created}`, no
//!   instance, hence the different extraction).
//!
//! What is NOT covered, verified rather than assumed: `create_project` — this
//! app's own `POST /api/taskflow/projects` — writes through
//! `QuerySetTx::create` (`..on_tx(tx).create(..)`, so the project and its owner
//! membership land in one transaction) and the ORM emits **no signal at all** on
//! that terminal (`vendor/umbral-core/src/orm/queryset/tx.rs`). So the
//! same-transaction creation the plan's user asked for cannot be delivered by a
//! subscriber: for that path the rooms come from the next layer, which is the
//! backfill at boot, the `link_agent` call, or the first `create_channel`.
//! Subscribing here is still worth it — it makes every OTHER project write
//! self-heal a missing room, including an admin/dashboard edit — and the
//! invariant does not rest on it: **idempotence plus the backfill are what make
//! the outcome the same** whether or not the signal fires.
//!
//! Because a signal subscriber runs inline on the ORM write path (with a hard
//! timeout in `umbral_core::signals`), the work here is deliberately small: two
//! lookups when the rooms already exist, and the creates once per project.
//!
//! ## The backfill
//!
//! [`backfill_project_rooms`] walks every project and calls the same idempotent
//! `ensure_project_rooms`. That is what gives rooms to projects that predate
//! this feature, and what gives `is_public = true` to project rooms that were
//! created before the marker column existed (those rows carry BOTH markers
//! false, which is exactly the ambiguity the markers remove — see
//! `views::ensure_project_rooms`).

use std::sync::Once;

use taskflow_projects::models::TaskflowProject;
use umbral::db::DbPool;

use crate::views::{ensure_project_rooms, find_design_room, find_public_room};

/// The durable form of "one public room and one design room per project".
///
/// `ensure_project_rooms` is get-or-create, and two callers racing — the boot
/// backfill against a live project write, or two requests at once — can both
/// find nothing and both create. That would leave a project with two rooms
/// claiming the same marker, which is exactly the ambiguity the markers exist to
/// remove: the finders deliberately have no ordering, so a second marked room
/// makes "the" room arbitrary again.
///
/// Partial unique indexes are the guard, the same shape `taskflow-tasks` installs
/// for its one-open-session-per-task invariant (`session_timer`). The ORM cannot
/// express a partial index (`AddIndex` in the migration JSON is `{table,
/// columns, unique}` with no predicate), but both supported backends accept this
/// syntax verbatim — and a `RunSql` migration CAN carry it, so the guard ships in
/// migration `0022_add_taskflow_agent_channel_marker_guard_indexes` as the
/// durable, `migrate`-time form. The loser of a race takes the unique violation,
/// and `views::ensure_project_rooms` recovers by re-reading the winner's room.
pub const ONE_PUBLIC_PER_PROJECT_INDEX: &str = "taskflow_agent_channel_one_public_per_project";
pub const ONE_PUBLIC_PER_PROJECT_SQL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS taskflow_agent_channel_one_public_per_project ON taskflow_agent_channel (project) WHERE is_public";
pub const ONE_DESIGN_PER_PROJECT_INDEX: &str = "taskflow_agent_channel_one_design_per_project";
pub const ONE_DESIGN_PER_PROJECT_SQL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS taskflow_agent_channel_one_design_per_project ON taskflow_agent_channel (project) WHERE is_design";
/// The two statements as a pair, for the tests that check this module's names
/// against the `RunSql` migration that carries the same guard.
pub const MARKER_GUARD_STATEMENTS: [(&str, &str); 2] = [
    (ONE_PUBLIC_PER_PROJECT_INDEX, ONE_PUBLIC_PER_PROJECT_SQL),
    (ONE_DESIGN_PER_PROJECT_INDEX, ONE_DESIGN_PER_PROJECT_SQL),
];

/// Install the marker guard. Called once from
/// [`TaskflowAgentsPlugin::on_ready`](crate::TaskflowAgentsPlugin) BEFORE the
/// backfill is spawned, so nothing can create a duplicate marker while it runs.
///
/// ## Why this exists next to the `RunSql` migration that already creates them
///
/// Migration `0022_add_taskflow_agent_channel_marker_guard_indexes` is the
/// durable form: a real `migrate` creates both indexes, so a database that has
/// been migrated is guarded whether or not this process ever runs `on_ready`
/// against a schema. This call is what makes the guard true in the places a
/// migration cannot reach:
///
///  * **Tests build their schema from the models** (`umbral::testing::boot` →
///    `create_tables_for_tests`), which is a fresh CREATE TABLE from the registry
///    and never runs a migration file — so without this the constraint the
///    design-room tests assert would not exist in any test. The test harness
///    calls this again after the schema exists, for the same reason it re-installs
///    the task-session guard.
///  * **A process booted against an un-migrated database** would otherwise be
///    unguarded until the next restart. It still is (`on_ready` runs before the
///    schema exists there, so this defers), but the migration means the next
///    `migrate` fixes it rather than only a code path.
///
/// Both statements are `IF NOT EXISTS`, so running them over a migrated database
/// is a no-op. The columns are brand new when this first runs on such a database,
/// so no existing row can violate either index.
pub async fn install_room_marker_guard(pool: &DbPool) -> Result<(), sqlx::Error> {
    for (index, sql) in MARKER_GUARD_STATEMENTS {
        let result: Result<(), sqlx::Error> = match pool {
            DbPool::Sqlite(pool) => sqlx::query(sql).execute(pool).await.map(|_| ()),
            DbPool::Postgres(pool) => sqlx::query(sql).execute(pool).await.map(|_| ()),
        };
        if let Err(err) = result {
            // `on_ready` can run before the schema exists (a bare `migrate` in
            // the migration path), where there is nothing to guard yet.
            if is_missing_channel_table(&err) {
                tracing::debug!(index, "room marker guard deferred until the schema exists");
                return Ok(());
            }
            return Err(err);
        }
    }
    tracing::info!("room marker guard installed");
    Ok(())
}

fn is_missing_channel_table(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db) = err else {
        return false;
    };
    let message = db.message();
    // SQLite qualifies the schema in some statements ("no such table:
    // main.<table>", which is what a CREATE INDEX on a missing table reports),
    // so match on both halves rather than on one exact string.
    (message.contains("no such table") && message.contains("taskflow_agent_channel"))
        || message.contains("relation \"taskflow_agent_channel\" does not exist")
}

/// Register the project-write bridge. Called once from
/// [`TaskflowAgentsPlugin::on_ready`](crate::TaskflowAgentsPlugin).
pub fn subscribe() {
    // The signal registry is process-global, so a second `on_ready` in one
    // process must not stack a second copy of these handlers — that would run
    // the ensure twice per project write for nothing.
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Per-row path: `Manager::save` / `QuerySet::create` / dynamic insert.
        // The payload carries the whole row under `instance`.
        umbral::signals::subscribe_async("post_save:taskflow_project", |payload| {
            let id = payload["instance"]["id"].as_i64();
            async move {
                if let Some(id) = id {
                    ensure_rooms_for(id).await;
                }
            }
        });

        // Bulk path: a queryset `update_values` (the dashboard PATCH). Ids only.
        umbral::signals::subscribe_async("bulk_post_save:taskflow_project", |payload| {
            let ids: Vec<i64> = payload["ids"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            async move {
                for id in ids {
                    ensure_rooms_for(id).await;
                }
            }
        });
    });
}

/// Ensure one project's two rooms, logging (never propagating) a failure.
///
/// A signal subscriber returns `()`, so there is nothing to propagate to; the
/// report is the log line. It is not a swallow-everything guard either: the
/// caller's write has already committed and must not be failed by room
/// bookkeeping, and the next layer (a later write, the boot backfill, a link)
/// retries the same idempotent call.
async fn ensure_rooms_for(project_id: i64) {
    if let Err(status) = ensure_project_rooms(project_id).await {
        tracing::warn!(
            project = project_id,
            status = status.as_u16(),
            "could not ensure the project's rooms after a project write; the backfill or a later write will retry"
        );
    }
}

/// Give every project that is missing one its two rooms, and mark the project
/// rooms that predate the `is_public` column.
///
/// Idempotent by construction — it is the same `ensure_project_rooms` the write
/// path calls — so running it on every boot is safe and cheap: a project that
/// already has both marked rooms costs two lookups.
///
/// Returns how many projects it had to repair (a project missing either room,
/// including one whose only room was an unmarked legacy project room), which is
/// what the boot log reports.
///
/// One project failing to repair does not abort the sweep: the rest of the
/// projects still get their rooms, and the failed one is retried on the next
/// call.
pub async fn backfill_project_rooms() -> u64 {
    let projects = match TaskflowProject::objects().fetch().await {
        Ok(projects) => projects,
        Err(err) => {
            tracing::warn!(error = %err, "room backfill could not list projects; skipping");
            return 0;
        }
    };

    let mut repaired = 0u64;
    for project in projects {
        let id = project.id;
        let complete = match (find_public_room(id).await, find_design_room(id).await) {
            (Ok(public), Ok(design)) => public.is_some() && design.is_some(),
            // A lookup failure is not evidence of a complete project, but the
            // ensure below is the thing that decides; treat it as "not known to
            // be complete" so the count can only over-report, never hide work.
            _ => false,
        };
        match ensure_project_rooms(id).await {
            Ok(_) => {
                if !complete {
                    repaired += 1;
                }
            }
            Err(status) => tracing::warn!(
                project = id,
                status = status.as_u16(),
                "room backfill could not repair this project; the next write or boot will retry"
            ),
        }
    }

    if repaired > 0 {
        tracing::info!(
            projects = repaired,
            "room backfill: gave projects their missing rooms"
        );
    }
    repaired
}

/// The boot sweep, run at most once per process and awaitable.
///
/// `on_ready` spawns [`backfill_once`] so a boot does not wait on a full table
/// walk, and the test harness awaits the same cell before it creates projects of
/// its own. That second caller is why this exists rather than a bare `spawn`: a
/// project created in the first moments after boot could otherwise be swept by
/// the walk WHILE the caller arranges its rooms, which is a race with no
/// meaning outside a test (in production both sides do the same idempotent
/// work), but a flaky one inside one.
pub async fn backfill_once() -> u64 {
    *BACKFILL.get_or_init(backfill_project_rooms).await
}

/// Backing cell for [`backfill_once`]. `OnceCell`'s `get_or_init` is what makes
/// concurrent callers share ONE sweep instead of racing two.
static BACKFILL: tokio::sync::OnceCell<u64> = tokio::sync::OnceCell::const_new();
