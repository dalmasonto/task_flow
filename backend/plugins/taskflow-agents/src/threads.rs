//! Chat threads: replies that live under one root message, Slack-style.
//!
//! - A thread reply names its `thread_root`: a message in the SAME channel
//!   whose own `thread_root` is null. Threads are one level deep, so a reply
//!   to a reply is a 400, as is a root in another channel.
//! - `in_channel` is derived at create: false for a thread-only reply, true
//!   for every ordinary message and for a reply sent with `also_send`. The
//!   channel feed pages on `?in_channel=true`.
//! - A thread reply's `targets` are computed here and never empty: the root's
//!   author, everyone who already replied, and whoever the sender @-mentioned
//!   or named, kept only if they can see the channel. When nobody else
//!   qualifies, the sender alone (so an empty list never means "broadcast" for
//!   a thread reply). The MCP delivers a thread-only reply only to its agent
//!   targets, and `check_messages` filters the same way.

use std::collections::BTreeSet;

use serde_json::{Value, json};
use umbral::web::StatusCode;

use crate::models::{
    MessageTarget, TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage,
    TaskflowChannelKind, TaskflowChannelMemberKind, taskflow_agent, taskflow_agent_channel_member,
    taskflow_agent_message,
};

/// Hard cap on replies one thread read returns.
pub const MAX_THREAD_REPLIES: u64 = 500;
/// Hard cap on roots one summary request may ask about.
pub const MAX_SUMMARY_ROOTS: usize = 200;

fn internal<E>(_: E) -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}

/// Where a new message goes: its thread (if any) and whether the feed shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub thread_root: Option<i64>,
    pub in_channel: bool,
}

/// Who is sending, for target computation (the sender is excluded unless it
/// is the only participant).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    User(i64),
    Agent(i64),
}

impl Sender {
    fn target(self) -> MessageTarget {
        match self {
            Sender::User(id) => MessageTarget { kind: "user".into(), id },
            Sender::Agent(id) => MessageTarget { kind: "agent".into(), id },
        }
    }
}

/// Check the thread root and derive the placement. No root: an ordinary
/// message (`also_send` is meaningless and ignored). Checked after the
/// caller's membership, so a non-member cannot probe ids.
pub async fn placement(channel_id: i64, thread_root: Option<i64>, also_send: bool) -> Result<Placement, StatusCode> {
    let Some(root) = thread_root else {
        return Ok(Placement { thread_root: None, in_channel: true });
    };
    let found = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(root) & taskflow_agent_message::CHANNEL.eq(channel_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    if found.thread_root.is_some() {
        return Err(StatusCode::BAD_REQUEST); // one level deep: answer the root
    }
    Ok(Placement { thread_root: Some(root), in_channel: also_send })
}

/// `[@Name](agent:5)` / `[@Name](user:7)` chips in a body.
pub fn mentions_in(body: &str) -> Vec<MessageTarget> {
    let mut out = Vec::new();
    for (kind, tag) in [("agent", "](agent:"), ("user", "](user:")] {
        let mut rest = body;
        while let Some(at) = rest.find(tag) {
            rest = &rest[at + tag.len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() && rest[digits.len()..].starts_with(')') {
                if let Ok(id) = digits.parse() {
                    out.push(MessageTarget { kind: kind.into(), id });
                }
            }
        }
    }
    out
}

fn author_of(m: &TaskflowAgentMessage) -> Option<MessageTarget> {
    match m.sender_kind {
        TaskflowChannelMemberKind::Agent => m.sender_agent.as_ref().map(|a| MessageTarget { kind: "agent".into(), id: a.id() }),
        _ => m.sender_user.as_ref().map(|u| MessageTarget { kind: "user".into(), id: u.id() }),
    }
}

/// Can this target see the channel? The same rules as the read paths: an
/// agent of the channel's project (on the roster, for a DM); a person on the
/// roster, or (for a shared room) a member of the project.
async fn can_see(channel: &TaskflowAgentChannel, t: &MessageTarget) -> Result<bool, StatusCode> {
    let private = matches!(channel.kind, TaskflowChannelKind::Direct | TaskflowChannelKind::Group);
    match t.kind.as_str() {
        "agent" => {
            let roster = TaskflowAgentChannelMember::objects()
                .filter(taskflow_agent_channel_member::CHANNEL.eq(channel.id) & taskflow_agent_channel_member::AGENT.eq(t.id))
                .first()
                .await
                .map_err(internal)?
                .is_some();
            if roster {
                return Ok(true);
            }
            if channel.kind.is_private() {
                return Ok(false);
            }
            Ok(TaskflowAgent::objects()
                .filter(taskflow_agent::ID.eq(t.id) & taskflow_agent::PROJECT.eq(channel.project.id()))
                .first()
                .await
                .map_err(internal)?
                .is_some())
        }
        "user" => {
            if !taskflow_projects::scope::can_access_project(t.id, channel.project.id()).await {
                return Ok(false);
            }
            if !private {
                return Ok(true);
            }
            Ok(TaskflowAgentChannelMember::objects()
                .filter(taskflow_agent_channel_member::CHANNEL.eq(channel.id) & taskflow_agent_channel_member::USER.eq(t.id))
                .first()
                .await
                .map_err(internal)?
                .is_some())
        }
        _ => Ok(false),
    }
}

/// The targets of a thread reply (see the module docs). `named` is what the
/// client sent as `targets` (people only) plus the body's mention chips.
pub async fn thread_targets(
    channel: &TaskflowAgentChannel,
    root: i64,
    sender: Sender,
    named: Vec<MessageTarget>,
) -> Result<Vec<MessageTarget>, StatusCode> {
    let root_row = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(root))
        .first()
        .await
        .map_err(internal)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    let replies = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::THREAD_ROOT.eq(root))
        .order_by(taskflow_agent_message::ID.asc())
        .limit(MAX_THREAD_REPLIES)
        .fetch()
        .await
        .map_err(internal)?;

    let me = sender.target();
    let mut seen: BTreeSet<(String, i64)> = BTreeSet::new();
    let mut out = Vec::new();
    let candidates = author_of(&root_row)
        .into_iter()
        .chain(replies.iter().filter_map(author_of))
        .chain(named.into_iter().filter(|t| t.kind == "agent" || t.kind == "user"));
    for t in candidates {
        if t == me || !seen.insert((t.kind.clone(), t.id)) {
            continue;
        }
        if can_see(channel, &t).await? {
            out.push(t);
        }
    }
    if out.is_empty() {
        out.push(me);
    }
    Ok(out)
}

