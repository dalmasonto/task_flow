//! #1116: the inbox — what needs a person, gathered from existing rows.
//!
//! Sources: pending permission prompts, decisions waiting on them, open review
//! requests naming them (#1098), open message
//! questions, mentions, and recently withdrawn prompts. Nothing here writes to
//! a source row. Every MESSAGE item passes the same channel-visibility check as
//! chat (`ensure_channel_visible`), so a DM you are not on never appears.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::web::{Json, StatusCode};

use taskflow_agents::models::{
    MessageTarget, TaskflowAgent, TaskflowAgentMessage, TaskflowAgentPrompt, TaskflowChannelMemberKind,
    TaskflowPromptStatus, TaskflowReviewRequest, taskflow_agent, taskflow_agent_message, taskflow_agent_prompt,
    taskflow_review_request,
};
use taskflow_decisions::models::{TaskflowDecision, taskflow_decision};

use crate::models::{TaskflowInboxCursor, taskflow_inbox_cursor};

pub type ApiError = (StatusCode, Json<Value>);

fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

fn internal<E>(_: E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal" })))
}

pub const WINDOW_DAYS: i64 = 14;
pub const PER_SOURCE: usize = 100;

#[derive(Debug, Default, Deserialize)]
pub struct InboxQuery {
    #[serde(default)]
    pub tab: Option<String>,
    #[serde(default)]
    pub project: Option<i64>,
}

struct Item {
    kind: &'static str,
    tab: &'static str,
    at: DateTime<Utc>,
    body: Value,
}

async fn projects_for(user: i64, only: Option<i64>) -> Vec<i64> {
    let mut ids: Vec<i64> = taskflow_projects::scope::active_project_ids_for_user(user)
        .await
        .iter()
        .filter_map(|p| p.parse().ok())
        .collect();
    if let Some(p) = only {
        ids.retain(|x| *x == p);
    }
    ids
}

async fn agent_labels(ids: &[i64]) -> HashMap<i64, String> {
    if ids.is_empty() {
        return HashMap::new();
    }
    TaskflowAgent::objects()
        .filter(taskflow_agent::ID.in_(ids))
        .fetch()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id, a.display_name))
        .collect()
}

fn mentions_user(m: &TaskflowAgentMessage, user: i64) -> bool {
    let targeted = m
        .targets
        .as_deref()
        .and_then(|t| serde_json::from_str::<Vec<MessageTarget>>(t).ok())
        .is_some_and(|ts| ts.iter().any(|t| t.kind == "user" && t.id == user));
    targeted || m.body_markdown.contains(&format!("](user:{user})"))
}

fn targets_users(m: &TaskflowAgentMessage) -> Vec<i64> {
    m.targets
        .as_deref()
        .and_then(|t| serde_json::from_str::<Vec<MessageTarget>>(t).ok())
        .map(|ts| ts.into_iter().filter(|t| t.kind == "user").map(|t| t.id).collect())
        .unwrap_or_default()
}

fn sent_by(m: &TaskflowAgentMessage, user: i64) -> bool {
    m.sender_kind == TaskflowChannelMemberKind::User && m.sender_user.as_ref().map(|u| u.id()) == Some(user)
}

fn snippet(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 280 { format!("{}…", flat.chars().take(280).collect::<String>()) } else { flat }
}

