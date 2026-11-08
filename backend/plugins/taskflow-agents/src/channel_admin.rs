//! #5918/#5924: room administration, for the chat details panel.
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `PATCH /api/taskflow/channels/{c}` | `{title?, topic?}` (`topic: null` clears) | 200 channel |
//! | `DELETE /api/taskflow/channels/{c}/members/{member}` | | 200 `{removed}` |
//! | `POST /api/taskflow/channels/{c}/archive` | | 200 channel |
//! | `POST /api/taskflow/channels/{c}/unarchive` | | 200 channel |
//!
//! **Who manages a room:** a project owner/admin (a superuser counts), or the
//! room's creator (the person, or the linked human of the agent that made it)
//! while still an active member and, for a private Group, still on its roster.
//! Anyone may remove THEMSELVES (leave). A caller who can't see the room gets
//! 404, one who can but may not change it 403.
//!
//! **Rooms that can't be changed:** a DM has no settings (400 `direct_room`).
//! The project's shared rooms (the public room, the design room, any `project`
//! kind) keep their title and roster and can't be archived (409 `fixed_room`);
//! their topic can change. Changes to an archived room 409 `archived`, except
//! unarchiving (and leaving).
//!
//! Title: 1-80 characters, whitespace collapsed, unique among the project's
//! non-DM rooms ignoring case (409 `title_taken`). Topic: at most 280. The
//! last person can't leave a Group (409 `last_human`); removals take a
//! `FOR UPDATE SKIP LOCKED` lock on the room row (409 `busy`), so two leaves
//! at once can't empty it.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};

use crate::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind, taskflow_agent,
    taskflow_agent_channel, taskflow_agent_channel_member,
};

pub const MAX_TITLE: usize = 80;
pub const MAX_TOPIC: usize = 280;
const BUSY: &str = "taskflow:channel_busy";
const LAST_HUMAN: &str = "taskflow:last_human";

type ApiError = (StatusCode, Json<Value>);
type TxError = Box<dyn std::error::Error + Send + Sync>;

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "channel admin failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "not_found", "No such room.")
}

/// A room shared by the whole project: its title and roster are fixed.
pub fn is_fixed(c: &TaskflowAgentChannel) -> bool {
    c.is_public || c.is_design || c.kind == TaskflowChannelKind::Project
}

/// What the caller is to the room.
struct Caller {
    channel: TaskflowAgentChannel,
    manager: bool,
}

async fn on_roster(channel: i64, user: i64) -> Result<bool, ApiError> {
    Ok(TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::CHANNEL.eq(channel) & taskflow_agent_channel_member::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
        .is_some())
}

/// Load the room and work out what `user` may do. 404 when they can't see it.
async fn caller(user: i64, channel: i64) -> Result<Caller, ApiError> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let project = channel.project.id();
    let member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(internal)?;
    let superuser = AuthUser::objects().filter(auth_user::ID.eq(user)).first().await.map_err(internal)?.is_some_and(|u| u.is_superuser);
    if member.is_none() && !superuser {
        return Err(not_found());
    }
    let admin = superuser || member.as_ref().is_some_and(|m| matches!(m.role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin));
    let rostered = on_roster(channel.id, user).await?;
    // A private room is invisible off its roster, except a Group to an admin
    // (who may manage its roster, #5925). A DM is never an admin's.
    let visible = !channel.kind.is_private() || rostered || (admin && channel.kind == TaskflowChannelKind::Group);
    if !visible {
        return Err(not_found());
    }
    let created_by_agent_human = match channel.created_by_agent.as_ref() {
        Some(a) => TaskflowAgent::objects()
            .filter(taskflow_agent::ID.eq(a.id()))
            .first()
            .await
            .map_err(internal)?
            .and_then(|a| a.linked_by.map(|u| u.id())),
        None => None,
    };
    let creator = channel.created_by_user.as_ref().map(|u| u.id()) == Some(user) || created_by_agent_human == Some(user);
    let manager = admin || (creator && (!channel.kind.is_private() || rostered));
    Ok(Caller { channel, manager })
}

fn require_manager(c: &Caller) -> Result<(), ApiError> {
    if c.channel.kind == TaskflowChannelKind::Direct {
        return Err(err(StatusCode::BAD_REQUEST, "direct_room", "A direct message has no room settings."));
    }
    if !c.manager {
        return Err(err(StatusCode::FORBIDDEN, "not_allowed", "Only the room's creator or a project owner or admin can change this."));
    }
    Ok(())
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn reload(id: i64) -> Result<TaskflowAgentChannel, ApiError> {
    TaskflowAgentChannel::objects().filter(taskflow_agent_channel::ID.eq(id)).first().await.map_err(internal)?.ok_or_else(not_found)
}

/// Absent → `None`; `null` → `Some(None)`; a value → `Some(Some(v))`.
fn double_option<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub topic: Option<Option<String>>,
}

