//! #5983 item 5: following threads (chat-thread.html: "Following", "Threads
//! you follow", "2 new replies").
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `POST /api/taskflow/channels/{c}/threads/{root}/follow` | | 200 `{following: true}` |
//! | `DELETE /api/taskflow/channels/{c}/threads/{root}/follow` | | 200 `{following: false}` |
//! | `POST /api/taskflow/channels/{c}/threads/{root}/read` | `{last_read_reply}` | 200 `{last_read_reply}` |
//! | `GET /api/taskflow/projects/{p}/threads/following` | | 200 `[thread]` |
//!
//! * **Auto-follow:** posting a reply follows the thread (read up to that
//!   reply), and the first reply makes the root's sender follow it too
//!   ([`register`], on message `post_save`).
//! * The caller must see the room (a private room's roster); `root` must be a
//!   root of that room. Otherwise 404.
//! * The list drops follows of rooms the caller can no longer see.
//!   `new_replies` counts replies after `last_read_reply` not sent by the
//!   caller; `last_repliers` are up to three labels, newest first.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::scope::can_access_project;

use crate::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelMemberKind, TaskflowThreadFollow,
    taskflow_agent_channel, taskflow_agent_channel_member, taskflow_agent_message, taskflow_thread_follow,
};

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "thread follows failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

const EXCERPT: usize = 120;

fn excerpt(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT {
        return flat;
    }
    let mut s: String = flat.chars().take(EXCERPT - 1).collect();
    s.push('…');
    s
}

/// Follow `root` as `key` (idempotent). `read_to` moves the read mark only
/// forward.
async fn upsert(project: i64, channel: i64, root: i64, user: Option<i64>, agent: Option<i64>, read_to: Option<i64>) -> Result<(), sqlx::Error> {
    let key = match (user, agent) {
        (Some(u), _) => format!("user:{u}"),
        (None, Some(a)) => format!("agent:{a}"),
        _ => return Ok(()),
    };
    let existing = TaskflowThreadFollow::objects()
        .filter(taskflow_thread_follow::ROOT.eq(root) & taskflow_thread_follow::FOLLOWER_KEY.eq(key.as_str()))
        .first()
        .await?;
    match existing {
        Some(f) => {
            if let Some(r) = read_to {
                if f.last_read_reply.is_none_or(|cur| cur < r) {
                    let mut v = serde_json::Map::new();
                    v.insert("last_read_reply".into(), json!(r));
                    TaskflowThreadFollow::objects()
                        .filter(
                            taskflow_thread_follow::ID.eq(f.id)
                                & (taskflow_thread_follow::LAST_READ_REPLY.is_null() | taskflow_thread_follow::LAST_READ_REPLY.lt(r)),
                        )
                        .update_values(v)
                        .await
                        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
                }
            }
        }
        None => {
            // A concurrent follow hits the unique index; the follow exists either way.
            let _ = TaskflowThreadFollow::objects()
                .create(TaskflowThreadFollow {
                    id: 0,
                    project: ForeignKey::new(project),
                    channel: ForeignKey::new(channel),
                    root: ForeignKey::new(root),
                    follower_key: key,
                    user: user.map(ForeignKey::new),
                    agent: agent.map(ForeignKey::new),
                    last_read_reply: read_to,
                    created_at: None,
                })
                .await;
        }
    }
    Ok(())
}

fn sender(kind: &str, user: Option<i64>, agent: Option<i64>) -> (Option<i64>, Option<i64>) {
    match kind {
        "user" => (user, None),
        "agent" => (None, agent),
        _ => (None, None),
    }
}

/// Auto-follow on a new reply: the replier (read up to it) and the root's
/// sender. Called once from `on_ready`.
pub fn register() {
    umbral::signals::subscribe_async("post_save:taskflow_agent_message", |p| {
        let created = p["created"].as_bool().unwrap_or(false);
        let i = &p["instance"];
        let root = i["thread_root"].as_i64();
        let id = i["id"].as_i64();
        let channel = i["channel"].as_i64();
        let project = i["project"].as_i64();
        let (user, agent) = sender(i["sender_kind"].as_str().unwrap_or(""), i["sender_user"].as_i64(), i["sender_agent"].as_i64());
        async move {
            let (Some(root), Some(id), Some(channel), Some(project), true) = (root, id, channel, project, created) else { return };
            if let Err(e) = upsert(project, channel, root, user, agent, Some(id)).await {
                tracing::warn!(error = %e, "auto-follow (replier) failed");
            }
            if let Ok(Some(r)) = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(root)).first().await {
                let kind = serde_json::to_value(r.sender_kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                let (u, a) = sender(&kind, r.sender_user.map(|x| x.id()), r.sender_agent.map(|x| x.id()));
                if let Err(e) = upsert(project, channel, root, u, a, None).await {
                    tracing::warn!(error = %e, "auto-follow (root sender) failed");
                }
            }
        }
    });
}

