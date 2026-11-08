//! TaskflowInboxPlugin — what needs a person, in one feed (#1116).
//!
//! Gathers existing rows (prompts, decisions, message questions, mentions);
//! its one table is the per-person read cursor, which is not on auto-REST.

pub mod models;
pub mod service;
pub mod urls;
pub mod views;

use umbral::plugin::Plugin;
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowInboxPlugin;

impl Plugin for TaskflowInboxPlugin {
    fn name(&self) -> &'static str {
        "taskflow_inbox"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_agents", "taskflow_decisions", "taskflow_daily"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![umbral::migrate::ModelMeta::for_::<models::TaskflowInboxCursor>()]
    }

    fn routes(&self) -> Router {
        urls::router()
    }
}
