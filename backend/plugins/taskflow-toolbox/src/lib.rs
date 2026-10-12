//! TaskflowToolboxPlugin — #617: a project's shared memories and reusable
//! scripts, listed at connect and loaded on demand.
//!
//! The plugin owns the DATA and the two engines that guard it: the secret
//! scan (a save carrying a credential is refused) and the identifier
//! redaction (IPs, emails and phones are replaced, and the save reports what
//! it replaced). It never runs a script — execution is always local, and the
//! MCP installs vetted scripts into the agent's own checkout.
//!
//! Access is the same rule the rest of the app uses: a caller must be an
//! active member of the project. Approving an entry — the human gate the
//! design asks for — is the one action an agent may not take.

pub mod models;
pub mod redact;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowToolboxPlugin;

impl Plugin for TaskflowToolboxPlugin {
    fn name(&self) -> &'static str {
        "taskflow_toolbox"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::ToolboxEntry>(),
            umbral::migrate::ModelMeta::for_::<models::ToolboxEntryVersion>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        Ok(())
    }
}
