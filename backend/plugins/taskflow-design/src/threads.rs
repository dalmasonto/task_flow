//! #1123: design pin threads, the replies under a design comment
//! (`design--pin.html`).
//!
//! - A reply's author comes from the auth gate (a project member, or an agent
//!   of the project with `design:write`), never from the body.
//! - `page_version` ("fixed in v4") must be a real, non-deleted version of the
//!   comment's OWN page. A comment with no page (a component comment) only
//!   takes `null`.
//! - A person's reply sends the agent the comment was dispatched to
//!   (`sent_to_agent`) a pane notice, through the same flattened notice path
//!   as wake-ups. No chat message row is written. An agent's reply sends no
//!   notice; it shows live in the thread.
//! - The first reply sets the root's `thread_id`, keeping the model's "null
//!   until a threaded reply exists" contract.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_agents::agent_auth::RequireAgent;
use taskflow_agents::models::{TaskflowAgent, taskflow_agent};
use taskflow_projects::scope::can_access_project;

use crate::manifest::page_path_for_route;
use crate::models::{
    DesignComment, DesignCommentReply, DesignFileVersion, design_comment, design_comment_reply,
    design_file_version,
};

pub const MAX_BODY_CHARS: usize = 4000;
const MAX_REPLIES: u64 = 500;

type ApiError = (StatusCode, Json<Value>);
type Reply = Result<Response, ApiError>;

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

fn internal<E>(_: E) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

