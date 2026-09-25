//! The durable "one room per marker per project" guard.
//!
//! This lives in its own test binary because the test REMOVES the two partial
//! unique indexes to prove the plugin's `on_ready` puts them back — and while
//! they are gone, a database that refuses a second marked room stops refusing
//! one. In a shared process that would fail its neighbours' assertions for
//! reasons that have nothing to do with them. Test binaries are separate
//! processes with separate databases, so the window stays private to this file.

mod support;

use support::{TestApp, seed_project_via_transaction};
use taskflow_agents::models::{TaskflowAgentChannel, TaskflowChannelKind, taskflow_agent_channel};
use taskflow_agents::signals::backfill_project_rooms;
use umbral::orm::ForeignKey;

// The guard is installed by the PLUGIN'S `on_ready`, not only by this test
// harness. That is not automatic: `boot` fires `on_ready` before it creates the
// schema, so the install that matters is the deferred one in
// `TaskflowAgentsPlugin::on_ready` — and the harness compensates for the boot
// order by installing the guard itself. Without this test, deleting the
// `on_ready` call would break production and no test would notice.
//
// The arrange drops the indexes first, so the test shows BOTH halves: the
// refusal disappears when the guard is absent, and returns when `on_ready` runs.
#[tokio::test]
async fn the_plugin_on_ready_installs_the_marker_guard() {
    use umbral::plugin::Plugin;

    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    backfill_project_rooms().await;

    let pool = umbral::db::pool_dispatched();
    for index in [
        "taskflow_agent_channel_one_public_per_project",
        "taskflow_agent_channel_one_design_per_project",
    ] {
        let sql = format!("DROP INDEX IF EXISTS {index}");
        let dropped: Result<(), sqlx::Error> = match &pool {
            umbral::db::DbPool::Sqlite(p) => sqlx::query(&sql).execute(p).await.map(|_| ()),
            umbral::db::DbPool::Postgres(p) => sqlx::query(&sql).execute(p).await.map(|_| ()),
        };
        dropped.expect("drop the guard");
    }

    let duplicate_public = || {
        let project = project;
        async move {
            TaskflowAgentChannel::objects()
                .create(TaskflowAgentChannel {
                    id: 0,
                    project: ForeignKey::new(project),
                    title: "Another one".to_string(),
                    topic: None,
                    kind: TaskflowChannelKind::Project,
                    task: None,
                    created_by_user: None,
                    created_by_agent: None,
                    archived: false,
                    is_public: true,
                    is_design: false,
                    created_at: None,
                })
                .await
        }
    };

    // With the guard gone, the database accepts a second public room.
    assert!(
        duplicate_public().await.is_ok(),
        "the arrange must really have removed the guard, or this test proves nothing"
    );
    // Clean up after the arrange's deliberate duplicate so the rest is honest.
    TaskflowAgentChannel::objects()
        .filter(
            taskflow_agent_channel::PROJECT.eq(project)
                & taskflow_agent_channel::TITLE.eq("Another one"),
        )
        .delete()
        .await
        .expect("remove the duplicate");

    // The plugin's own `on_ready` — the production path, with only the pool it
    // is given — puts the guard back.
    let ctx = umbral::plugin::AppContext {
        pool: pool.clone(),
        settings: umbral::Settings::from_env().expect("settings"),
    };
    taskflow_agents::TaskflowAgentsPlugin
        .on_ready(&ctx)
        .expect("on_ready");

    assert!(
        duplicate_public().await.is_err(),
        "after on_ready runs, a second public room is refused again"
    );}