/// The room and root, if `user` can see the room and `root` is one of its roots.
async fn visible_root(user: i64, channel: i64, root: i64) -> Result<(TaskflowAgentChannel, TaskflowAgentMessage), ApiError> {
    let c = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found"))?;
    let m = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(root) & taskflow_agent_message::CHANNEL.eq(c.id))
        .first()
        .await
        .map_err(internal)?
        .filter(|m| m.thread_root.is_none())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    Ok((c, m))
}

/// `POST /api/taskflow/channels/{c}/threads/{root}/follow`
pub async fn follow(RequireAuth(user): RequireAuth<i64>, Path((channel, root)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    let (c, m) = visible_root(user, channel, root).await?;
    upsert(c.project.id(), c.id, m.id, Some(user), None, None).await.map_err(internal)?;
    Ok(Json(json!({ "following": true })).into_response())
}

/// `DELETE /api/taskflow/channels/{c}/threads/{root}/follow`
pub async fn unfollow(RequireAuth(user): RequireAuth<i64>, Path((channel, root)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    let (_, m) = visible_root(user, channel, root).await?;
    TaskflowThreadFollow::objects()
        .filter(taskflow_thread_follow::ROOT.eq(m.id) & taskflow_thread_follow::FOLLOWER_KEY.eq(format!("user:{user}")))
        .delete()
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "following": false })).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadInput {
    pub last_read_reply: i64,
}

/// `POST /api/taskflow/channels/{c}/threads/{root}/read`
pub async fn mark_read(RequireAuth(user): RequireAuth<i64>, Path((channel, root)): Path<(i64, i64)>, Json(i): Json<ReadInput>) -> Result<Response, ApiError> {
    let (c, m) = visible_root(user, channel, root).await?;
    let ok = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(i.last_read_reply) & taskflow_agent_message::THREAD_ROOT.eq(m.id))
        .first()
        .await
        .map_err(internal)?
        .is_some();
    if !ok {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "detail": "Not a reply in this thread." }))));
    }
    upsert(c.project.id(), c.id, m.id, Some(user), None, Some(i.last_read_reply)).await.map_err(internal)?;
    Ok(Json(json!({ "last_read_reply": i.last_read_reply })).into_response())
}

/// `GET /api/taskflow/projects/{project}/threads/following`
pub async fn following(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Result<Response, ApiError> {
    if !can_access_project(user, project).await {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    let follows = TaskflowThreadFollow::objects()
        .filter(taskflow_thread_follow::PROJECT.eq(project) & taskflow_thread_follow::FOLLOWER_KEY.eq(format!("user:{user}")))
        .fetch()
        .await
        .map_err(internal)?;
    let mine: std::collections::HashSet<i64> = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::USER.eq(user))
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .map(|m| m.channel.id())
        .collect();
    let mut out: Vec<(Option<chrono::DateTime<chrono::Utc>>, Value)> = Vec::new();
    for f in follows {
        let Ok(Some(c)) = TaskflowAgentChannel::objects().filter(taskflow_agent_channel::ID.eq(f.channel.id())).first().await else { continue };
        if c.kind.is_private() && !mine.contains(&c.id) {
            continue;
        }
        let Ok(Some(root)) = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(f.root.id())).first().await else { continue };
        let mut replies = TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::THREAD_ROOT.eq(root.id))
            .order_by(taskflow_agent_message::ID.desc())
            .fetch()
            .await
            .map_err(internal)?;
        replies.sort_by(|a, b| b.id.cmp(&a.id));
        let read = f.last_read_reply.unwrap_or(0);
        let new = replies
            .iter()
            .filter(|r| r.id > read)
            .filter(|r| !(r.sender_kind == TaskflowChannelMemberKind::User && r.sender_user.as_ref().map(|u| u.id()) == Some(user)))
            .count();
        let mut repliers: Vec<String> = Vec::new();
        for r in &replies {
            if !repliers.contains(&r.sender_label) {
                repliers.push(r.sender_label.clone());
            }
            if repliers.len() == 3 {
                break;
            }
        }
        let last = replies.first().and_then(|r| r.created_at);
        out.push((
            last.or(root.created_at),
            json!({
                "channel": c.id,
                "root": root.id,
                "excerpt": excerpt(&root.body_markdown),
                "replies": replies.len(),
                "new_replies": new,
                "last_reply_at": last,
                "last_repliers": repliers,
            }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(Json(out.into_iter().map(|(_, v)| v).collect::<Vec<_>>()).into_response())
}

/// For the thread summaries: does `user` follow each of `roots`?
pub async fn followed_by(user: i64, roots: &[i64]) -> std::collections::HashSet<i64> {
    if roots.is_empty() {
        return Default::default();
    }
    TaskflowThreadFollow::objects()
        .filter(taskflow_thread_follow::ROOT.in_(roots) & taskflow_thread_follow::FOLLOWER_KEY.eq(format!("user:{user}")))
        .fetch()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|f| f.root.id())
        .collect()
}