#[derive(Debug, Clone)]
enum Author {
    User { id: i64, label: String },
    Agent { id: i64, label: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyInput {
    pub body: String,
    #[serde(default)]
    pub page_version: Option<i64>,
}

async fn comment_in(project: i64, id: i64) -> Result<DesignComment, ApiError> {
    DesignComment::objects()
        .filter(design_comment::PROJECT.eq(project) & design_comment::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))
}

/// A version must belong to the comment's own page; a page-less comment
/// takes none.
async fn check_version(comment: &DesignComment, version: Option<i64>) -> Result<(), ApiError> {
    let Some(v) = version else { return Ok(()) };
    let Some(page) = page_path_for_route(&comment.page_path).filter(|_| comment.component_name.is_none()) else {
        return Err(bad("page_version", "this comment is not on a page"));
    };
    let found = DesignFileVersion::objects()
        .filter(
            design_file_version::PROJECT.eq(comment.project.id())
                & design_file_version::PATH.eq(page.as_str())
                & design_file_version::VERSION.eq(v)
                & design_file_version::DELETED.eq(false),
        )
        .first()
        .await
        .map_err(internal)?;
    if found.is_none() {
        return Err(bad("page_version", "not a version of this comment's page"));
    }
    Ok(())
}

fn reply_json(r: &DesignCommentReply) -> Value {
    json!({
        "id": r.id, "comment": r.comment.id(), "author_kind": r.author_kind,
        "author_user": r.author_user.as_ref().map(|u| u.id()),
        "author_agent": r.author_agent.as_ref().map(|a| a.id()),
        "author_label": r.author_label, "body": r.body, "page_version": r.page_version,
        "created_at": r.created_at,
    })
}

async fn add(comment: DesignComment, author: Author, input: ReplyInput) -> Reply {
    let body = input.body.trim().to_string();
    if body.is_empty() || body.chars().count() > MAX_BODY_CHARS {
        return Err(bad("body", &format!("1 to {MAX_BODY_CHARS} characters")));
    }
    check_version(&comment, input.page_version).await?;
    let (kind, user, agent, label) = match &author {
        Author::User { id, label } => ("user", Some(ForeignKey::new(*id)), None, label.clone()),
        Author::Agent { id, label } => ("agent", None, Some(ForeignKey::new(*id)), label.clone()),
    };
    let reply = DesignCommentReply::objects()
        .create(DesignCommentReply {
            id: 0,
            project: comment.project.clone(),
            comment: ForeignKey::new(comment.id),
            author_kind: kind.into(),
            author_user: user,
            author_agent: agent,
            author_label: label.clone(),
            body: body.clone(),
            page_version: input.page_version,
            created_at: None,
        })
        .await
        .map_err(internal)?;

    // Set ONLY `thread_id`, and only while it is still null (#1123 review): a
    // whole-row save of the row loaded above would revert a resolve or a
    // dispatch that landed in between (the #1097 lost-update class). The
    // null guard also makes two racing first replies idempotent. No post_save
    // is needed: the reply's own realtime event drives the thread refetch, and
    // the id is deterministic.
    if comment.thread_id.is_none() {
        let mut v = serde_json::Map::new();
        v.insert("thread_id".into(), json!(format!("c{}", comment.id)));
        DesignComment::objects()
            .filter(design_comment::ID.eq(comment.id) & design_comment::THREAD_ID.is_null())
            .update_values(v)
            .await
            .map_err(internal)?;
    }

    // A person's reply reaches the agent the comment was sent to. Flattened by
    // notify_agent, so a multi-line reply can't split the pane write.
    // TODO(#TSK1127): add the message trust marker here once it lands; this is
    // a person's text going into an agent's pane.
    if let (Author::User { .. }, Some(agent)) = (&author, comment.sent_to_agent.as_ref().map(|a| a.id())) {
        let notice = format!("Reply from {label} on your design comment #{}: {body}", comment.id);
        if let Err((status, _)) = taskflow_agents::wakeups::notify_agent(agent, notice).await {
            eprintln!("design reply notice to agent {agent} not delivered: {status}");
        }
    }
    Ok((StatusCode::CREATED, Json(reply_json(&reply))).into_response())
}

async fn thread(comment: DesignComment) -> Reply {
    let replies = DesignCommentReply::objects()
        .filter(design_comment_reply::COMMENT.eq(comment.id))
        .order_by(design_comment_reply::ID.asc())
        .limit(MAX_REPLIES)
        .fetch()
        .await
        .map_err(internal)?;
    let sent_to = match comment.sent_to_agent.as_ref().map(|a| a.id()) {
        Some(id) => TaskflowAgent::objects()
            .filter(taskflow_agent::ID.eq(id))
            .first()
            .await
            .map_err(internal)?
            .map(|a| json!({ "id": a.id, "label": a.display_name })),
        None => None,
    };
    let status = serde_json::to_value(comment.status).unwrap_or(Value::Null);
    let resolved = matches!(status.as_str(), Some("addressed") | Some("dismissed"));
    Ok(Json(json!({
        "root": {
            "id": comment.id, "page_path": comment.page_path, "component_name": comment.component_name,
            "body": comment.body, "author": comment.author, "status": status, "resolved": resolved,
            "resolution_note": comment.resolution_note, "thread_id": comment.thread_id,
            "created_at": comment.created_at,
        },
        "sent_to": sent_to,
        "replies": replies.iter().map(reply_json).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn member(user: i64, project: i64) -> Result<Author, ApiError> {
    if !can_access_project(user, project).await {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    let u = AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    Ok(Author::User { id: user, label: u.username })
}

/// `POST /api/design/{project}/comments/{id}/replies` (member)
pub async fn add_reply(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, id)): Path<(i64, i64)>,
    Json(input): Json<ReplyInput>,
) -> Reply {
    let author = member(user, project).await?;
    add(comment_in(project, id).await?, author, input).await
}

/// `GET /api/design/{project}/comments/{id}/thread` (member)
pub async fn get_thread(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>) -> Reply {
    member(user, project).await?;
    thread(comment_in(project, id).await?).await
}

/// `POST /api/taskflow/agents/design/comments/{id}/replies` (design:write)
pub async fn agent_add_reply(RequireAgent(agent): RequireAgent, Path(id): Path<i64>, Json(input): Json<ReplyInput>) -> Reply {
    agent
        .require(taskflow_agents::scopes::DESIGN_WRITE)
        .map_err(taskflow_agents::scopes::CapabilityError::into_status_json)?;
    let author = Author::Agent { id: agent.agent_id, label: agent.display_name.clone() };
    add(comment_in(agent.project_id, id).await?, author, input).await
}

/// `GET /api/taskflow/agents/design/comments/{id}/thread` (agent of the project)
pub async fn agent_get_thread(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    thread(comment_in(agent.project_id, id).await?).await
}
