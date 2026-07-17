//! A minimal live chat workspace so a fresh dev DB has something real to
//! render. The frontend has no fixtures — what you see here is what you get.

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind,
    TaskflowChannelMemberKind,
};
use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus};
use umbral::prelude::*;
use umbral_auth::AuthUser;

/// Idempotent: short-circuits if any channel already exists.
pub async fn dev_workspace() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if TaskflowAgentChannel::objects().count().await? > 0 {
        return Ok(());
    }

    // `earliest` sugars to `ORDER BY id ASC LIMIT 1`, so this is
    // deterministic even once more than one user exists.
    let Some(user) = AuthUser::objects().all().earliest("id").await? else {
        // credentials::test_credentials() runs first; if there is still no
        // user (e.g. no UMBRAL_DEV_ADMIN_PASSWORD was set) we have nobody to
        // make a member, so leave the DB alone rather than seeding a channel
        // nobody can post to.
        return Ok(());
    };

    let project = TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: "TaskFlow v2".to_string(),
            slug: "taskflow-v2".to_string(),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: Some(ForeignKey::new(user.id)),
            created_at: None,
            updated_at: None,
        })
        .await?;

    let channel = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project.id),
            title: "Project room".to_string(),
            topic: Some("Shared room for this project.".to_string()),
            kind: TaskflowChannelKind::Project,
            task: None,
            created_by_user: Some(ForeignKey::new(user.id)),
            created_by_agent: None,
            archived: false,
            created_at: None,
        })
        .await?;

    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project.id),
            channel: ForeignKey::new(channel.id),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user.id)),
            agent: None,
            display_name: user.username.clone(),
            role: "owner".to_string(),
            joined_at: None,
        })
        .await?;

    Ok(())
}
