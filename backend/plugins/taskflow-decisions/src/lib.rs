//! TaskflowDecisionsPlugin — decisions as first-class objects (#1094, #886 §3.1).
//!
//!   src/
//!     lib.rs      — the `Plugin` impl (this file)
//!     models.rs   — decision, option, task link, comment
//!     service.rs  — every rule, shared by both surfaces
//!     views.rs    — HTTP handlers (human + agent)
//!     urls.rs     — the URL conf
//!
//! Wire into the App in `src/main.rs`:
//!
//! ```ignore
//! .plugin(taskflow_decisions::TaskflowDecisionsPlugin::default())
//! ```
//!
//! Its four tables must also be listed read-only in `backend/src/rest.rs`
//! (deny-by-default auto-REST) and exposed in `backend/src/realtime.rs`.

pub mod models;
pub mod service;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowDecisionsPlugin;

impl Plugin for TaskflowDecisionsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_decisions"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_tasks", "taskflow_agents"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowDecision>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowDecisionOption>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowDecisionTask>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowDecisionComment>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        // #1113: wake-up rules ("task unblocked") live in taskflow-agents, which
        // cannot depend on this crate. Tell it how to ask "is this task still
        // blocked by an open decision?".
        taskflow_agents::wakeups::register_decision_blocked_check(Box::new(|task| {
            Box::pin(async move { service::has_open_decision(task).await })
        }));
        Ok(())
    }
}
