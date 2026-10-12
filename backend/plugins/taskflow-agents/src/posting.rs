//! #525: posting a message from inside ANOTHER tool.
//!
//! `design_screenshot` and `design_compare` can hand their render to a person
//! (`deliver: "message"`) instead of loading it into the agent's context. That
//! means a message posted from OUTSIDE the message route — and the one thing
//! that must not fork is the authorization rule: a render must land only where
//! the agent could have posted a sentence. So the check lives here, once, and
//! `send_message_as_agent` uses it too.

use umbral::orm::ForeignKey;
use umbral::storage::storage_opt;

use crate::agent_auth::AgentIdentity;
use crate::models::{TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind, TaskflowMessageAttachment, taskflow_agent_channel, taskflow_agent_channel_member};

/// Why a programmatic post could not happen. Each arm maps to a status the
/// caller answers with, and every one of them is the SAME rule the message
/// route applies.
#[derive(Debug)]
pub enum PostError {
    /// No such channel.
    ChannelNotFound,
    /// The channel exists but the agent may not post there: a DM it is not on
    /// the roster of, or another project's room.
    NotAllowed,
    /// A file is over the attachment cap.
    TooLarge { name: String, max_mb: u64 },
    /// No storage backend is registered (misconfigured deploy).
    StorageUnavailable,
    Internal,
}

/// The channel `agent` may post to, with membership already enforced.
///
/// The rule, in one place: the agent must be on the channel's roster, OR the
/// channel must be a shared room of the agent's OWN project (DMs are private
/// to their explicit roster).
pub async fn postable_channel(
    agent: &AgentIdentity,
    channel_id: i64,
) -> Result<TaskflowAgentChannel, PostError> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
        .first()
        .await
        .map_err(|_| PostError::Internal)?
        .ok_or(PostError::ChannelNotFound)?;

    let is_roster_member = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::AGENT.eq(agent.agent_id),
        )
        .first()
        .await
        .map_err(|_| PostError::Internal)?
        .is_some();

    if !is_roster_member {
        if channel.kind == TaskflowChannelKind::Direct {
            return Err(PostError::NotAllowed);
        }
        if channel.project.id() != agent.project_id {
            return Err(PostError::NotAllowed);
        }
    }
    Ok(channel)
}

/// One file to attach, held in memory — the renderer's own output, so nothing
/// is uploaded twice.
pub struct OutgoingFile {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Create the message and store its attachments. The caller has already
/// checked the channel with [`postable_channel`] and validated `reply_to`.
pub async fn post_agent_message(
    agent: &AgentIdentity,
    channel: &TaskflowAgentChannel,
    body: &str,
    reply_to: Option<i64>,
    files: Vec<OutgoingFile>,
) -> Result<(TaskflowAgentMessage, Vec<TaskflowMessageAttachment>), PostError> {
    if let Some(oversized) = files.iter().find(|f| f.bytes.len() > crate::views::MAX_ATTACHMENT_BYTES) {
        return Err(PostError::TooLarge {
            name: oversized.filename.clone(),
            max_mb: crate::views::MAX_ATTACHMENT_BYTES as u64 / (1024 * 1024),
        });
    }

    let is_design = channel.is_design;
    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: channel.project.clone(),
            channel: ForeignKey::new(channel.id),
            task: channel.task.clone(),
            sender_kind: crate::models::TaskflowChannelMemberKind::Agent,
            sender_user: None,
            sender_agent: Some(ForeignKey::new(agent.agent_id)),
            target_agent: None,
            targets: None,
            sender_label: agent.display_name.clone(),
            body_markdown: body.to_string(),
            priority: crate::models::TaskflowMessagePriority::Normal,
            is_design,
            client_nonce: None,
            edited_at: None,
            reply_to,
            created_at: None,
        })
        .await
        .map_err(|_| PostError::Internal)?;

    let mut attachments = Vec::with_capacity(files.len());
    if !files.is_empty() {
        let Some(storage) = storage_opt() else {
            return Err(PostError::StorageUnavailable);
        };
        for file in files {
            let stored = storage
                .store(&file.filename, &file.content_type, &file.bytes)
                .await
                .map_err(|_| PostError::Internal)?;
            let attachment = TaskflowMessageAttachment::objects()
                .create(TaskflowMessageAttachment {
                    id: 0,
                    message: ForeignKey::new(message.id),
                    project: channel.project.clone(),
                    channel: Some(message.channel.clone()),
                    file: umbral::orm::FileField::from(stored.key),
                    name: file.filename,
                    content_type: file.content_type,
                    size_bytes: stored.size as i64,
                    created_at: None,
                })
                .await
                .map_err(|_| PostError::Internal)?;
            attachments.push(attachment);
        }
    }
    Ok((message, attachments))
}

/// Store one file WITHOUT attaching it to a message — `deliver: "url"`, which
/// returns where the bytes live so a later message can carry the same object.
/// (See the design plugin's `delivery` module for what that URL is for.)
pub async fn store_media(
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<umbral::storage::StoredFile, PostError> {
    let Some(storage) = storage_opt() else {
        return Err(PostError::StorageUnavailable);
    };
    storage
        .store(filename, content_type, bytes)
        .await
        .map_err(|_| PostError::Internal)
}

/// The JSON one stored attachment contributes to a tool response: where it
/// lives and what it is, never the bytes.
pub fn attachment_json(attachment: &TaskflowMessageAttachment) -> serde_json::Value {
    serde_json::json!({
        "url": attachment.file.url(),
        "file": attachment.file.key(),
        "name": attachment.name,
        "content_type": attachment.content_type,
        "bytes": attachment.size_bytes,
    })
}
