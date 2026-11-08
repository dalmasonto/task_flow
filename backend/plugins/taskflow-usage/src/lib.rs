//! TaskflowUsagePlugin — self-reported usage and cost (#1115, #886 §3.11).
//!
//!   models.rs   — prices, reports, settings, fired alerts
//!   service.rs  — ingest, pricing, aggregates, budget, alerts
//!   views.rs / urls.rs — HTTP
//!
//! Its tables must be listed read-only in `backend/src/rest.rs`.

pub mod models;
pub mod service;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowUsagePlugin;

impl Plugin for TaskflowUsagePlugin {
    fn name(&self) -> &'static str {
        "taskflow_usage"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_tasks", "taskflow_agents", "taskflow_decisions"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowModelPrice>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowUsageReport>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowUsageSettings>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowUsageAlert>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        // Seed the cited default prices (idempotent; never overwrites an edit).
        // Off the boot path: before `migrate` the table does not exist, and the
        // seed simply finds nothing to write until the next start.
        tokio::spawn(service::seed_prices());
        Ok(())
    }
}
