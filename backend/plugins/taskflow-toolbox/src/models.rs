//! Models for the `taskflow-toolbox` plugin (#617).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::{Choices, ForeignKey};
use umbral_auth::AuthUser;

/// What an entry is for. A memory is prose an agent reads; a script is code an
/// agent (or a person) runs locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum ToolboxKind {
    Memory,
    Script,
}

/// The human gate. A script written by one agent is a `draft` until a person
/// approves it, and the MCP tells the agent to say so before running it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum ToolboxStatus {
    Draft,
    Approved,
    Deprecated,
}

/// One shared entry of a project's toolbox. `name` is a per-project slug: the
/// stable handle every tool uses, and the folder name on disk when a script is
/// installed.
///
/// The row holds the CURRENT version; every save also writes a
/// `ToolboxEntryVersion` row, so a bad update can be rolled back and a diff
/// can be shown between any two.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "name"]])]
pub struct ToolboxEntry {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(choices, default = "memory")]
    pub kind: ToolboxKind,
    #[umbral(string, max_length = 60)]
    pub name: String,
    #[umbral(string, max_length = 200)]
    pub title: String,
    /// One line, used in the connect-time index. It should say WHEN to use the
    /// entry — that is the whole retrieval signal an agent gets.
    #[umbral(string, max_length = 600)]
    pub description: String,
    /// A memory's text, or a script's usage notes.
    #[umbral(string, max_length = 200_000, widget = "textarea")]
    pub body_markdown: String,
    /// Scripts: the code. `None` for memories, so a listing never accidentally
    /// carries it.
    #[umbral(string, max_length = 400_000, widget = "textarea")]
    pub code: Option<String>,
    /// Scripts: `bash`, `python`, `node`, … declared, never enforced.
    #[umbral(string, max_length = 40)]
    pub language: Option<String>,
    /// The file to run inside the installed folder (`report.py`).
    #[umbral(string, max_length = 120)]
    pub entrypoint: Option<String>,
    /// `[{name, description, required}]` as JSON text.
    #[umbral(string, max_length = 8000)]
    pub params_json: Option<String>,
    /// Environment VARIABLE NAMES the script reads. Never values.
    #[umbral(string, max_length = 2000)]
    pub requires_env_json: Option<String>,
    /// JSON array of tag strings.
    #[umbral(string, max_length = 1000)]
    pub tags_json: Option<String>,
    /// The authoring agent's id, as a plain number. The toolbox must not depend
    /// on the agents plugin (agents embeds this plugin's index), and the read
    /// that needs a name goes through `author_label`.
    pub author_agent_id: Option<i64>,
    #[umbral(on_delete = "set_null")]
    pub author_user: Option<ForeignKey<AuthUser>>,
    /// Display label for the author, stored at write time — agents are deleted,
    /// and a history row that says "someone" is worse than one that says who.
    #[umbral(string, max_length = 160)]
    pub author_label: String,
    /// Bumped on every save; `base_version` on a save must match it.
    pub version: i64,
    #[umbral(choices, default = "draft")]
    pub status: ToolboxStatus,
    #[umbral(string, max_length = 400)]
    pub deprecated_reason: Option<String>,
    #[umbral(noedit)]
    pub last_run_at: Option<DateTime<Utc>>,
    #[umbral(noedit, default = "false")]
    pub last_run_ok: bool,
    #[umbral(noedit, default = "0")]
    pub run_ok_count: i64,
    #[umbral(noedit, default = "0")]
    pub run_fail_count: i64,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// One past state of an entry, written on every save. Restoring a version is
/// itself a save, so the history is append-only and a rollback is visible.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct ToolboxEntryVersion {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub entry: ForeignKey<ToolboxEntry>,
    /// The entry's version AT this snapshot.
    pub version: i64,
    #[umbral(string, max_length = 200_000, widget = "textarea")]
    pub body_markdown: String,
    #[umbral(string, max_length = 400_000, widget = "textarea")]
    pub code: Option<String>,
    #[umbral(string, max_length = 8000)]
    pub params_json: Option<String>,
    #[umbral(string, max_length = 2000)]
    pub requires_env_json: Option<String>,
    #[umbral(string, max_length = 600)]
    pub description: String,
    #[umbral(string, max_length = 160)]
    pub author_label: String,
    /// Why this version replaced the one before it — what a diff reader needs.
    #[umbral(string, max_length = 400)]
    pub note: Option<String>,
    /// Who VETTED this version for local install (an agent id), recorded when
    /// an agent installs it, so teammates can see who checked what.
    #[umbral(string, max_length = 160)]
    pub vetted_by: Option<String>,
    #[umbral(string, max_length = 600)]
    pub vetted_note: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
