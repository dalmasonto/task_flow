//! #1096: a channel's pinned "current state" (#886 §3.3).
//!
//! One short markdown note per channel saying where the work stands — branch,
//! what was verified, next step, open questions. Setting it appends a row; the
//! newest is current and the rest is the history. Anyone who can SEE the
//! channel may read or set it (members and rostered agents alike — it is the
//! room's shared note, like a pinned message). Nothing writes the message rows.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, StatusCode};
use umbral_auth::RequireAuth;

use crate::agent_auth::RequireAgent;
use crate::answers::{Reply, bad, err, internal, user_label};
use crate::models::{
    TaskflowAgentChannel, TaskflowChannelMemberKind, TaskflowChannelState, taskflow_agent_channel,
    taskflow_channel_state,
};

pub const MAX_CHARS: usize = 8000;
const MAX_HISTORY: usize = 50;

fn state_json(s: &TaskflowChannelState) -> Value {
    json!({
        "id": s.id, "channel": s.channel.id(), "body_markdown": s.body_markdown,
        "author_kind": s.author_kind, "author_user": s.author_user.as_ref().map(|u| u.id()),
        "author_agent": s.author_agent.as_ref().map(|a| a.id()), "author_label": s.author_label,
        "created_at": s.created_at,
    })
}

#[derive(Debug, Default, Deserialize)]
pub struct ReadQuery {
    /// Include up to 50 earlier versions.
    #[serde(default)]
    pub history: bool,
}

async fn read(channel: i64, q: &ReadQuery) -> Reply {
    let rows = TaskflowChannelState::objects()
        .filter(taskflow_channel_state::CHANNEL.eq(channel))
        .order_by(taskflow_channel_state::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let mut out = json!({ "channel": channel, "current": rows.first().map(state_json) });
    if q.history {
        out["history"] = Value::Array(rows.iter().skip(1).take(MAX_HISTORY).map(state_json).collect());
    }
    Ok(Json(out).into_response())
}

#[derive(Debug, Deserialize)]
pub struct SetInput {
    pub body_markdown: String,
}

async fn set(channel: &TaskflowAgentChannel, kind: TaskflowChannelMemberKind, user: Option<i64>, agent: Option<i64>, label: String, input: SetInput) -> Reply {
    let body = input.body_markdown.trim().to_string();
    if body.chars().count() > MAX_CHARS {
        return Err(bad("body_markdown", &format!("at most {MAX_CHARS} characters")));
    }
    // Clearing is setting an empty state: history keeps what it said.
    let row = TaskflowChannelState::objects()
        .create(TaskflowChannelState {
            id: 0,
            project: channel.project.clone(),
            channel: ForeignKey::new(channel.id),
            body_markdown: body,
            author_kind: kind,
            author_user: user.map(ForeignKey::new),
            author_agent: agent.map(ForeignKey::new),
            author_label: label,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(json!({ "current": state_json(&row) }))).into_response())
}

async fn agent_channel(agent: &crate::agent_auth::AgentIdentity, id: i64) -> Result<TaskflowAgentChannel, crate::answers::ApiError> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let ok = crate::views::agent_can_see_channel(&channel, agent.agent_id, agent.project_id)
        .await
        .map_err(internal)?;
    if !ok {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(channel)
}

/// `GET /api/taskflow/channels/{channel}/state[?history=true]`
pub async fn get_as_user(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Query(q): Query<ReadQuery>) -> Reply {
    let channel = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found"))?;
    read(channel.id, &q).await
}

/// `POST /api/taskflow/channels/{channel}/state`
pub async fn set_as_user(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Json(input): Json<SetInput>) -> Reply {
    let channel = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found"))?;
    let label = user_label(user).await;
    set(&channel, TaskflowChannelMemberKind::User, Some(user), None, label, input).await
}

/// `GET /api/taskflow/agents/channels/{channel}/state[?history=true]`
pub async fn get_as_agent(RequireAgent(agent): RequireAgent, Path(channel): Path<i64>, Query(q): Query<ReadQuery>) -> Reply {
    let channel = agent_channel(&agent, channel).await?;
    read(channel.id, &q).await
}

/// `POST /api/taskflow/agents/channels/{channel}/state` (chat:send)
pub async fn set_as_agent(RequireAgent(agent): RequireAgent, Path(channel): Path<i64>, Json(input): Json<SetInput>) -> Reply {
    agent
        .require(crate::scopes::CHAT_SEND)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let channel = agent_channel(&agent, channel).await?;
    set(&channel, TaskflowChannelMemberKind::Agent, None, Some(agent.agent_id), agent.display_name.clone(), input).await
}
