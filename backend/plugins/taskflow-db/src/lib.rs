//! `taskflow-db` (#885): the Database tool. See `schema_doc` for the document
//! and its rules, `store` for versioned saves, `views` / `agent_views` for the
//! human and agent routes.

pub mod agent_views;
pub mod models;
pub mod room;
pub mod schema_doc;
pub mod store;
pub mod urls;
pub mod views;

use umbral::plugin::Plugin;
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowDbPlugin;

impl Plugin for TaskflowDbPlugin {
    fn name(&self) -> &'static str {
        "taskflow_db"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_agents"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::DbSchema>(),
            umbral::migrate::ModelMeta::for_::<models::DbSchemaVersion>(),
            umbral::migrate::ModelMeta::for_::<models::DbRoom>(),
        ]
    }

    fn routes(&self) -> Router {
        urls::router()
    }
}
