//! Tests for the `/media` access gate (`backend::media_access`).
//!
//! The gate is a pure decision function over `(HeaderMap, key)`, so these
//! tests exercise it directly — no HTTP layer — while authenticating through
//! the framework's REAL chains: humans present a genuine `AuthToken` bearer
//! header, agents a genuine `tfk_` credential row hashed exactly as
//! `link_agent` mints them. Nothing is stubbed.
//!
//! Policy under test (see src/media_access.rs), mirroring
//! `rest.rs::visible_channel_ids`:
//!   * anonymous → deny, always
//!   * message attachment in a Direct/Group channel → roster membership
//!     required (project membership is NOT enough — DMs are private)
//!   * message attachment in any other channel kind (Project room, Task,
//!     Incident) → active project membership, same as message visibility
//!   * task attachment → active project membership (human) / same project
//!     (agent)
//!   * superuser → allow
//!   * unmapped key → deny (orphans are invisible, not public)

use std::sync::Arc;

use axum::http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
use backend::media_access::media_access_allowed;
use umbral::orm::{FileField, ForeignKey};
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{boot, seq};

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_agents::agent_auth::hash_key;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentStatus, TaskflowChannelKind, TaskflowChannelMemberKind,
    TaskflowCredentialStatus, TaskflowMessageAttachment, TaskflowMessagePriority,
};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskAttachment, TaskflowTaskPriority, TaskflowTaskStatus,
};

// --- boot harness (same shape as the plugins' test support) -----------------

#[derive(Debug, Default)]
struct MemoryStorage;

#[umbral::storage::async_trait]
impl Storage for MemoryStorage {
    async fn store(
        &self,
        filename: &str,
        _content_type: &str,
        bytes: &[u8],
    ) -> Result<StoredFile, StorageError> {
        let key = format!("{}-{}", seq(), filename);
        let url = format!("/media/{key}");
        Ok(StoredFile { key, url, size: bytes.len() as u64 })
    }
    async fn retrieve(&self, _key: &str) -> Result<Vec<u8>, StorageError> {
        Err(StorageError::NotFound)
    }
    async fn delete(&self, _key: &str) -> Result<(), StorageError> {
        Ok(())
    }
    fn url(&self, key: &str) -> String {
        format!("/media/{key}")
    }
}

struct MediaTestPlugin;

impl Plugin for MediaTestPlugin {
    fn name(&self) -> &'static str {
        "mem_media_test"
    }
    fn provides_storage(&self) -> bool {
        true
    }
    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        set_storage(Arc::new(MemoryStorage));
        Ok(())
    }
}

async fn boot_app() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
            .plugin(TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            .plugin(MediaTestPlugin)
    })
    .await;
}

// --- seeding helpers --------------------------------------------------------

/// A real user + a real bearer token; headers carry `Authorization: Bearer …`,
/// the second leg of `resolve_identity`'s chain.
async fn user_with_headers(superuser: bool) -> (i64, HeaderMap) {
    let n = seq();
    let user = AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: format!("media-user-{n}"),
            email: format!("media-user-{n}@example.test"),
            password_hash: "unused-tests-authenticate-by-token".to_string(),
            is_active: true,
            is_staff: superuser,
            is_superuser: superuser,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser");
    let (_, plaintext) = AuthToken::create_for(&user, "media-test")
        .await
        .expect("mint bearer token");
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", plaintext.0)).expect("bearer header"),
    );
    (user.id, headers)
}

/// A real agent + credential row for `project`, hashed exactly as the mint
/// endpoint stores it. Returns `(agent_id, headers)` with `Authorization:
/// Agent <raw>`.
async fn agent_with_headers(project: i64) -> (i64, HeaderMap) {
    let n = seq();
    let agent = TaskflowAgent::objects()
        .create(TaskflowAgent {
            id: 0,
            project: ForeignKey::new(project),
            display_name: format!("Agent {n}"),
            identifier: format!("agent-{n}"),
            fingerprint: None,
            project_root: None,
            taskflow_file_path: None,
            runtime: None,
            version: None,
            status: TaskflowAgentStatus::Offline,
            linked_by: None,
            linked_user_label: None,
            last_seen_at: None,
            created_at: None,
        })
        .await
        .expect("create agent");
    let raw = format!("tfk_t{n}_secret{n}");
    TaskflowAgentCredential::objects()
        .create(TaskflowAgentCredential {
            id: 0,
            project: ForeignKey::new(project),
            agent: Some(ForeignKey::new(agent.id)),
            issued_by: None,
            name: format!("cred-{n}"),
            key_prefix: format!("tfk_t{n}"),
            key_hash: hash_key(&raw),
            status: TaskflowCredentialStatus::Active,
            expires_at: None,
            revoked_at: None,
            created_at: None,
        })
        .await
        .expect("create credential");
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Agent {raw}")).expect("agent header"),
    );
    (agent.id, headers)
}

