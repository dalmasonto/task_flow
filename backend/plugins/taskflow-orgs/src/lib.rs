//! TaskflowOrgsPlugin: organisations (#1133, Stage A of the org + licence
//! program). Additive: an org role gates only the org's own routes; project
//! access is still decided by project membership alone. See `models.rs`.

pub mod models;
pub mod service;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowOrgsPlugin;

impl Plugin for TaskflowOrgsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_orgs"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowOrg>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowOrgMember>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowOrgProject>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowOrgInvite>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        static SUBSCRIBED: std::sync::Once = std::sync::Once::new();
        SUBSCRIBED.call_once(|| {
            // A new project lands in its owner's personal org. Only creates:
            // a project edit never moves it.
            umbral::signals::subscribe_async("post_save:taskflow_project", |payload| {
                let created = payload["created"].as_bool().unwrap_or(false);
                let id = payload["instance"]["id"].as_i64();
                async move {
                    if let (true, Some(id)) = (created, id) {
                        service::place_project_id(id).await;
                    }
                }
            });
        });
        // The backfill: every project with no org, at boot. Idempotent.
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(async {
                if let Err(e) = service::backfill_once().await {
                    tracing::error!(error = %e, "org backfill failed; it runs again at the next boot");
                }
            });
        }
        Ok(())
    }
}
