//! Dispatch (§9.5.7): send selected comments to an agent's tmux session.
//!
//! Delivery follows the app's existing convention — a chat message addressed
//! to the agent in its DM channel. The agent's running MCP mirror receives it
//! over the realtime stream and types the text into the agent's tmux pane, so
//! no new transport is invented and pane delivery keeps its prompt-gating.
//!
//! Each comment travels as a STRUCTURED TARGET: file, component, element
//! path, blast radius — everything the agent needs to edit the right thing.

use serde::Deserialize;
use serde_json::json;

use umbral::orm::{ForeignKey};
use umbral::web::{IntoResponse, Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage,
    TaskflowChannelKind, TaskflowChannelMemberKind, TaskflowMessagePriority,
    taskflow_agent_channel,
};
use taskflow_projects::scope::can_access_project;

use crate::manifest;
use crate::models::{CommentStatus, DesignComment, design_comment};
use crate::store;

#[derive(Debug, Deserialize)]
pub struct DispatchInput {
    pub comment_ids: Vec<i64>,
    /// The agent to hand these to. Must belong to this project.
    pub agent_id: i64,
}

/// `POST /api/design/{project}/dispatch`
pub async fn dispatch_comments(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<DispatchInput>,
) -> Result<Response, StatusCode> {
    if !can_access_project(user_id, project_id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    if input.comment_ids.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // The agent must live in THIS project — a credential-scoped check on the
    // human side too: you cannot dispatch into another workspace's agent.
    let agent = TaskflowAgent::objects()
        .filter(taskflow_agents::models::taskflow_agent::ID.eq(input.agent_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if agent.project.id() != project_id {
        return Err(StatusCode::FORBIDDEN);
    }

    // Load the requested OPEN comments, project-scoped.
    let mut comments: Vec<DesignComment> = Vec::new();
    for id in &input.comment_ids {
        if let Some(row) = DesignComment::objects()
            .filter(
                design_comment::PROJECT.eq(project_id)
                    & design_comment::ID.eq(*id)
                    & design_comment::STATUS.eq("open"),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        {
            comments.push(row);
        }
    }
    if comments.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let caller = umbral_auth::AuthUser::objects()
        .filter(umbral_auth::auth_user::ID.eq(user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Find-or-create the caller's DM with the agent. Server-side dedup by
    // roster mirrors what the chrome does; two dispatches reuse one room.
    let channel = find_or_create_dm(project_id, user_id, input.agent_id, &agent.display_name)
        .await?;

    // Format the payload. The preamble tells the agent to screenshot before +
    // after — without a visual feedback loop the edits cannot be evaluated.
    let files = store::list_files(project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(project_id, &files, revision);

    let mut body = format!(
        "[design-review] {} comment(s) from {} on the Design Surface.\n\
         For each: read the target, edit that file, then design_resolve_comment with a short note.\n\
         Call design_screenshot on the affected route BEFORE and AFTER your edits and compare.\n",
        comments.len(),
        caller.username,
    );
    for c in &comments {
        let used_on = c
            .component_name
            .as_deref()
            .and_then(|name| m.components.iter().find(|comp| comp.name == name))
            .map(|e| e.used_on.clone())
            .unwrap_or_default();
        let file = c
            .component_name
            .as_deref()
            .map(|n| format!("components/{n}.js"))
            .unwrap_or_else(|| {
                manifest::page_path_for_route(&c.page_path)
                    .unwrap_or_else(|| c.page_path.clone())
            });
        body.push_str(&format!(
            "\n--- design comment cm_{:04x} ---\n{}\n",
            c.id,
            json!({
                "target": {
                    "route": c.page_path,
                    "kind": c.scope,
                    "file": file,
                    "component": c.component_name,
                    "elementPath": c.element_path,
                    "src": c.src_ref,
                    "usedOn": used_on,
                    "scope": c.scope,
                    "viewport": c.viewport,
                },
                "snippet": c.snippet,
                "instruction": c.body,
                "commentId": format!("cm_{:04x}", c.id),
            })
        ));
    }

    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: agent.project.clone(),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user_id)),
            sender_agent: None,
            target_agent: Some(ForeignKey::new(agent.id)),
            targets: Some(
                json!([{ "kind": "agent", "id": agent.id }]).to_string(),
            ),
            sender_label: caller.username.clone(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Normal,
            is_design: false,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Flip open → sent. SSE carries each update so pins re-color live.
    let mut sent_ids = Vec::with_capacity(comments.len());
    for mut c in comments {
        c.status = CommentStatus::Sent;
        let saved = DesignComment::objects()
            .save(c)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        sent_ids.push(saved.id);
    }

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "message_id": message.id,
            "channel_id": channel,
            "agent_id": agent.id,
            "sent_comment_ids": sent_ids,
        })),
    )
        .into_response())
}


// ---------------------------------------------------------------------------
// Free-text prompt (§9.6) — the chrome's bottom prompt bar posts here.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SendPromptInput {
    pub agent_id: i64,
    /// The operator's instruction, sent verbatim.
    pub text: String,
    /// Optional structured selection chip (component + element path + route)
    /// captured from the inspector at compose time.
    #[serde(default)]
    pub selection: Option<serde_json::Value>,
}