/// `PATCH /api/taskflow/channels/{channel}`
pub async fn patch(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Json(input): Json<PatchInput>) -> Result<Response, ApiError> {
    let c = caller(user, channel).await?;
    require_manager(&c)?;
    if c.channel.archived {
        return Err(err(StatusCode::CONFLICT, "archived", "This room is archived. Unarchive it first."));
    }
    let mut v = serde_json::Map::new();
    if let Some(t) = input.title {
        let t = collapse(&t);
        if t != c.channel.title {
            if is_fixed(&c.channel) {
                return Err(err(StatusCode::CONFLICT, "fixed_room", "The project's shared rooms keep their name."));
            }
            if t.is_empty() || t.chars().count() > MAX_TITLE || t.chars().any(char::is_control) {
                return Err(err(StatusCode::BAD_REQUEST, "invalid", "A room name is 1-80 characters."));
            }
            let want = t.to_lowercase();
            let taken = TaskflowAgentChannel::objects()
                .filter(taskflow_agent_channel::PROJECT.eq(c.channel.project.id()))
                .fetch()
                .await
                .map_err(internal)?
                .into_iter()
                .any(|o| o.id != c.channel.id && o.kind != TaskflowChannelKind::Direct && collapse(&o.title).to_lowercase() == want);
            if taken {
                return Err(err(StatusCode::CONFLICT, "title_taken", "Another room in this project already has that name."));
            }
            v.insert("title".into(), json!(t));
        }
    }
    if let Some(topic) = input.topic {
        let topic = topic.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if topic.as_ref().is_some_and(|s| s.chars().count() > MAX_TOPIC) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", "A topic is at most 280 characters."));
        }
        if topic != c.channel.topic {
            v.insert("topic".into(), json!(topic));
        }
    }
    if v.is_empty() {
        return Ok(Json(c.channel).into_response());
    }
    TaskflowAgentChannel::objects().filter(taskflow_agent_channel::ID.eq(channel)).update_values(v).await.map_err(internal)?;
    let fresh = reload(channel).await?;
    crate::emit::emit_post_save(&fresh).await;
    Ok(Json(fresh).into_response())
}

async fn set_archived(user: i64, channel: i64, archived: bool) -> Result<Response, ApiError> {
    let c = caller(user, channel).await?;
    require_manager(&c)?;
    if is_fixed(&c.channel) {
        return Err(err(StatusCode::CONFLICT, "fixed_room", "The project's shared rooms can't be archived."));
    }
    if c.channel.archived == archived {
        return Ok(Json(c.channel).into_response());
    }
    let mut v = serde_json::Map::new();
    v.insert("archived".into(), json!(archived));
    TaskflowAgentChannel::objects().filter(taskflow_agent_channel::ID.eq(channel)).update_values(v).await.map_err(internal)?;
    let fresh = reload(channel).await?;
    crate::emit::emit_post_save(&fresh).await;
    Ok(Json(fresh).into_response())
}

/// `POST /api/taskflow/channels/{channel}/archive`
pub async fn archive(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>) -> Result<Response, ApiError> {
    set_archived(user, channel, true).await
}

/// `POST /api/taskflow/channels/{channel}/unarchive`
pub async fn unarchive(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>) -> Result<Response, ApiError> {
    set_archived(user, channel, false).await
}

/// `DELETE /api/taskflow/channels/{channel}/members/{member}`
pub async fn remove_member(RequireAuth(user): RequireAuth<i64>, Path((channel, member)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    let c = caller(user, channel).await?;
    if c.channel.kind == TaskflowChannelKind::Direct {
        return Err(err(StatusCode::BAD_REQUEST, "direct_room", "A direct message has no room settings."));
    }
    if is_fixed(&c.channel) {
        return Err(err(StatusCode::CONFLICT, "fixed_room", "Everyone in the project is in its shared rooms."));
    }
    let row = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::ID.eq(member) & taskflow_agent_channel_member::CHANNEL.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "They aren't in this room."))?;
    let is_self = row.user.as_ref().map(|u| u.id()) == Some(user);
    if !is_self && !c.manager {
        return Err(err(StatusCode::FORBIDDEN, "not_allowed", "Only the room's creator or a project owner or admin can remove people."));
    }
    let is_person = row.user.is_some();
    let res = umbral::transaction(move |tx| {
        Box::pin(async move {
            let locked = TaskflowAgentChannel::objects()
                .filter(taskflow_agent_channel::ID.eq(channel))
                .for_update_skip_locked()
                .on_tx(tx)
                .first()
                .await?;
            if locked.is_none() {
                return Err::<(), TxError>(BUSY.into());
            }
            if is_person {
                let people = TaskflowAgentChannelMember::objects()
                    .filter(taskflow_agent_channel_member::CHANNEL.eq(channel))
                    .on_tx(tx)
                    .fetch()
                    .await?
                    .into_iter()
                    .filter(|r| r.user.is_some())
                    .count();
                if people <= 1 {
                    return Err(LAST_HUMAN.into());
                }
            }
            TaskflowAgentChannelMember::objects().filter(taskflow_agent_channel_member::ID.eq(member)).on_tx(tx).delete().await?;
            Ok(())
        })
    })
    .await;
    if let Err(e) = res {
        let s = e.to_string();
        return Err(if s.contains(LAST_HUMAN) {
            err(StatusCode::CONFLICT, "last_human", "A group needs at least one person in it, so the last one can't leave.")
        } else if s.contains(BUSY) {
            err(StatusCode::CONFLICT, "busy", "The room is being changed right now; try again in a moment.")
        } else {
            internal(e)
        });
    }
    Ok(Json(json!({ "removed": member })).into_response())
}
