//! #5983 item 4: per-room unread and mention counts, for the chat list's
//! Unread / Mentions tabs and the `@3` badge.
//!
//! `GET /api/taskflow/projects/{p}/channels/summary` (people) and
//! `GET /api/taskflow/agents/channels/summary` (agents) return, for every room
//! the caller can see (a private room only on its roster):
//!
//! `[{channel, is_design, archived, unread, mentions, last: {id, excerpt, sender_label, created_at} | null}]`
//! (every visible room, the design room and archived rooms included; the
//! client decides what to show). `excerpt` is plain text, at most 140
//! characters, with mention chips reduced to `@Name`.
//!
//! * `unread`: in-channel messages after the caller's read cursor, not sent by
//!   the caller.
//! * `mentions`: those unread messages that TARGET the caller (`targets`
//!   holds `{kind, id}` for them) or mention them in the body
//!   (`](user:<id>)` / `](agent:<id>)`, how chips are written). Counted over
//!   the newest [`MENTION_SCAN`] unread messages of a room.
//!
//! People who aren't in the project get 404.

use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::scope::can_access_project;

use crate::agent_auth::RequireAgent;
use crate::models::{
    MessageTarget, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelMemberKind,
    TaskflowChannelReadCursor, taskflow_agent_channel, taskflow_agent_channel_member, taskflow_agent_message,
    taskflow_channel_read_cursor,
};

pub const MAX_ROOMS: usize = 200;
pub const MENTION_SCAN: u64 = 500;
const EXCERPT: usize = 140;

type ApiError = (StatusCode, Json<Value>);

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "channel summary failed");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal" })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn chips_become_names() {
        assert_eq!(super::strip_chips("hi [@Ann](user:3) and [@Bot](agent:12)!"), "hi @Ann and @Bot!");
        assert_eq!(super::strip_chips("not [@x](http://a) or [@y"), "not [@x](http://a) or [@y");
        assert_eq!(super::strip_chips("[@Board](page:/board)"), "@Board");
    }
}

#[derive(Clone, Copy)]
enum Me {
    User(i64),
    Agent(i64),
}

impl Me {
    fn kind(self) -> &'static str {
        match self {
            Me::User(_) => "user",
            Me::Agent(_) => "agent",
        }
    }
    fn id(self) -> i64 {
        match self {
            Me::User(i) | Me::Agent(i) => i,
        }
    }
    fn sent(self, m: &TaskflowAgentMessage) -> bool {
        match self {
            Me::User(u) => m.sender_kind == TaskflowChannelMemberKind::User && m.sender_user.as_ref().map(|x| x.id()) == Some(u),
            Me::Agent(a) => m.sender_kind == TaskflowChannelMemberKind::Agent && m.sender_agent.as_ref().map(|x| x.id()) == Some(a),
        }
    }
    fn mentioned(self, m: &TaskflowAgentMessage) -> bool {
        let chip = format!("]({}:{})", self.kind(), self.id());
        if m.body_markdown.contains(&chip) {
            return true;
        }
        let targets: Vec<MessageTarget> = m.targets.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
        if targets.iter().any(|t| t.kind == self.kind() && t.id == self.id()) {
            return true;
        }
        matches!(self, Me::Agent(a) if m.target_agent.as_ref().map(|x| x.id()) == Some(a))
    }
}

