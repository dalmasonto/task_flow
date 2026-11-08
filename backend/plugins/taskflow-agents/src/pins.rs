//! #5949: pinned messages and reactions, for chat.html.
//!
//! People (`/api/taskflow/channels/{c}/…`) and agents
//! (`/api/taskflow/agents/channels/{c}/…`) share every rule:
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `GET …/pins` | | 200 `[pin]`, newest pin first |
//! | `POST …/pins` | `{message}` | 201 new / 200 already pinned |
//! | `DELETE …/pins/{message}` | | 200 `{unpinned}` |
//! | `POST …/messages/{m}/reactions` | `{emoji}` | 200 that message's summary (a toggle) |
//! | `GET …/reactions?messages=1,2,3` | | 200 `{ "<id>": [summary] }` |
//!
//! * **Who:** anyone who can see the room (the same rule as reading it: a
//!   private room's roster, else the project). Writes are refused in an
//!   archived room (409 `archived`). A room you can't see is 404.
//! * **Pins:** a root of this room only (a thread-only reply 400
//!   `not_a_root`); at most [`MAX_PINS`] per room (409 `too_many_pins`).
//! * **Reactions:** `emoji` is one of [`EMOJI`] (400 `unknown_emoji`), so a
//!   reaction is never free text in anyone's pane. A summary is
//!   `{emoji, count, mine, by: [labels, at most 5]}`.
//! * Neither touches the message row, so nothing is re-typed into a pane.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};

use crate::agent_auth::RequireAgent;
use crate::models::{
    TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelMemberKind, TaskflowMessagePin, TaskflowMessageReaction,
    taskflow_agent_channel, taskflow_agent_message, taskflow_message_pin, taskflow_message_reaction,
};

pub const MAX_PINS: usize = 50;
pub const MAX_IDS: usize = 100;
/// The reactions a message can carry (chat.html uses eyes, thumbs, check,
/// rocket). Names, mapped to glyphs by the client.
pub const EMOJI: [&str; 8] = ["thumbs_up", "eyes", "check", "heart", "tada", "rocket", "thinking", "x"];
const EXCERPT: usize = 160;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "pins/reactions failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "not_found", "No such room or message.")
}

/// Who is calling.
#[derive(Debug, Clone)]
enum Who {
    User(i64),
    Agent { id: i64, project: i64, label: String },
}

impl Who {
    fn key(&self) -> String {
        match self {
            Who::User(u) => format!("user:{u}"),
            Who::Agent { id, .. } => format!("agent:{id}"),
        }
    }

    async fn label(&self, project: i64) -> Result<String, ApiError> {
        match self {
            Who::Agent { label, .. } => Ok(label.clone()),
            Who::User(u) => person_label(*u, project).await,
        }
    }
}

/// A person's label in a project: their member name, else their username.
pub(crate) async fn person_label(u: i64, project: i64) -> Result<String, ApiError> {
    let name = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(u))
        .first()
        .await
        .map_err(internal)?
        .map(|m| m.display_name)
        .filter(|n| !n.trim().is_empty());
    Ok(match name {
        Some(n) => n,
        None => AuthUser::objects()
            .filter(auth_user::ID.eq(u))
            .first()
            .await
            .map_err(internal)?
            .map(|u| u.username)
            .unwrap_or_else(|| format!("user {u}")),
    })
}

/// The room, if the caller can see it.
async fn room(who: &Who, channel: i64) -> Result<TaskflowAgentChannel, ApiError> {
    match who {
        Who::User(u) => crate::views::ensure_channel_visible(*u, channel).await.map_err(|_| not_found()),
        Who::Agent { id, project, .. } => {
            let c = TaskflowAgentChannel::objects()
                .filter(taskflow_agent_channel::ID.eq(channel))
                .first()
                .await
                .map_err(internal)?
                .ok_or_else(not_found)?;
            let ok = crate::views::agent_can_see_channel(&c, *id, *project).await.map_err(|_| not_found())?;
            if !ok {
                return Err(not_found());
            }
            Ok(c)
        }
    }
}