pub async fn inbox(user: i64, q: &InboxQuery) -> Result<Value, ApiError> {
    let tab = q.tab.as_deref().unwrap_or("needs_you");
    if !["needs_you", "mentions", "everything"].contains(&tab) {
        return Err(bad("tab", "needs_you, mentions or everything"));
    }
    let projects = projects_for(user, q.project).await;
    let since = Utc::now() - Duration::days(WINDOW_DAYS);
    let mut items: Vec<Item> = Vec::new();
    if projects.is_empty() {
        return Ok(json!({ "items": [], "counts": { "needs_you": 0, "mentions": 0 }, "unread": 0, "seen_at": Value::Null }));
    }

    // 1. Permission prompts: pending, aimed at me or at nobody. Withdrawn ones
    //    (cancelled in the last day) show dimmed under "everything".
    let prompts = TaskflowAgentPrompt::objects()
        .filter(taskflow_agent_prompt::PROJECT.in_(&projects))
        .order_by(taskflow_agent_prompt::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let agent_ids: Vec<i64> = prompts.iter().map(|p| p.agent.id()).collect();
    let labels = agent_labels(&agent_ids).await;
    let day_ago = Utc::now() - Duration::days(1);
    let mut n = 0;
    for p in &prompts {
        if n >= PER_SOURCE {
            break;
        }
        let mine = p.target_user.as_ref().is_none_or(|u| u.id() == user);
        let at = p.created_at.unwrap_or_else(Utc::now);
        if !mine || at < since {
            continue;
        }
        let (kind, tab_of) = match p.status {
            TaskflowPromptStatus::Pending => ("prompt", "needs_you"),
            TaskflowPromptStatus::Cancelled if at >= day_ago => ("prompt_withdrawn", "everything"),
            _ => continue,
        };
        n += 1;
        items.push(Item {
            kind,
            tab: tab_of,
            at,
            body: json!({
                "prompt": p.id, "project": p.project.id(), "agent": p.agent.id(),
                "agent_label": labels.get(&p.agent.id()), "question": p.question,
                "options_json": p.options_json, "prompt_kind": p.kind,
                "answer_path": format!("/api/taskflow/prompts/{}/answer", p.id),
            }),
        });
    }

    // 2. Decisions waiting on me: open, and I am the ruler or none is named.
    let decisions = TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.in_(&projects) & taskflow_decision::STATUS.eq("open"))
        .order_by(taskflow_decision::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    for d in decisions.iter().filter(|d| d.ruler_user.as_ref().is_none_or(|r| r.id() == user)).take(PER_SOURCE) {
        items.push(Item {
            kind: "decision",
            tab: "needs_you",
            at: d.created_at.unwrap_or_else(Utc::now),
            body: json!({
                "decision": d.id, "key": d.key, "project": d.project.id(), "question": d.question,
                "asked_by_label": d.asked_by_label,
            }),
        });
    }

    // 2b. Review requests naming me (#1098), open.
    let requests = TaskflowReviewRequest::objects()
        .filter(
            taskflow_review_request::PROJECT.in_(&projects)
                & taskflow_review_request::REVIEWER_USER.eq(user)
                & taskflow_review_request::STATUS.eq("open"),
        )
        .order_by(taskflow_review_request::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    for r in requests.iter().take(PER_SOURCE) {
        items.push(Item {
            kind: "review_request",
            tab: "needs_you",
            at: r.created_at.unwrap_or_else(Utc::now),
            body: json!({
                "review_request": r.id, "project": r.project.id(), "task": r.task.id(),
                "requester_label": r.requester_label, "link": r.link, "focus_markdown": r.focus_markdown,
                "review_path": format!("/api/taskflow/tasks/{}/review", r.task.id()),
            }),
        });
    }

    // 3 + 4. Messages: open questions for me, and mentions of me. Filtered
    //    coarsely in SQL (has questions, or names a user somewhere), then
    //    exactly here — and every one through the channel-visibility check.
    let messages = TaskflowAgentMessage::objects()
        .filter(
            taskflow_agent_message::PROJECT.in_(&projects)
                & taskflow_agent_message::CREATED_AT.gte(since)
                & (taskflow_agent_message::QUESTIONS.is_not_null()
                    | taskflow_agent_message::TARGETS.like("%user%")
                    | taskflow_agent_message::BODY_MARKDOWN.like("%](user:%")),
        )
        .order_by(taskflow_agent_message::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let mut visible: HashMap<i64, bool> = HashMap::new();
    let (mut questions, mut mentions) = (0usize, 0usize);
    for m in &messages {
        if sent_by(m, user) {
            continue;
        }
        let channel = m.channel.id();
        let can_see = match visible.get(&channel) {
            Some(v) => *v,
            None => {
                let v = taskflow_agents::views::ensure_channel_visible(user, channel).await.is_ok();
                visible.insert(channel, v);
                v
            }
        };
        if !can_see {
            continue;
        }
        let at = m.created_at.unwrap_or_else(Utc::now);
        let base = json!({
            "message": m.id, "channel": channel, "project": m.project.id(),
            "sender_label": m.sender_label, "sender_kind": m.sender_kind, "snippet": snippet(&m.body_markdown),
        });
        if m.questions.is_some() && questions < PER_SOURCE {
            let aimed = targets_users(m);
            if aimed.is_empty() || aimed.contains(&user) {
                let open = taskflow_agents::answers::open_question_keys(m).await;
                if !open.is_empty() {
                    questions += 1;
                    let mut body = base.clone();
                    body["open"] = json!(open);
                    items.push(Item { kind: "question", tab: "needs_you", at, body });
                    continue;
                }
            }
        }
        if mentions < PER_SOURCE && mentions_user(m, user) {
            mentions += 1;
            items.push(Item { kind: "mention", tab: "mentions", at, body: base });
        }
    }

    // Read state.
    let seen_at = TaskflowInboxCursor::objects()
        .filter(taskflow_inbox_cursor::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
        .map(|c| c.seen_at);
    let unread = |i: &Item| seen_at.is_none_or(|s| i.at > s);
    let counts = json!({
        "needs_you": items.iter().filter(|i| i.tab == "needs_you").count(),
        "mentions": items.iter().filter(|i| i.tab == "mentions").count(),
    });
    let unread_total = items.iter().filter(|i| i.tab != "everything" && unread(i)).count();

    let mut shown: Vec<&Item> = items
        .iter()
        .filter(|i| match tab {
            "everything" => true,
            t => i.tab == t,
        })
        .collect();
    shown.sort_by(|a, b| b.at.cmp(&a.at));
    let out: Vec<Value> = shown
        .iter()
        .map(|i| {
            let mut v = i.body.clone();
            v["kind"] = json!(i.kind);
            v["at"] = json!(i.at);
            v["unread"] = json!(unread(i));
            v
        })
        .collect();
    Ok(json!({ "items": out, "counts": counts, "unread": unread_total, "seen_at": seen_at }))
}

pub async fn mark_read(user: i64) -> Result<Value, ApiError> {
    let now = Utc::now();
    match TaskflowInboxCursor::objects()
        .filter(taskflow_inbox_cursor::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
    {
        Some(mut c) => {
            c.seen_at = now;
            TaskflowInboxCursor::objects().save(c).await.map_err(internal)?;
        }
        None => {
            TaskflowInboxCursor::objects()
                .create(TaskflowInboxCursor { id: 0, user: ForeignKey::new(user), seen_at: now })
                .await
                .map_err(internal)?;
        }
    }
    Ok(json!({ "seen_at": now }))
}