async fn seed_project() -> i64 {
    let n = seq();
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: format!("Media Project {n}"),
            slug: format!("media-project-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            github_auto_mirror: false,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_project_member(project: i64, user: i64, status: TaskflowMembershipStatus) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("Member {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create project member");
}

async fn seed_channel_of_kind(project: i64, kind: TaskflowChannelKind) -> i64 {
    let n = seq();
    TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project),
            title: format!("Channel {n}"),
            topic: None,
            kind,
            task: None,
            created_by_user: None,
            created_by_agent: None,
            archived: false,
            created_at: None,
        })
        .await
        .expect("create channel")
        .id
}

async fn seed_channel(project: i64) -> i64 {
    seed_channel_of_kind(project, TaskflowChannelKind::Project).await
}

async fn join_channel_user(project: i64, channel: i64, user: i64) {
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("User {user}"),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .expect("join channel (user)");
}

async fn join_channel_agent(project: i64, channel: i64, agent: i64) {
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::Agent,
            user: None,
            agent: Some(ForeignKey::new(agent)),
            display_name: format!("Agent {agent}"),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .expect("join channel (agent)");
}

/// A message attachment in `channel`, returning its storage key.
async fn seed_message_attachment(project: i64, channel: i64) -> String {
    let n = seq();
    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: None,
            sender_agent: None,
            target_agent: None,
            targets: None,
            sender_label: format!("Seeder {n}"),
            body_markdown: format!("attachment carrier {n}"),
            priority: TaskflowMessagePriority::Normal,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .expect("create message");
    let key = format!("chat/{n}/file-{n}.png");
    TaskflowMessageAttachment::objects()
        .create(TaskflowMessageAttachment {
            id: 0,
            message: ForeignKey::new(message.id),
            project: ForeignKey::new(project),
            channel: Some(ForeignKey::new(channel)),
            file: FileField::from(key.as_str()),
            name: format!("file-{n}.png"),
            content_type: "image/png".to_string(),
            size_bytes: 3,
            created_at: None,
        })
        .await
        .expect("create message attachment");
    key
}

/// A task attachment in `project`, returning its storage key.
async fn seed_task_attachment(project: i64) -> String {
    let n = seq();
    let task = TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: format!("Task {n}"),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            created_by_agent_id: None,
            assigned_user: None,
            assigned_agent_id: None,
            operator_user: None,
            operator_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            assignee_label: None,
            due_at: None,
            closed_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task");
    let key = format!("tasks/{n}/shot-{n}.png");
    TaskflowTaskAttachment::objects()
        .create(TaskflowTaskAttachment {
            id: 0,
            project: ForeignKey::new(project),
            task: ForeignKey::new(task.id),
            file: FileField::from(key.as_str()),
            name: format!("shot-{n}.png"),
            content_type: "image/png".to_string(),
            size_bytes: 3,
            created_at: None,
        })
        .await
        .expect("create task attachment");
    key
}

// --- the tests --------------------------------------------------------------

#[tokio::test]
async fn anonymous_is_denied_even_for_real_keys() {
    boot_app().await;
    let project = seed_project().await;
    let channel = seed_channel(project).await;
    let key = seed_message_attachment(project, channel).await;

    let empty = HeaderMap::new();
    assert!(!media_access_allowed(&empty, &key).await, "anonymous must be denied");

    let mut garbage = HeaderMap::new();
    garbage.insert(AUTHORIZATION, HeaderValue::from_static("Agent tfk_bogus_nope"));
    assert!(!media_access_allowed(&garbage, &key).await, "forged agent key must be denied");
}

