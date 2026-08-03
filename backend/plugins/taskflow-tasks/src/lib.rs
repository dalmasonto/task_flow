//! TaskflowTasksPlugin - tasks, Kanban state, sessions, and activity.
//!
//! A plugin split one file per concern:
//!
//!   src/
//!     lib.rs     — the `Plugin` impl: glues models + routes together (this file)
//!     models.rs  — `#[derive(Model)]` structs (this app's tables)
//!     views.rs   — HTTP handlers
//!     urls.rs    — the URL conf: maps paths to `views::` handlers
//!
//! Wire this into your App by adding to `src/main.rs`:
//!
//! ```ignore
//! .plugin(taskflow_tasks::TaskflowTasksPlugin::default())
//! ```
//!
//! See `documentation/docs/v0.0.1/plugins/the-plugin-trait.mdx` for
//! what each `Plugin` method does. This layout is a recommended
//! convention — the framework only needs a type that impls `Plugin`.

pub mod models;
pub mod session_timer;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError, block_on_ready};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowTasksPlugin;

impl Plugin for TaskflowTasksPlugin {
    fn name(&self) -> &'static str {
        "taskflow_tasks"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowTask>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskRelation>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskActivity>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskSession>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskAttachment>(),
        ]
    }

    fn routes(&self) -> Router {
        // Routes live in `urls.rs` (this app's URL conf), one place to
        // see every path the plugin serves.
        urls::router()
    }

    fn on_ready(&self, ctx: &AppContext) -> Result<(), PluginError> {
        // Install the database-side invariant before serving task writes: one
        // still-open focused-work session per task. The reconciler lock handles
        // process-local signal races; the partial unique index is the durable
        // cross-client/backing-store guard.
        block_on_ready(session_timer::install_open_session_guard(&ctx.pool))?;

        // The system owns the task work-timer: opening a session when a task
        // enters in_progress and closing it when it leaves, on every write path.
        session_timer::register();

        // Seed closed_at for tasks that were already terminal before the column
        // existed, using updated_at as a best-effort close time. Idempotent: only
        // rows with a terminal status AND a null closed_at are touched, so every
        // boot after the first finds none.
        tokio::spawn(async move {
            use models::{TaskflowTask, TaskflowTaskStatus};

            let rows = match TaskflowTask::objects().fetch().await {
                Ok(r) => r,
                Err(_) => return,
            };
            for mut task in rows {
                let terminal = matches!(
                    task.status,
                    TaskflowTaskStatus::Done | TaskflowTaskStatus::Archived
                );
                if terminal && task.closed_at.is_none() {
                    if let Some(ts) = task.updated_at {
                        task.closed_at = Some(ts);
                        let _ = TaskflowTask::objects().save(task).await;
                    }
                    // else: leave closed_at null and do NOT save — a no-op save
                    // would re-fire post_save -> reconcile -> stamp Utc::now(),
                    // fabricating a close time for an un-dated historical row.
                }
            }
        });

        Ok(())
    }
}
