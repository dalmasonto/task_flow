//! #885 storage: one current schema document per project, plus an append-only
//! history row per accepted save (for compare and restore).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use umbral::orm::ForeignKey;

use taskflow_projects::models::TaskflowProject;

/// The project's current data model. `doc_json` is a serialised
/// `schema_doc::SchemaDoc`; `version` bumps on every save and is what a writer
/// hands back as `base_version`.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project"]])]
pub struct DbSchema {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 1_048_576, widget = "textarea")]
    pub doc_json: String,
    #[umbral(default = "0")]
    pub version: i64,
    /// `user:<id>` or `agent:<id>` — who saved last.
    #[umbral(string, max_length = 40)]
    pub updated_by: String,
    #[umbral(string, max_length = 120)]
    pub updated_by_label: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// One accepted save. `note` says what happened in a line ("Claude (main)
/// wrote Agent", "you edited 2 fields", "restored v4").
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct DbSchemaVersion {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    pub version: i64,
    #[umbral(string, max_length = 1_048_576, widget = "textarea")]
    pub doc_json: String,
    #[umbral(string, max_length = 40)]
    pub author: String,
    #[umbral(string, max_length = 120)]
    pub author_label: String,
    #[umbral(string, max_length = 300)]
    pub note: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// The project's database chat room (Dalmas, msg 5545: "its own db-room").
/// Kept HERE, as a pointer to an ordinary project channel, rather than as a new
/// marker column on the channel table, so this plugin owns its own schema.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project"]])]
pub struct DbRoom {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub channel: ForeignKey<taskflow_agents::models::TaskflowAgentChannel>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