const MAX_PROMPT_CHARS: usize = 8_000;

/// `POST /api/design/{project}/prompt` — deliver a free-text instruction into
/// the agent's tmux session through its DM channel (same delivery path as
/// comment dispatch: the MCP mirror types DMs into the pane).
///
/// The optional selection rides along as context so the agent knows exactly
/// which element "this" refers to without the operator re-describing it.
pub async fn send_prompt(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<SendPromptInput>,
) -> Result<Response, StatusCode> {
    if !can_access_project(user_id, project_id).await {
        return Err(StatusCode::FORBIDDEN);
    }

    let text = input.text.trim();
    if text.is_empty() || text.chars().count() > MAX_PROMPT_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }

    let agent = TaskflowAgent::objects()
        .filter(taskflow_agents::models::taskflow_agent::ID.eq(input.agent_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if agent.project.id() != project_id {
        return Err(StatusCode::FORBIDDEN);
    }

    let caller = umbral_auth::AuthUser::objects()
        .filter(umbral_auth::auth_user::ID.eq(user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let channel = find_or_create_dm(project_id, user_id, input.agent_id, &agent.display_name)
        .await?;

    let mut body = format!("[design-request] from {}\n{}", caller.username, text);
    if let Some(sel) = input.selection.as_ref().filter(|v| !v.is_null()) {
        body.push_str(&format!(
            "\n---\nAttached selection (the element the operator was looking at):\n{}",
            sel
        ));
    }
    let body = body.chars().take(MAX_PROMPT_CHARS * 2).collect::<String>();

    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: agent.project.clone(),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user_id)),
            sender_agent: None,
            target_agent: Some(ForeignKey::new(agent.id)),
            targets: Some(json!([{ "kind": "agent", "id": agent.id }]).to_string()),
            sender_label: caller.username.clone(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Normal,
            is_design: false,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "message_id": message.id,
            "channel_id": channel,
            "agent_id": agent.id,
        })),
    )
        .into_response())
}

/// The Direct channel holding exactly this user + this agent, or a fresh one.
async fn find_or_create_dm(
    project_id: i64,
    user_id: i64,
    agent_id: i64,
    agent_label: &str,
) -> Result<i64, StatusCode> {
    use taskflow_agents::models::taskflow_agent_channel_member as m;

    let memberships = TaskflowAgentChannelMember::objects()
        .filter(m::PROJECT.eq(project_id) & m::MEMBER_KIND.eq("user") & m::USER.eq(user_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let candidate_ids: Vec<i64> = memberships.iter().map(|row| row.channel.id()).collect();

    if !candidate_ids.is_empty() {
        let candidates = TaskflowAgentChannel::objects()
            .filter(taskflow_agent_channel::ID.in_(&candidate_ids))
            .fetch()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for channel in candidates.into_iter().filter(|c| c.kind == TaskflowChannelKind::Direct) {
            let roster = TaskflowAgentChannelMember::objects()
                .filter(m::CHANNEL.eq(channel.id))
                .fetch()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let has_user = roster
                .iter()
                .any(|r| r.member_kind == TaskflowChannelMemberKind::User && r.user.as_ref().map(|u| u.id()) == Some(user_id));
            let has_agent = roster
                .iter()
                .any(|r| r.member_kind == TaskflowChannelMemberKind::Agent && r.agent.as_ref().map(|a| a.id()) == Some(agent_id));
            if has_user && has_agent && roster.len() == 2 {
                return Ok(channel.id);
            }
        }
    }

    // Create the DM + both member rows atomically-ish; a duplicate under a race
    // costs a second room, not data loss.
    let channel = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project_id),
            title: agent_label.to_string(),
            topic: None,
            kind: TaskflowChannelKind::Direct,
            task: None,
            created_by_user: Some(ForeignKey::new(user_id)),
            created_by_agent: None,
            archived: false,
            // A design-request DM is an ordinary room: neither of the two
            // project-wide markers (`is_public` / `is_design`) applies to it.
            is_public: false,
            is_design: false,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project_id),
            channel: ForeignKey::new(channel.id),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user_id)),
            agent: None,
            display_name: String::new(),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project_id),
            channel: ForeignKey::new(channel.id),
            member_kind: TaskflowChannelMemberKind::Agent,
            user: None,
            agent: Some(ForeignKey::new(agent_id)),
            display_name: agent_label.to_string(),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(channel.id)
}
