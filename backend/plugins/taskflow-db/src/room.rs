//! The database room (#885): one chat room per project for schema talk, with
//! the project's agents on its roster. The page's chat column shows it; an
//! agent overriding a person's lock posts a note into it.

use serde_json::json;
use umbral::orm::ForeignKey;

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelKind, TaskflowChannelMemberKind,
    TaskflowMessagePriority, taskflow_agent_channel,
};

use crate::models::{DbRoom, db_room};

pub const DB_ROOM_TITLE: &str = "Database room";

/// The project's database room, created on first use. The public and design
/// rooms are ensured FIRST: an unmarked project channel created while the
/// public room is missing could otherwise be adopted as the legacy public room.
pub async fn ensure_db_room(project_id: i64) -> Result<TaskflowAgentChannel, String> {
    taskflow_agents::views::ensure_project_rooms(project_id)
        .await
        .map_err(|s| format!("ensure project rooms: {s}"))?;

    if let Some(row) = DbRoom::objects()
        .filter(db_room::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|e| e.to_string())?
    {
        if let Some(channel) = TaskflowAgentChannel::objects()
            .filter(taskflow_agent_channel::ID.eq(row.channel.id()))
            .first()
            .await
            .map_err(|e| e.to_string())?
        {
            taskflow_agents::views::ensure_project_agents_rostered(project_id, channel.id)
                .await
                .map_err(|s| format!("roster: {s}"))?;
            return Ok(channel);
        }
    }

    let channel = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project_id),
            title: DB_ROOM_TITLE.to_string(),
            topic: Some("The data model of this project: what agents wrote and what you changed.".to_string()),
            kind: TaskflowChannelKind::Project,
            task: None,
            created_by_user: None,
            created_by_agent: None,
            archived: false,
            is_public: false,
            is_design: false,
            created_at: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    match DbRoom::objects()
        .create(DbRoom { id: 0, project: ForeignKey::new(project_id), channel: ForeignKey::new(channel.id), created_at: None })
        .await
    {
        Ok(_) => {}
        // Another caller created the room first: use theirs, drop ours.
        Err(_) => {
            let _ = TaskflowAgentChannel::objects()
                .filter(taskflow_agent_channel::ID.eq(channel.id))
                .delete()
                .await;
            return Box::pin(ensure_db_room(project_id)).await;
        }
    }
    taskflow_agents::views::ensure_project_agents_rostered(project_id, channel.id)
        .await
        .map_err(|s| format!("roster: {s}"))?;
    Ok(channel)
}

/// Post a note from an agent into the database room (best effort).
pub async fn post_agent_note(project_id: i64, agent_id: i64, agent_label: &str, body: String) {
    let Ok(room) = ensure_db_room(project_id).await else { return };
    let _ = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project_id),
            channel: ForeignKey::new(room.id),
            task: None,
            sender_kind: TaskflowChannelMemberKind::Agent,
            sender_user: None,
            sender_agent: Some(ForeignKey::new(agent_id)),
            target_agent: None,
            targets: Some(json!([]).to_string()),
            sender_label: agent_label.to_string(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Important,
            is_design: false,
            client_nonce: None,
            edited_at: None,
            reply_to: None,
            questions: None,
            created_at: None,
        })
        .await;
}
