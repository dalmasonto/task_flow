//! TaskflowProjectsPlugin - project workspaces, members, invites, and API bases.
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
//! .plugin(taskflow_projects::TaskflowProjectsPlugin::default())
//! ```
//!
//! See `documentation/docs/v0.0.1/plugins/the-plugin-trait.mdx` for
//! what each `Plugin` method does. This layout is a recommended
//! convention — the framework only needs a type that impls `Plugin`.

pub mod models;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowProjectsPlugin;

impl Plugin for TaskflowProjectsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_projects"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowProject>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowProjectMember>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowProjectInvite>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowProjectApiEndpoint>(),
        ]
    }

    fn routes(&self) -> Router {
        // Routes live in `urls.rs` (this app's URL conf), one place to
        // see every path the plugin serves.
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        Ok(())
    }
}
