//! TaskflowAgentsPlugin - agent identity, sessions, group chat, and terminal log.
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
//! .plugin(taskflow_agents::TaskflowAgentsPlugin::default())
//! ```
//!
//! See `documentation/docs/v0.0.1/plugins/the-plugin-trait.mdx` for
//! what each `Plugin` method does. This layout is a recommended
//! convention — the framework only needs a type that impls `Plugin`.

pub mod agent_auth;
pub mod models;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowAgentsPlugin;

impl Plugin for TaskflowAgentsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_agents"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_tasks"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgent>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentCredential>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentSession>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentChannel>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentChannelMember>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentMessage>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowMessageAttachment>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowChannelReadCursor>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentTerminalFrame>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskReview>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentPrompt>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTerminalInput>(),
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
