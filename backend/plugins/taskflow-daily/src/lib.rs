//! TaskflowDailyPlugin — the daily update (#1118, v3 group 6).
//!
//! A sweep drafts each enabled project's update at its local time (facts only,
//! never posted); the drafting agent may improve it; an owner or admin edits
//! and posts it to a project-wide room as themselves.

pub mod models;
pub mod service;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowDailyPlugin;

impl Plugin for TaskflowDailyPlugin {
    fn name(&self) -> &'static str {
        "taskflow_daily"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_tasks", "taskflow_agents", "taskflow_decisions", "taskflow_usage"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowDailyUpdateSettings>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowDailyUpdate>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        service::start_sweep();
        Ok(())
    }
}