/// The exact JSON one agent target serializes to inside `targets`, for the
/// `check_messages` filter. Thread replies' targets are always written by
/// `serde_json::to_string(&Vec<MessageTarget>)`, so this substring is exact.
pub fn agent_target_needle(agent_id: i64) -> String {
    serde_json::to_string(&MessageTarget { kind: "agent".into(), id: agent_id }).unwrap_or_default()
}

/// May this agent read this message on the agent read paths? Everything in
/// the channel, plus a thread-only reply it is a target of (or sent).
pub fn agent_may_read(m: &TaskflowAgentMessage, agent_id: i64) -> bool {
    if m.in_channel || m.sender_agent.as_ref().map(|a| a.id()) == Some(agent_id) {
        return true;
    }
    m.targets.as_deref().is_some_and(|t| t.contains(&agent_target_needle(agent_id)))
}

/// A root was deleted (only the admin UI deletes one message; a channel or
/// project delete cascades every row). Its replies would be orphans: hidden
/// from the feed with no thread to open. Release them into the channel as
/// ordinary messages instead of deleting them, so one admin click never
/// destroys other people's words. Column update only (never a whole-row save).
pub async fn release_replies_of(roots: &[i64]) {
    if roots.is_empty() {
        return;
    }
    let mut v = serde_json::Map::new();
    v.insert("thread_root".into(), Value::Null);
    v.insert("in_channel".into(), json!(true));
    if let Err(e) = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::THREAD_ROOT.in_(roots))
        .update_values(v)
        .await
    {
        tracing::error!(?roots, error = %e, "deleted thread root: could not release its replies");
    }
}

/// One thread: the root, its replies in order, and the count.
pub async fn thread_rows(channel_id: i64, root: i64) -> Result<(TaskflowAgentMessage, Vec<TaskflowAgentMessage>), StatusCode> {
    let root_row = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(root) & taskflow_agent_message::CHANNEL.eq(channel_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if root_row.thread_root.is_some() {
        return Err(StatusCode::NOT_FOUND); // not a root
    }
    let replies = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::THREAD_ROOT.eq(root) & taskflow_agent_message::CHANNEL.eq(channel_id))
        .order_by(taskflow_agent_message::ID.asc())
        .limit(MAX_THREAD_REPLIES)
        .fetch()
        .await
        .map_err(internal)?;
    Ok((root_row, replies))
}

/// Parse `?roots=1,2,3`: positive ids, deduplicated, capped.
pub fn parse_roots(raw: &str) -> Result<Vec<i64>, StatusCode> {
    let mut ids: BTreeSet<i64> = BTreeSet::new();
    for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let id: i64 = part.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
        if id <= 0 {
            return Err(StatusCode::BAD_REQUEST);
        }
        ids.insert(id);
    }
    if ids.len() > MAX_SUMMARY_ROOTS {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(ids.into_iter().collect())
}

