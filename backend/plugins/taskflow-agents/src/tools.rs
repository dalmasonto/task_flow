//! #5988 item 8: "Ran 4 design tools while writing this" (chat.html).
//!
//! `GET /api/taskflow/channels/{c}/tools?messages=1,2,3` (at most 100 ids)
//! answers `{ "<id>": {count, names: [up to 5, most used first]} }` for the
//! listed messages of this room that an AGENT sent (others are left out).
//!
//! A message's tools are its sender's `tool:<Name>` activity rows in the
//! message's **project** between the agent's previous message (in any room of
//! that project) and this one, looking back at most [`LOOKBACK`]. Only tool
//! names are read, never payloads; `mcp__server__tool` reads as `tool`, and
//! the `send_message` call that posted the message itself is not counted.
//! Two queries per sending agent on the page, not per message.
//!
//! The caller must see the room (a private room's roster); else 404.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

use crate::models::{TaskflowAgentMessage, TaskflowChannelMemberKind, taskflow_agent_message};

pub const MAX_IDS: usize = 100;
pub const LOOKBACK: Duration = Duration::hours(2);
const MAX_NAMES: usize = 5;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "tools per message failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

/// `tool:mcp__taskflow__design_screenshot` → `design_screenshot`;
/// `tool:Edit` → `Edit`; anything not a tool row → `None`.
pub fn tool_name(action: &str) -> Option<String> {
    let name = action.strip_prefix("tool:")?.trim();
    let short = match name.strip_prefix("mcp__") {
        Some(rest) => rest.rsplit("__").next().unwrap_or(rest),
        None => name,
    };
    (!short.is_empty()).then(|| short.to_string())
}

#[derive(Debug, Deserialize)]
pub struct ToolsQuery {
    pub messages: String,
}

fn parse_ids(raw: &str) -> Result<Vec<i64>, ApiError> {
    let mut ids: Vec<i64> = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let id: i64 = part.parse().map_err(|_| err(StatusCode::BAD_REQUEST, "invalid", "`messages` is a comma-separated list of ids."))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_IDS {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", "At most 100 messages per read."));
    }
    Ok(ids)
}

/// `GET /api/taskflow/channels/{channel}/tools`
pub async fn for_messages(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Query(q): Query<ToolsQuery>) -> Result<Response, ApiError> {
    let room = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found", "No such room."))?;
    let ids = parse_ids(&q.messages)?;
    if ids.is_empty() {
        return Ok(Json(json!({})).into_response());
    }
    let project = room.project.id();
    let messages: Vec<TaskflowAgentMessage> = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(room.id) & taskflow_agent_message::ID.in_(&ids))
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|m| m.sender_kind == TaskflowChannelMemberKind::Agent && m.sender_agent.is_some() && m.created_at.is_some())
        .collect();

    let mut by_agent: HashMap<i64, Vec<&TaskflowAgentMessage>> = HashMap::new();
    for m in &messages {
        by_agent.entry(m.sender_agent.as_ref().map(|a| a.id()).unwrap_or(0)).or_default().push(m);
    }

    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (agent, mine) in by_agent {
        let first: DateTime<Utc> = mine.iter().filter_map(|m| m.created_at).min().unwrap_or_else(Utc::now);
        let last: DateTime<Utc> = mine.iter().filter_map(|m| m.created_at).max().unwrap_or_else(Utc::now);
        let max_id = mine.iter().map(|m| m.id).max().unwrap_or(0);
        let since = first - LOOKBACK;
        // The agent's own messages in this project over the span: each one is
        // the previous-message boundary for the next.
        let mut sent: Vec<(i64, DateTime<Utc>)> = TaskflowAgentMessage::objects()
            .filter(
                taskflow_agent_message::PROJECT.eq(project)
                    & taskflow_agent_message::SENDER_AGENT.eq(agent)
                    & taskflow_agent_message::ID.lte(max_id)
                    & taskflow_agent_message::CREATED_AT.gte(since),
            )
            .fetch()
            .await
            .map_err(internal)?
            .into_iter()
            .filter_map(|m| m.created_at.map(|t| (m.id, t)))
            .collect();
        sent.sort();
        let tools: Vec<(DateTime<Utc>, String)> = TaskflowTaskActivity::objects()
            .filter(
                taskflow_task_activity::PROJECT.eq(project)
                    & taskflow_task_activity::ACTOR_AGENT_ID.eq(agent)
                    & taskflow_task_activity::CREATED_AT.gte(since)
                    & taskflow_task_activity::CREATED_AT.lte(last)
                    & taskflow_task_activity::ACTION.startswith("tool:"),
            )
            .fetch()
            .await
            .map_err(internal)?
            .into_iter()
            .filter_map(|a| Some((a.created_at?, tool_name(&a.action)?)))
            .filter(|(_, n)| n != "send_message")
            .collect();

        for m in mine {
            let Some(at) = m.created_at else { continue };
            let prev = sent.iter().filter(|(id, _)| *id < m.id).map(|(_, t)| *t).max();
            let from = prev.map_or(at - LOOKBACK, |p| p.max(at - LOOKBACK));
            let mut counts: Vec<(String, usize)> = Vec::new();
            let mut total = 0usize;
            for (t, name) in &tools {
                if *t > from && *t <= at {
                    total += 1;
                    match counts.iter_mut().find(|(n, _)| n == name) {
                        Some((_, c)) => *c += 1,
                        None => counts.push((name.clone(), 1)),
                    }
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let names: Vec<String> = counts.into_iter().take(MAX_NAMES).map(|(n, _)| n).collect();
            out.insert(m.id.to_string(), json!({ "count": total, "names": names }));
        }
    }
    Ok(Json(out).into_response())
}

#[cfg(test)]
mod tests {
    #[test]
    fn tool_names() {
        assert_eq!(super::tool_name("tool:Edit").as_deref(), Some("Edit"));
        assert_eq!(super::tool_name("tool:mcp__taskflow__design_screenshot").as_deref(), Some("design_screenshot"));
        assert_eq!(super::tool_name("session_stop"), None);
        assert_eq!(super::tool_name("tool:"), None);
    }
}
