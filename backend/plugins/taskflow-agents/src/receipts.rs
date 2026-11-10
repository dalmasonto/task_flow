//! #5988 item 7: delivery receipts ("Delivered to Claude (main), pane %4").
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `POST /api/taskflow/agents/messages/{m}/delivered` (agent) | `{pane?}` | 201 new / 200 already |
//! | `GET /api/taskflow/channels/{c}/deliveries?messages=1,2` (people) | | 200 `{ "<id>": [receipt] }` |
//!
//! * **The agent is the key's, never the body's.** It may report only a
//!   message it can read (a private room's roster, its own project; else
//!   404), and not its own message (400 `own_message`). `pane` is tmux's id,
//!   `%` plus digits, at most 32 characters (400 otherwise).
//! * Idempotent: the unique index on (message, agent) makes a second report
//!   200 with the first row. The message row is never touched (#107).
//! * The read checks the room's visibility (404), takes at most 100 ids, and
//!   lists `{agent, label, pane, delivered_at}` per message. A message no MCP
//!   reported has `[]`: older MCPs don't report, so "none" never means "not
//!   delivered".

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::agent_auth::RequireAgent;
use crate::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelMemberKind, TaskflowMessageDelivery, taskflow_agent,
    taskflow_agent_channel, taskflow_agent_message, taskflow_message_delivery,
};

pub const MAX_IDS: usize = 100;
const MAX_PANE: usize = 32;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "delivery receipts failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "not_found", "No such message.")
}

fn pane_ok(p: &str) -> bool {
    p.len() <= MAX_PANE && p.len() > 1 && p.starts_with('%') && p[1..].bytes().all(|b| b.is_ascii_digit())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    #[serde(default)]
    pub pane: Option<String>,
}

fn receipt_json(r: &TaskflowMessageDelivery, label: &str) -> Value {
    json!({ "agent": r.agent.id(), "label": label, "pane": r.pane, "delivered_at": r.delivered_at })
}

/// `POST /api/taskflow/agents/messages/{message}/delivered`
pub async fn report(RequireAgent(a): RequireAgent, Path(message): Path<i64>, Json(i): Json<ReportInput>) -> Result<Response, ApiError> {
    let pane = i.pane.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if pane.as_deref().is_some_and(|p| !pane_ok(p)) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", "`pane` is a tmux pane id such as %4."));
    }
    let m = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(message))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(m.channel.id()))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let visible = crate::views::agent_can_see_channel(&channel, a.agent_id, a.project_id).await.map_err(|_| not_found())?;
    if !visible {
        return Err(not_found());
    }
    if m.sender_kind == TaskflowChannelMemberKind::Agent && m.sender_agent.as_ref().map(|x| x.id()) == Some(a.agent_id) {
        return Err(err(StatusCode::BAD_REQUEST, "own_message", "An agent doesn't receive its own messages."));
    }
    let existing = || async {
        TaskflowMessageDelivery::objects()
            .filter(taskflow_message_delivery::MESSAGE.eq(m.id) & taskflow_message_delivery::AGENT.eq(a.agent_id))
            .first()
            .await
            .map_err(internal)
    };
    if let Some(r) = existing().await? {
        return Ok((StatusCode::OK, Json(receipt_json(&r, &a.display_name))).into_response());
    }
    let created = TaskflowMessageDelivery::objects()
        .create(TaskflowMessageDelivery {
            id: 0,
            project: m.project.clone(),
            channel: ForeignKey::new(channel.id),
            message: ForeignKey::new(m.id),
            agent: ForeignKey::new(a.agent_id),
            pane,
            delivered_at: None,
        })
        .await;
    match created {
        Ok(r) => Ok((StatusCode::CREATED, Json(receipt_json(&r, &a.display_name))).into_response()),
        // Lost a race with the same report (the unique index): it exists.
        Err(_) => match existing().await? {
            Some(r) => Ok((StatusCode::OK, Json(receipt_json(&r, &a.display_name))).into_response()),
            None => Err(internal("delivery insert failed")),
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct DeliveriesQuery {
    pub messages: String,
}

/// `GET /api/taskflow/channels/{channel}/deliveries`
pub async fn for_messages(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Query(q): Query<DeliveriesQuery>) -> Result<Response, ApiError> {
    let room = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found", "No such room."))?;
    let mut ids: Vec<i64> = Vec::new();
    for part in q.messages.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let id: i64 = part.parse().map_err(|_| err(StatusCode::BAD_REQUEST, "invalid", "`messages` is a comma-separated list of ids."))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_IDS {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", "At most 100 messages per read."));
    }
    let mut out: BTreeMap<String, Vec<Value>> = ids.iter().map(|i| (i.to_string(), Vec::new())).collect();
    if ids.is_empty() {
        return Ok(Json(out).into_response());
    }
    let rows = TaskflowMessageDelivery::objects()
        .filter(taskflow_message_delivery::CHANNEL.eq(room.id) & taskflow_message_delivery::MESSAGE.in_(&ids))
        .order_by(taskflow_message_delivery::ID.asc())
        .fetch()
        .await
        .map_err(internal)?;
    let agent_ids: Vec<i64> = rows.iter().map(|r| r.agent.id()).collect();
    let labels: BTreeMap<i64, String> = if agent_ids.is_empty() {
        BTreeMap::new()
    } else {
        TaskflowAgent::objects()
            .filter(taskflow_agent::ID.in_(&agent_ids))
            .fetch()
            .await
            .map_err(internal)?
            .into_iter()
            .map(|a| (a.id, a.display_name))
            .collect()
    };
    for r in &rows {
        let label = labels.get(&r.agent.id()).cloned().unwrap_or_else(|| format!("agent {}", r.agent.id()));
        out.entry(r.message.id().to_string()).or_default().push(receipt_json(r, &label));
    }
    Ok(Json(out).into_response())
}

#[cfg(test)]
mod tests {
    #[test]
    fn panes() {
        assert!(super::pane_ok("%4"));
        assert!(super::pane_ok("%123"));
        assert!(!super::pane_ok("%"));
        assert!(!super::pane_ok("4"));
        assert!(!super::pane_ok("%4; rm -rf"));
    }
}