fn writable(c: &TaskflowAgentChannel) -> Result<(), ApiError> {
    if c.archived {
        return Err(err(StatusCode::CONFLICT, "archived", "This room is archived."));
    }
    Ok(())
}

async fn message_in(channel: i64, message: i64) -> Result<TaskflowAgentMessage, ApiError> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(message) & taskflow_agent_message::CHANNEL.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}

fn excerpt(body: &str) -> String {
    // #6003: chips read as `@Name`, as in the room summary.
    let body = crate::summary::strip_chips(body);
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT {
        return flat;
    }
    let mut s: String = flat.chars().take(EXCERPT - 1).collect();
    s.push('…');
    s
}

// ---------------------------------------------------------------- pins

/// The room's pins, newest first, each with its message's excerpt.
pub async fn pins_json(channel: i64) -> Result<Vec<Value>, ApiError> {
    let pins = TaskflowMessagePin::objects()
        .filter(taskflow_message_pin::CHANNEL.eq(channel))
        .order_by(taskflow_message_pin::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let ids: Vec<i64> = pins.iter().map(|p| p.message.id()).collect();
    let messages: BTreeMap<i64, TaskflowAgentMessage> = if ids.is_empty() {
        BTreeMap::new()
    } else {
        TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::ID.in_(&ids))
            .fetch()
            .await
            .map_err(internal)?
            .into_iter()
            .map(|m| (m.id, m))
            .collect()
    };
    Ok(pins
        .iter()
        .filter_map(|p| {
            let m = messages.get(&p.message.id())?;
            Some(json!({
                "message": m.id,
                "excerpt": excerpt(&m.body_markdown),
                "sender_label": m.sender_label,
                "created_at": m.created_at,
                "pinned_by_label": p.pinned_by_label,
                "pinned_at": p.created_at,
            }))
        })
        .collect())
}

/// How many pins a room has (for the agents' room list).
pub async fn pin_count(channel: i64) -> i64 {
    TaskflowMessagePin::objects().filter(taskflow_message_pin::CHANNEL.eq(channel)).count().await.unwrap_or(0)
}

async fn list_pins(who: Who, channel: i64) -> Result<Response, ApiError> {
    let c = room(&who, channel).await?;
    Ok(Json(pins_json(c.id).await?).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinInput {
    pub message: i64,
}

async fn pin(who: Who, channel: i64, input: PinInput) -> Result<Response, ApiError> {
    let c = room(&who, channel).await?;
    writable(&c)?;
    let m = message_in(c.id, input.message).await?;
    if m.thread_root.is_some() && !m.in_channel {
        return Err(err(StatusCode::BAD_REQUEST, "not_a_root", "Only messages in the room itself can be pinned, not thread-only replies."));
    }
    if let Some(existing) = TaskflowMessagePin::objects().filter(taskflow_message_pin::MESSAGE.eq(m.id)).first().await.map_err(internal)? {
        return Ok((StatusCode::OK, Json(json!({ "message": existing.message.id(), "pinned_by_label": existing.pinned_by_label }))).into_response());
    }
    let n = TaskflowMessagePin::objects().filter(taskflow_message_pin::CHANNEL.eq(c.id)).count().await.map_err(internal)?;
    if n as usize >= MAX_PINS {
        return Err(err(StatusCode::CONFLICT, "too_many_pins", "A room can hold at most 50 pins. Unpin one first."));
    }
    let label = who.label(c.project.id()).await?;
    let (kind, user, agent) = match &who {
        Who::User(u) => (TaskflowChannelMemberKind::User, Some(ForeignKey::new(*u)), None),
        Who::Agent { id, .. } => (TaskflowChannelMemberKind::Agent, None, Some(ForeignKey::new(*id))),
    };
    let created = TaskflowMessagePin::objects()
        .create(TaskflowMessagePin {
            id: 0,
            project: c.project.clone(),
            channel: ForeignKey::new(c.id),
            message: ForeignKey::new(m.id),
            pinned_by_kind: kind,
            pinned_by_user: user,
            pinned_by_agent: agent,
            pinned_by_label: label,
            created_at: None,
        })
        .await;
    match created {
        Ok(p) => Ok((StatusCode::CREATED, Json(json!({ "message": p.message.id(), "pinned_by_label": p.pinned_by_label }))).into_response()),
        // Lost a race with another pin of the same message (the unique index).
        Err(_) => {
            let p = TaskflowMessagePin::objects()
                .filter(taskflow_message_pin::MESSAGE.eq(m.id))
                .first()
                .await
                .map_err(internal)?
                .ok_or_else(|| internal("pin vanished"))?;
            Ok((StatusCode::OK, Json(json!({ "message": p.message.id(), "pinned_by_label": p.pinned_by_label }))).into_response())
        }
    }
}

async fn unpin(who: Who, channel: i64, message: i64) -> Result<Response, ApiError> {
    let c = room(&who, channel).await?;
    writable(&c)?;
    let n = TaskflowMessagePin::objects()
        .filter(taskflow_message_pin::CHANNEL.eq(c.id) & taskflow_message_pin::MESSAGE.eq(message))
        .delete()
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "unpinned": n > 0 })).into_response())
}

