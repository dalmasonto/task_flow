//! TaskflowDesignPlugin — the Design Surface backend.
//!
//! An agent-editable UI canvas per project: pages are composed from a shared
//! component registry and one token file, rendered live in an origin-isolated
//! sandbox frame, and every write (agent or operator) passes the same
//! validator. The constraint layer is the product: inconsistency is a rejected
//! write, not a plausible output.
//!
//! A plugin split one file per concern, matching the other taskflow plugins:
//!
//!   src/
//!     lib.rs        — the `Plugin` impl: glues models + routes (this file)
//!     models.rs     — `design_file` + `design_comment` rows
//!     validation.rs — §6.3 write validator (paths, fragments, components, tokens)
//!     store.rs      — caps, per-project write locks, optimistic versioning
//!     manifest.rs   — derived manifest + usedOn blast-radius computation
//!     composer.rs   — the HTML shell composer + system-owned picker runtime
//!     sandbox.rs    — HMAC read tokens for the sandbox origin
//!     views.rs      — chrome-facing + sandbox-facing handlers
//!     urls.rs       — the route table
//!
//! Wire into `backend/src/main.rs`:
//!
//! ```ignore
//! .plugin(taskflow_design::TaskflowDesignPlugin::default())
//! ```

pub mod agent_views;
pub mod composer;
pub mod dispatch;
pub mod manifest;
pub mod models;
pub mod sandbox;
pub mod screenshots;
pub mod store;
pub mod urls;
pub mod validation;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowDesignPlugin;

impl Plugin for TaskflowDesignPlugin {
    fn name(&self) -> &'static str {
        "taskflow_design"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        // Auth for the chrome-facing extractors; projects for the
        // TaskflowProject FK and the membership scope helpers.
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::DesignFile>(),
            umbral::migrate::ModelMeta::for_::<models::DesignComment>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        Ok(())
    }
}
