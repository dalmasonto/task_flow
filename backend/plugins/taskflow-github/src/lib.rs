//! TaskflowGithubPlugin — GitHub linking, publish-as-issue, comment-as-actor.
//!
//! Layout mirrors the other taskflow plugins:
//!   src/
//!     lib.rs     — the `Plugin` impl (this file)
//!     models.rs  — `TaskflowGithubPref`
//!     api.rs     — the `GithubApi` boundary (trait + fake + real reqwest impl)
//!     tokens.rs  — key-selection logic (owner vs actor)
//!     views.rs   — HTTP handlers
//!     urls.rs    — route table
//!     adapters.rs — real reqwest / umbral-oauth impls (wired in Task 8)
//!
//! All GitHub/OAuth access sits behind the `api`/`tokens` traits, so the
//! handlers are testable against in-memory fakes with no network.

pub mod adapters;
pub mod api;
pub mod mirror;
pub mod models;
pub mod tokens;
pub mod urls;
pub mod views;

use std::sync::Arc;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

/// Collaborators the handlers need, injected as axum state so tests supply
/// fakes and `main.rs` (Task 8) supplies the real reqwest / umbral-oauth impls.
#[derive(Clone)]
pub struct GithubDeps {
    pub api: Arc<dyn api::GithubApi>,
    pub tokens: Arc<dyn tokens::GithubTokenSource>,
}

#[derive(Debug, Default, Clone)]
pub struct TaskflowGithubPlugin;

impl Plugin for TaskflowGithubPlugin {
    fn name(&self) -> &'static str {
        "taskflow_github"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![umbral::migrate::ModelMeta::for_::<models::TaskflowGithubPref>()]
    }

    fn routes(&self) -> Router {
        // Real adapters: GitHub REST via reqwest, tokens via umbral-oauth.
        // Tests bypass this and call `urls::router(deps)` with fakes.
        let deps = GithubDeps {
            api: Arc::new(adapters::ReqwestGithubApi::new()),
            tokens: Arc::new(adapters::OauthTokenSource),
        };
        urls::router(deps)
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        Ok(())
    }
}