#[tokio::test]
async fn project_room_files_follow_project_membership() {
    boot_app().await;
    let project = seed_project().await;
    // A Project-room channel whose roster holds NOBODY — the live shape: the
    // seeded Project room only rosters agents, never invited humans.
    let channel = seed_channel(project).await;
    let key = seed_message_attachment(project, channel).await;

    // ACTIVE project member, NOT on the roster → allowed, exactly like the
    // messages themselves (visible_channel_ids lets them read the room).
    let (member, member_headers) = user_with_headers(false).await;
    make_project_member(project, member, TaskflowMembershipStatus::Active).await;
    assert!(
        media_access_allowed(&member_headers, &key).await,
        "a project member must read the Project room's files without a roster row"
    );

    // A user from no project → denied.
    let (_outsider, outsider_headers) = user_with_headers(false).await;
    assert!(
        !media_access_allowed(&outsider_headers, &key).await,
        "a non-member must not read the Project room's files"
    );
}

#[tokio::test]
async fn direct_channel_files_require_roster_membership() {
    boot_app().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let key = seed_message_attachment(project, dm).await;

    // On the DM roster → allowed.
    let (in_dm, in_headers) = user_with_headers(false).await;
    make_project_member(project, in_dm, TaskflowMembershipStatus::Active).await;
    join_channel_user(project, dm, in_dm).await;
    assert!(media_access_allowed(&in_headers, &key).await, "DM member must read");

    // ACTIVE project member but NOT in the DM → denied. This is the leak the
    // channel column exists to prevent.
    let (off_roster, off_headers) = user_with_headers(false).await;
    make_project_member(project, off_roster, TaskflowMembershipStatus::Active).await;
    assert!(
        !media_access_allowed(&off_headers, &key).await,
        "project membership alone must NOT open a DM's files"
    );
}

#[tokio::test]
async fn agents_are_scoped_to_their_channel_and_project() {
    boot_app().await;
    let project = seed_project().await;
    let room = seed_channel(project).await; // Project room
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let room_key = seed_message_attachment(project, room).await;
    let dm_key = seed_message_attachment(project, dm).await;
    let task_key = seed_task_attachment(project).await;

    // Same-project agent: Project-room file allowed WITHOUT a roster row
    // (mirrors message visibility); task attachment allowed; DM denied until
    // rostered.
    let (agent, agent_headers) = agent_with_headers(project).await;
    assert!(media_access_allowed(&agent_headers, &room_key).await, "project agent: room file");
    assert!(media_access_allowed(&agent_headers, &task_key).await, "project agent: task file");
    assert!(
        !media_access_allowed(&agent_headers, &dm_key).await,
        "same-project agent off the DM roster must NOT read the DM's files"
    );
    join_channel_agent(project, dm, agent).await;
    assert!(media_access_allowed(&agent_headers, &dm_key).await, "rostered agent: DM file");

    // An agent from ANOTHER project → everything denied.
    let foreign_project = seed_project().await;
    let (_foreign_agent, foreign_headers) = agent_with_headers(foreign_project).await;
    assert!(!media_access_allowed(&foreign_headers, &room_key).await, "foreign agent: room file");
    assert!(!media_access_allowed(&foreign_headers, &dm_key).await, "foreign agent: DM file");
    assert!(!media_access_allowed(&foreign_headers, &task_key).await, "foreign agent: task file");
}

#[tokio::test]
async fn task_attachment_requires_active_project_membership() {
    boot_app().await;
    let project = seed_project().await;
    let key = seed_task_attachment(project).await;

    let (active, active_headers) = user_with_headers(false).await;
    make_project_member(project, active, TaskflowMembershipStatus::Active).await;
    assert!(media_access_allowed(&active_headers, &key).await, "active member must read");

    // Invited-but-never-joined is not access.
    let (invited, invited_headers) = user_with_headers(false).await;
    make_project_member(project, invited, TaskflowMembershipStatus::Invited).await;
    assert!(!media_access_allowed(&invited_headers, &key).await, "invited-only must be denied");

    // No membership at all.
    let (_outsider, outsider_headers) = user_with_headers(false).await;
    assert!(!media_access_allowed(&outsider_headers, &key).await, "outsider must be denied");
}

#[tokio::test]
async fn orphan_keys_are_superuser_only() {
    boot_app().await;
    let project = seed_project().await;

    // A key no attachment row maps to (e.g. pre-gate uploads, avatars).
    let orphan = format!("orphan/{}.bin", seq());

    let (member, member_headers) = user_with_headers(false).await;
    make_project_member(project, member, TaskflowMembershipStatus::Active).await;
    assert!(
        !media_access_allowed(&member_headers, &orphan).await,
        "unmapped keys must be invisible to normal users"
    );

    let (_root, root_headers) = user_with_headers(true).await;
    assert!(
        media_access_allowed(&root_headers, &orphan).await,
        "superuser bypasses the mapping requirement"
    );
}
