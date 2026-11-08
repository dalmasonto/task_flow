//! Models for `taskflow-usage` (#1115, #886 §3.11).
//!
//! Money is stored as integer **micro-dollars** (1 USD = 1_000_000), never
//! floats, so sums are exact. Prices are micro-dollars per MILLION tokens, so
//! cost = tokens × price / 1_000_000 with no rounding until display.
//!
//! **The numbers are self-reported** by each agent's MCP (lead review
//! #MSG5706): for awareness, not billing. Every table is written only by this
//! plugin's endpoints; auto-REST serves them read-only and project-scoped.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_agents::models::{TaskflowAgent, TaskflowAgentChannel};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::ForeignKey;

/// A model's list price. `project = NULL` rows are the seeded defaults; a
/// project's own row for the same prefix overrides them. Every component is
/// optional: a NULL price means "we cannot cite it", and any report that needs
/// it is left unpriced rather than guessed (lead review #MSG5706).
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "model_prefix"]])]
pub struct TaskflowModelPrice {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: Option<ForeignKey<TaskflowProject>>,
    /// Matched against the reported model id; the LONGEST matching prefix wins.
    #[umbral(string, max_length = 120)]
    pub model_prefix: String,
    #[umbral(string, max_length = 120)]
    pub display_name: String,
    pub input_micros_per_mtok: Option<i64>,
    pub output_micros_per_mtok: Option<i64>,
    pub cache_read_micros_per_mtok: Option<i64>,
    pub cache_write_micros_per_mtok: Option<i64>,
    /// Where the price comes from ("Anthropic API list price", a URL…).
    #[umbral(string, max_length = 300)]
    pub source: String,
    /// When the price was true ("2026-10-06").
    #[umbral(string, max_length = 20)]
    pub as_of: String,
    #[umbral(string, max_length = 160)]
    pub updated_by_label: String,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// One agent turn's token counts. Append-only; `(agent, turn_id)` is unique so
/// a retried report is a no-op.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(
    unique_together = [["agent", "turn_id"]],
    indexes = [["project", "reported_at"], ["project", "task", "reported_at"], ["agent", "reported_at"]]
)]
pub struct TaskflowUsageReport {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: ForeignKey<TaskflowAgent>,
    /// The agent's in-progress task when the report arrived — derived
    /// server-side, never trusted from the client. NULL = no task claimed.
    pub task: Option<i64>,
    #[umbral(string, max_length = 120)]
    pub model: String,
    #[umbral(string, max_length = 120)]
    pub turn_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// NULL = unpriced (unknown model, or a needed price component missing).
    pub cost_micros: Option<i64>,
    /// The price row used — recorded so history does not move when prices do.
    pub price_id: Option<i64>,
    pub reported_at: DateTime<Utc>,
}

/// A project's budget and alerts.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project"]])]
pub struct TaskflowUsageSettings {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// Monthly budget. NULL = none.
    pub budget_micros: Option<i64>,
    /// Post in `alert_channel` when month-to-date spend reaches this % of budget.
    pub alert_percent: Option<i64>,
    #[umbral(on_delete = "set_null")]
    pub alert_channel: Option<ForeignKey<TaskflowAgentChannel>>,
    /// "Stop and ask" when one task's spend passes this.
    pub task_cap_micros: Option<i64>,
    /// Warn when an agent with no task in progress spends ≥ $1 in an hour.
    #[umbral(default = "false")]
    pub idle_alert: bool,
    /// The month ("2026-11") the budget alert last fired, so it fires once.
    #[umbral(string, max_length = 7)]
    pub budget_alerted_month: Option<String>,
    #[umbral(string, max_length = 160)]
    pub updated_by_label: String,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// One alert that fired, so each fires once (a task cap per task, an idle
/// warning per agent per hour).
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "kind", "subject"]])]
pub struct TaskflowUsageAlert {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// "task_cap" or "idle".
    #[umbral(string, max_length = 20)]
    pub kind: String,
    /// "task:<id>" or "agent:<id>:<yyyy-mm-ddThh>".
    #[umbral(string, max_length = 80)]
    pub subject: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
