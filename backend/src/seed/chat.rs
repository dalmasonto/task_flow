//! A minimal live chat workspace so a fresh dev DB has something real to
//! render. The frontend has no fixtures — what you see here is what you get.

use chrono::Utc;
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind,
    TaskflowChannelMemberKind,
};
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use umbral::Environment;
use umbral::prelude::*;
use umbral_auth::AuthUser;

/// Idempotent: short-circuits if any channel already exists. The four
/// creates below run inside a single transaction, so that check can never
/// observe a half-seeded workspace (project without a channel, or a project
/// with a channel but no owner membership, etc.) — either all four rows
/// exist or none do.
pub async fn dev_workspace() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Never seed demo chat data outside the Dev environment — belt and
    // suspenders on top of the caller only running us on a bare launch.
    if umbral::settings::get().environment != Environment::Dev {
        return Ok(());
    }

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

    umbral::transaction(|tx| {
        Box::pin(async move {
            let project = TaskflowProject::objects()
                .on_tx(tx)
                .create(TaskflowProject {
                    id: 0,
                    name: "TaskFlow v2".to_string(),
                    slug: "taskflow-v2".to_string(),
                    description_markdown: String::new(),
                    repository_url: None,
                    default_api_base_url: None,
                    status: TaskflowProjectStatus::Active,
                    owner: Some(ForeignKey::new(user.id)),
                    github_repo: None,
                    github_linked_by: None,
                    github_default_branch: None,
                    github_auto_mirror: false,
                    created_at: None,
                    updated_at: None,
                })
                .await?;

            let channel = TaskflowAgentChannel::objects()
                .on_tx(tx)
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
                .on_tx(tx)
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

            // SP-A scopes project visibility on active `TaskflowProjectMember`
            // rows, so the seeded project also needs the dev user as an actual
            // active owner member — not just a chat-channel member — or a
            // non-superuser dev account would see zero projects.
            TaskflowProjectMember::objects()
                .on_tx(tx)
                .create(TaskflowProjectMember {
                    id: 0,
                    project: ForeignKey::new(project.id),
                    member_key: format!("user:{}", user.id),
                    user: Some(ForeignKey::new(user.id)),
                    display_name: user.username.clone(),
                    email: Some(user.email.clone()),
                    role: TaskflowProjectRole::Owner,
                    status: TaskflowMembershipStatus::Active,
                    invited_by: None,
                    created_at: None,
                    joined_at: Some(Utc::now()),
                })
                .await?;

            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        })
    })
    .await?;

    Ok(())
}