/// `[@Name](user:3)` / `[@Name](agent:5)` → `@Name`, so the list never shows
/// raw chip markup (#5984).
pub fn strip_chips(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("[@") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let chip = tail.find("](").and_then(|close| {
            let after = &tail[close + 2..];
            let end = after.find(')')?;
            let target = &after[..end];
            let (kind, id) = target.split_once(':')?;
            let ok = matches!(kind, "user" | "agent" | "page") && !id.is_empty();
            ok.then(|| (tail[1..close].to_string(), close + 2 + end + 1))
        });
        match chip {
            Some((name, len)) => {
                out.push_str(&name);
                rest = &tail[len..];
            }
            None => {
                out.push_str("[@");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn excerpt(body: &str) -> String {
    let body = strip_chips(body);
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT {
        return flat;
    }
    let mut s: String = flat.chars().take(EXCERPT - 1).collect();
    s.push('…');
    s
}

/// The rooms of `project` that `me` can see, oldest first.
async fn rooms(project: i64, me: Me) -> Result<Vec<TaskflowAgentChannel>, ApiError> {
    let roster = match me {
        Me::User(u) => taskflow_agent_channel_member::USER.eq(u),
        Me::Agent(a) => taskflow_agent_channel_member::AGENT.eq(a),
    };
    let mine: std::collections::HashSet<i64> = TaskflowAgentChannelMember::objects()
        .filter(roster)
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .map(|m| m.channel.id())
        .collect();
    Ok(TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project))
        .order_by(taskflow_agent_channel::ID.asc())
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|c| !c.kind.is_private() || mine.contains(&c.id))
        .take(MAX_ROOMS)
        .collect())
}

async fn summarise(project: i64, me: Me) -> Result<Vec<Value>, ApiError> {
    let rooms = rooms(project, me).await?;
    let cursor_of = match me {
        Me::User(u) => taskflow_channel_read_cursor::MEMBER_USER.eq(u),
        Me::Agent(a) => taskflow_channel_read_cursor::MEMBER_AGENT.eq(a),
    };
    let cursors: std::collections::HashMap<i64, i64> = TaskflowChannelReadCursor::objects()
        .filter(taskflow_channel_read_cursor::PROJECT.eq(project) & cursor_of)
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .map(|c| (c.channel.id(), c.last_read_message.map(|m| m.id()).unwrap_or(0)))
        .collect();
    let mut out = Vec::with_capacity(rooms.len());
    for room in rooms {
        let after = cursors.get(&room.id).copied().unwrap_or(0);
        let base = taskflow_agent_message::CHANNEL.eq(room.id) & taskflow_agent_message::IN_CHANNEL.eq(true);
        let last = TaskflowAgentMessage::objects()
            .filter(base.clone())
            .order_by(taskflow_agent_message::ID.desc())
            .first()
            .await
            .map_err(internal)?;
        let unread_rows = TaskflowAgentMessage::objects()
            .filter(base & taskflow_agent_message::ID.gt(after))
            .order_by(taskflow_agent_message::ID.desc())
            .limit(MENTION_SCAN)
            .fetch()
            .await
            .map_err(internal)?;
        let theirs: Vec<&TaskflowAgentMessage> = unread_rows.iter().filter(|m| !me.sent(m)).collect();
        let mentions = theirs.iter().filter(|m| me.mentioned(m)).count();
        // Past the scan window, count the rest without loading them.
        let mut unread = theirs.len() as i64;
        if unread_rows.len() as u64 == MENTION_SCAN {
            let oldest = unread_rows.last().map(|m| m.id).unwrap_or(after);
            unread += TaskflowAgentMessage::objects()
                .filter(
                    taskflow_agent_message::CHANNEL.eq(room.id)
                        & taskflow_agent_message::IN_CHANNEL.eq(true)
                        & taskflow_agent_message::ID.gt(after)
                        & taskflow_agent_message::ID.lt(oldest),
                )
                .count()
                .await
                .map_err(internal)?;
        }
        out.push(json!({
            "channel": room.id,
            "is_design": room.is_design,
            "archived": room.archived,
            "unread": unread,
            "mentions": mentions,
            "last": last.map(|m| json!({
                "id": m.id,
                "excerpt": excerpt(&m.body_markdown),
                "sender_label": m.sender_label,
                "created_at": m.created_at,
            })),
        }));
    }
    Ok(out)
}

/// `GET /api/taskflow/projects/{project}/channels/summary`
pub async fn for_user(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Result<Response, ApiError> {
    if !can_access_project(user, project).await {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))));
    }
    Ok(Json(summarise(project, Me::User(user)).await?).into_response())
}

/// `GET /api/taskflow/agents/channels/summary`
pub async fn for_agent(RequireAgent(a): RequireAgent) -> Result<Response, ApiError> {
    Ok(Json(summarise(a.project_id, Me::Agent(a.agent_id)).await?).into_response())
}
