//! #1126: claim leases. An agent's claim on a task lasts while the agent is
//! alive; once it has gone silent for longer than the lease, a sweep releases
//! the task so another agent can claim it (claims are exclusive since #1125).
//!
//! **The rule, written down.** A claimed task's lease runs from its anchor,
//! `max(agent.last_seen_at, task.updated_at)`: every heartbeat and session
//! registration stamps `last_seen_at`, and the claim itself stamps
//! `updated_at`, so an agent that claimed but never heartbeated still gets a
//! full lease. It expires at `anchor + lease` (30 minutes by default,
//! `TASKFLOW_CLAIM_LEASE_MINUTES`, 5 to 1440). Renewal is implicit: any
//! heartbeat moves the anchor. No new MCP call. **Any edit to the task also
//! renews it** (through `updated_at`), whoever makes it: conservative on
//! purpose, a task someone is touching isn't taken away.
//!
//! **Only active work is released:** `not_started` and `in_progress`. A task
//! the agent paused, marked blocked, or handed to review keeps its assignee;
//! those wait on someone else, not on the agent's terminal.
//!
//! **A release** (in the background sweep, never on a request path):
//! - clears `assigned_agent_id` / `assignee_label` by a column update guarded
//!   on the same holder, so a re-claim or a reassignment in between wins;
//! - emits `post_save` for the fresh row (realtime);
//! - writes ONE `claim_released` activity row saying who went silent when;
//! - posts the agent a notice in its private Wake-ups DM. That stays unread,
//!   so the MCP hands it over when the agent reconnects, and it doesn't
//!   resume work it no longer holds.
//!
//! The board can show the lease chip from data it already has: `lease_expires_at
//! = max(agent.last_seen_at, task.updated_at) + lease_minutes`
//! (`GET /api/taskflow/claim-lease` → `{lease_minutes}`).

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Response};

use taskflow_tasks::models::{TaskflowActorKind, TaskflowTask, taskflow_task};

use crate::models::{TaskflowAgent, taskflow_agent};

pub const DEFAULT_LEASE_MINUTES: i64 = 30;
const SWEEP_SECONDS: u64 = 60;
/// The statuses a silent agent can lose. See the module docs.
const RELEASABLE: [&str; 2] = ["not_started", "in_progress"];

pub fn lease_minutes() -> i64 {
    std::env::var("TASKFLOW_CLAIM_LEASE_MINUTES")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_LEASE_MINUTES)
        .clamp(5, 1440)
}

/// The moment a claim's lease is counted from.
pub fn anchor(agent_last_seen: Option<DateTime<Utc>>, task_updated: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (agent_last_seen, task_updated) {
        (Some(a), Some(t)) => Some(a.max(t)),
        (a, t) => a.or(t),
    }
}

/// Release every claim whose lease ran out before `now`. Returns how many.
pub async fn sweep_once(now: DateTime<Utc>, lease: Duration) -> usize {
    let held = match TaskflowTask::objects()
        .filter(taskflow_task::ASSIGNED_AGENT_ID.is_not_null() & taskflow_task::STATUS.in_(&RELEASABLE))
        .fetch()
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "claim lease sweep: could not read held tasks; retrying next tick");
            return 0;
        }
    };
    if held.is_empty() {
        return 0;
    }
    let mut ids: Vec<i64> = held.iter().filter_map(|t| t.assigned_agent_id).collect();
    ids.sort_unstable();
    ids.dedup();
    let agents = TaskflowAgent::objects().filter(taskflow_agent::ID.in_(&ids)).fetch().await.unwrap_or_default();

    let mut released = 0;
    for task in &held {
        let Some(holder) = task.assigned_agent_id else { continue };
        let agent = agents.iter().find(|a| a.id == holder);
        let Some(from) = anchor(agent.and_then(|a| a.last_seen_at), task.updated_at) else { continue };
        if now - from <= lease {
            continue;
        }
        if release(task, holder, agent, from, now).await {
            released += 1;
        }
    }
    if released > 0 {
        tracing::info!(released, "claim lease sweep: released claims of silent agents");
    }
    released
}

async fn release(task: &TaskflowTask, holder: i64, agent: Option<&TaskflowAgent>, silent_since: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    let mut v = serde_json::Map::new();
    v.insert("assigned_agent_id".into(), serde_json::Value::Null);
    v.insert("assignee_label".into(), serde_json::Value::Null);
    v.insert("updated_at".into(), json!(now));
    // Guarded on the holder: a re-claim or reassignment in between wins.
    let n = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task.id) & taskflow_task::ASSIGNED_AGENT_ID.eq(holder))
        .update_values(v)
        .await
        .unwrap_or(0);
    if n == 0 {
        return false;
    }
    if let Ok(Some(fresh)) = TaskflowTask::objects().filter(taskflow_task::ID.eq(task.id)).first().await {
        crate::emit::emit_post_save(&fresh).await;
    }
    let who = agent.map(|a| a.display_name.clone()).unwrap_or_else(|| format!("agent {holder}"));
    let when = silent_since.format("%Y-%m-%d %H:%M UTC");
    let label = crate::views::task_label(task);
    if let Err(status) = crate::views::emit_task_activity(
        task.project.id(),
        task.id,
        TaskflowActorKind::System,
        None,
        None,
        "TaskFlow".to_string(),
        "claim_released",
        Some(format!("{label} · claim released: {who} went silent at {when}")),
    )
    .await
    {
        tracing::error!(task = task.id, %status, "claim released but its activity row failed");
    }
    let notice = format!(
        "Your claim on {label} was released: no heartbeat from you since {when}, longer than the {} minute lease. It's unassigned now; claim it again if you're still on it (another agent may have taken it).",
        lease_minutes()
    );
    if let Err((status, _)) = crate::wakeups::notify_agent(holder, notice).await {
        tracing::warn!(agent = holder, %status, "claim released but the notice to the agent failed");
    }
    true
}

/// Start the sweep (boot + every minute). Called once from the plugin.
pub fn start() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        tokio::spawn(async {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(SWEEP_SECONDS));
            loop {
                tick.tick().await;
                sweep_once(Utc::now(), Duration::minutes(lease_minutes())).await;
            }
        });
    });
}

/// `GET /api/taskflow/claim-lease` (any caller): the lease length, so the
/// board's chip can compute `max(agent.last_seen_at, task.updated_at) + lease`.
pub async fn lease_info() -> Response {
    Json(json!({ "lease_minutes": lease_minutes() })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_anchor_is_the_later_of_last_seen_and_the_claim() {
        let t0 = Utc::now();
        let t1 = t0 + Duration::minutes(5);
        assert_eq!(anchor(Some(t0), Some(t1)), Some(t1));
        assert_eq!(anchor(Some(t1), Some(t0)), Some(t1));
        assert_eq!(anchor(None, Some(t0)), Some(t0));
        assert_eq!(anchor(None, None), None);
    }
}