/// `{"<root id>": {"reply_count", "last_reply_at"}}` for the roots in this
/// channel that have replies, in ONE query. Roots with no replies are absent.
pub async fn summaries(channel_id: i64, roots: &[i64]) -> Result<Value, StatusCode> {
    if roots.is_empty() {
        return Ok(json!({}));
    }
    let replies = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(channel_id) & taskflow_agent_message::THREAD_ROOT.in_(roots))
        .fetch()
        .await
        .map_err(internal)?;
    let mut agg: std::collections::BTreeMap<i64, (i64, Option<chrono::DateTime<chrono::Utc>>)> = Default::default();
    for r in &replies {
        let Some(root) = r.thread_root else { continue };
        let e = agg.entry(root).or_insert((0, None));
        e.0 += 1;
        e.1 = e.1.max(r.created_at);
    }
    let out: serde_json::Map<String, Value> = agg
        .into_iter()
        .map(|(root, (n, last))| (root.to_string(), json!({ "reply_count": n, "last_reply_at": last })))
        .collect();
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

use serde::Deserialize;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response};
use umbral_auth::RequireAuth;

use crate::agent_auth::RequireAgent;
use crate::models::taskflow_agent_channel;

async fn thread_response(channel_id: i64, root: i64) -> Result<Response, StatusCode> {
    let (root_row, replies) = thread_rows(channel_id, root).await?;
    let mut all = vec![root_row];
    let count = replies.len();
    all.extend(replies);
    let mut rows = crate::views::messages_json(&all).await?;
    let root_json = rows.remove(0);
    Ok(Json(json!({ "root": root_json, "replies": rows, "reply_count": count })).into_response())
}

/// `GET /api/taskflow/channels/{channel}/messages/{message}/thread` (a person
/// who can see the channel): `{root, replies, reply_count}`. 404 for a
/// channel the caller cannot see, an unknown id, or a non-root.
pub async fn get_thread(RequireAuth(user): RequireAuth<i64>, Path((channel, message)): Path<(i64, i64)>) -> Result<Response, StatusCode> {
    let channel = crate::views::ensure_channel_visible(user, channel).await?;
    thread_response(channel.id, message).await
}

/// `GET /api/taskflow/agents/channels/{channel}/messages/{message}/thread`
/// (an agent who can see the channel). Same shape.
pub async fn agent_get_thread(RequireAgent(agent): RequireAgent, Path((channel, message)): Path<(i64, i64)>) -> Result<Response, StatusCode> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if !crate::views::agent_can_see_channel(&channel, agent.agent_id, agent.project_id).await? {
        return Err(StatusCode::NOT_FOUND);
    }
    thread_response(channel.id, message).await
}

#[derive(Debug, Deserialize)]
pub struct SummaryQuery {
    #[serde(default)]
    pub roots: String,
}

/// `GET /api/taskflow/channels/{channel}/threads?roots=1,2,3` (a person who
/// can see the channel): `{"<id>": {reply_count, last_reply_at}}` for the
/// listed roots that have replies. At most 200 roots; one query.
pub async fn get_summaries(
    RequireAuth(user): RequireAuth<i64>,
    Path(channel): Path<i64>,
    Query(q): Query<SummaryQuery>,
) -> Result<Response, StatusCode> {
    let channel = crate::views::ensure_channel_visible(user, channel).await?;
    let roots = parse_roots(&q.roots)?;
    Ok(Json(summaries(channel.id, &roots).await?).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_parse_chips_only() {
        let m = mentions_in("hi [@A](agent:5) and [@B](user:7), not [x](agent:) or (agent:9) or [@C](agent:12x)");
        assert_eq!(m, vec![MessageTarget { kind: "agent".into(), id: 5 }, MessageTarget { kind: "user".into(), id: 7 }]);
    }

    #[test]
    fn the_needle_does_not_match_a_longer_id() {
        let targets = serde_json::to_string(&vec![MessageTarget { kind: "agent".into(), id: 50 }]).unwrap();
        assert!(!targets.contains(&agent_target_needle(5)));
        assert!(targets.contains(&agent_target_needle(50)));
    }

    #[test]
    fn roots_parse() {
        assert_eq!(parse_roots("3, 1,3,,2").unwrap(), vec![1, 2, 3]);
        assert!(parse_roots("1,x").is_err());
        assert!(parse_roots("0").is_err());
        let many = (1..=201).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        assert!(parse_roots(&many).is_err());
    }
}