// ---------------------------------------------------------------- reactions

/// `{ "<message id>": [{emoji, count, mine, by}] }` for `messages` in `channel`.
async fn summaries(channel: i64, messages: &[i64], me: &str) -> Result<BTreeMap<String, Vec<Value>>, ApiError> {
    let mut out: BTreeMap<String, Vec<Value>> = messages.iter().map(|m| (m.to_string(), Vec::new())).collect();
    if messages.is_empty() {
        return Ok(out);
    }
    let rows = TaskflowMessageReaction::objects()
        .filter(taskflow_message_reaction::CHANNEL.eq(channel) & taskflow_message_reaction::MESSAGE.in_(messages))
        .order_by(taskflow_message_reaction::ID.asc())
        .fetch()
        .await
        .map_err(internal)?;
    // message -> emoji (in first-reacted order) -> rows
    let mut grouped: BTreeMap<i64, Vec<(String, Vec<&TaskflowMessageReaction>)>> = BTreeMap::new();
    for r in &rows {
        let per = grouped.entry(r.message.id()).or_default();
        match per.iter_mut().find(|(e, _)| *e == r.emoji) {
            Some((_, v)) => v.push(r),
            None => per.push((r.emoji.clone(), vec![r])),
        }
    }
    for (m, per) in grouped {
        let list = per
            .into_iter()
            .map(|(emoji, rs)| {
                json!({
                    "emoji": emoji,
                    "count": rs.len(),
                    "mine": rs.iter().any(|r| r.reactor_key == me),
                    "by": rs.iter().take(5).map(|r| r.label.clone()).collect::<Vec<_>>(),
                })
            })
            .collect();
        out.insert(m.to_string(), list);
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReactInput {
    pub emoji: String,
}

async fn react(who: Who, channel: i64, message: i64, input: ReactInput) -> Result<Response, ApiError> {
    let c = room(&who, channel).await?;
    writable(&c)?;
    let m = message_in(c.id, message).await?;
    let emoji = input.emoji.trim().to_string();
    if !EMOJI.contains(&emoji.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unknown_emoji", "detail": "Not a reaction this room knows.", "allowed": EMOJI })),
        ));
    }
    let key = who.key();
    let existing = taskflow_message_reaction::MESSAGE.eq(m.id)
        & taskflow_message_reaction::EMOJI.eq(emoji.as_str())
        & taskflow_message_reaction::REACTOR_KEY.eq(key.as_str());
    let removed = TaskflowMessageReaction::objects().filter(existing).delete().await.map_err(internal)?;
    if removed == 0 {
        let label = who.label(c.project.id()).await?;
        let (user, agent) = match &who {
            Who::User(u) => (Some(ForeignKey::new(*u)), None),
            Who::Agent { id, .. } => (None, Some(ForeignKey::new(*id))),
        };
        // A concurrent identical toggle hits the unique index: the reaction
        // exists either way, which is what this click asked for.
        let created = TaskflowMessageReaction::objects()
            .create(TaskflowMessageReaction {
                id: 0,
                project: c.project.clone(),
                channel: ForeignKey::new(c.id),
                message: ForeignKey::new(m.id),
                emoji,
                reactor_key: key.clone(),
                user,
                agent,
                label,
                created_at: None,
            })
            .await;
        if let Err(e) = created {
            let s = e.to_string().to_lowercase();
            if !s.contains("unique") && !s.contains("duplicate") {
                tracing::warn!(error = %e, "reaction insert failed");
            }
        }
    }
    let mut s = summaries(c.id, &[m.id], &key).await?;
    Ok(Json(json!({ "message": m.id, "reactions": s.remove(&m.id.to_string()).unwrap_or_default() })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ReactionsQuery {
    pub messages: String,
}

async fn list_reactions(who: Who, channel: i64, q: ReactionsQuery) -> Result<Response, ApiError> {
    let c = room(&who, channel).await?;
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
    Ok(Json(summaries(c.id, &ids, &who.key()).await?).into_response())
}

// ---------------------------------------------------------------- handlers

fn agent(a: &crate::agent_auth::AgentIdentity) -> Who {
    Who::Agent { id: a.agent_id, project: a.project_id, label: a.display_name.clone() }
}

pub async fn user_list_pins(RequireAuth(u): RequireAuth<i64>, Path(c): Path<i64>) -> Result<Response, ApiError> {
    list_pins(Who::User(u), c).await
}
pub async fn user_pin(RequireAuth(u): RequireAuth<i64>, Path(c): Path<i64>, Json(i): Json<PinInput>) -> Result<Response, ApiError> {
    pin(Who::User(u), c, i).await
}
pub async fn user_unpin(RequireAuth(u): RequireAuth<i64>, Path((c, m)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    unpin(Who::User(u), c, m).await
}
pub async fn user_react(RequireAuth(u): RequireAuth<i64>, Path((c, m)): Path<(i64, i64)>, Json(i): Json<ReactInput>) -> Result<Response, ApiError> {
    react(Who::User(u), c, m, i).await
}
pub async fn user_reactions(RequireAuth(u): RequireAuth<i64>, Path(c): Path<i64>, Query(q): Query<ReactionsQuery>) -> Result<Response, ApiError> {
    list_reactions(Who::User(u), c, q).await
}

pub async fn agent_list_pins(RequireAgent(a): RequireAgent, Path(c): Path<i64>) -> Result<Response, ApiError> {
    list_pins(agent(&a), c).await
}
/// Agent writes need `chat:send` (#5962): a key that may not post may not pin,
/// unpin or react either. Reads stay open.
fn may_write(a: &crate::agent_auth::AgentIdentity) -> Result<(), ApiError> {
    a.require(crate::scopes::CHAT_SEND).map_err(|e| e.into_status_json())
}

pub async fn agent_pin(RequireAgent(a): RequireAgent, Path(c): Path<i64>, Json(i): Json<PinInput>) -> Result<Response, ApiError> {
    may_write(&a)?;
    pin(agent(&a), c, i).await
}
pub async fn agent_unpin(RequireAgent(a): RequireAgent, Path((c, m)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    may_write(&a)?;
    unpin(agent(&a), c, m).await
}
pub async fn agent_react(RequireAgent(a): RequireAgent, Path((c, m)): Path<(i64, i64)>, Json(i): Json<ReactInput>) -> Result<Response, ApiError> {
    may_write(&a)?;
    react(agent(&a), c, m, i).await
}
pub async fn agent_reactions(RequireAgent(a): RequireAgent, Path(c): Path<i64>, Query(q): Query<ReactionsQuery>) -> Result<Response, ApiError> {
    list_reactions(agent(&a), c, q).await
}
