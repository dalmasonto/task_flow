//! Test harness for the taskflow-agents plugin — the app's first one.
//!
//! Shared across test binaries; each uses a different subset of the helpers,
//! so unused-in-one-binary is expected, not dead code.
#![allow(dead_code)]
//!
//! `umbral-testing` already provides the two halves this needs: `boot()`
//! (one in-process app per test binary, backed by a throwaway SQLite
//! database that is never `backend.db`) and `TestClient` (drives the
//! plugin's `Router` in-process via `tower::oneshot`, so there is no
//! server to bind and no port to race on).
//!
//! What this module adds on top is the bit that is specific to this
//! endpoint: callers are *authenticated users*. `post_as(user_id, ..)`
//! mints a real `AuthToken` per seeded user and sends it as a bearer
//! token, so requests traverse the framework's genuine auth chain rather
//! than a stub. A test cannot accidentally assert against a fake identity.

use std::collections::HashMap;
use std::sync::Mutex;

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::Value;
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, taskflow_agent_channel, taskflow_agent_message,
};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;

/// One round trip. Thin wrapper over `umbral_testing::TestResponse` that
/// exposes the shape the tests want (`u16` status, JSON body).
pub struct TestResponse {
    inner: umbral_testing::TestResponse,
}

impl TestResponse {
    pub fn status(&self) -> u16 {
        self.inner.status().as_u16()
    }

    /// Parse the body as JSON. Panics with the raw body on a parse error,
    /// which is what you want to read when a handler 500s.
    pub async fn json(&self) -> Value {
        self.inner.body_json()
    }
}

pub struct TestApp {
    client: TestClient,
    /// user id -> that user's plaintext bearer token.
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        // `boot` is idempotent (a process-wide OnceCell), so every test can
        // call it. The plugins register their own models, so the schema is
        // derived from the models themselves — no hand-written CREATE TABLE
        // to drift out of sync with `models.rs`.
        boot(|b| {
            b.plugin(AuthPlugin::<AuthUser>::default())
                .plugin(TaskflowProjectsPlugin)
                .plugin(TaskflowTasksPlugin)
                .plugin(TaskflowAgentsPlugin)
        })
        .await;

        Self {
            client: TestClient::new(taskflow_agents::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a real `AuthUser` and mint a real bearer token for it, so
    /// `post_as` authenticates through the framework's own auth chain.
    pub async fn create_user(&self) -> i64 {
        let n = seq();
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: format!("user-{n}"),
                email: format!("user-{n}@example.test"),
                password_hash: "unused-tests-authenticate-by-token".to_string(),
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: chrono::Utc::now(),
                last_login: None,
                email_verified_at: None,
            })
            .await
            .expect("create AuthUser");

        let (_, plaintext) = AuthToken::create_for(&user, "test")
            .await
            .expect("mint bearer token");
        self.tokens
            .lock()
            .expect("tokens poisoned")
            .insert(user.id, plaintext.0);

        user.id
    }

    pub async fn post_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        let token = self
            .tokens
            .lock()
            .expect("tokens poisoned")
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| panic!("no bearer token seeded for user {user_id}"));

        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
        );

        TestResponse {
            inner: self.client.post_json(path, &body).await,
        }
    }

    pub async fn count_messages(&self, channel: i64) -> i64 {
        TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::CHANNEL.eq(channel))
            .count()
            .await
            .expect("count messages")
    }

    pub async fn project_of_channel(&self, channel: i64) -> i64 {
        TaskflowAgentChannel::objects()
            .filter(taskflow_agent_channel::ID.eq(channel))
            .first()
            .await
            .expect("load channel")
            .expect("channel exists")
            .project
            .id()
    }
}

async fn seed_project() -> i64 {
    let n = seq();
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: format!("Project {n}"),
            slug: format!("project-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn seed_channel(project: i64) -> i64 {
    seed_channel_of_kind(project, TaskflowChannelKind::Project).await
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

/// Seed a `TaskflowProjectMember` linking `user_id` to `project` with the given
/// status. Returns the member's `display_name` so a test can assert the derived
/// `sender_label` matches it.
async fn seed_project_member(
    project: i64,
    user_id: i64,
    status: TaskflowMembershipStatus,
) -> String {
    let display_name = format!("Project Member {user_id}");
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user_id}"),
            user: Some(ForeignKey::new(user_id)),
            display_name: display_name.clone(),
            email: None,
            role: TaskflowProjectRole::Developer,
            status,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create project member");
    display_name
}

/// A channel of `kind` plus a user who is a project member of that channel's
/// project (with the given membership `status`) but is NOT on the channel
/// roster. Returns `(channel, user, project_member_display_name)`.
///
/// This is the exact shape of the reported bug: joining via invite creates a
/// `TaskflowProjectMember` but never a `TaskflowAgentChannelMember`.
pub async fn seed_project_member_off_roster(
    app: &TestApp,
    kind: TaskflowChannelKind,
    status: TaskflowMembershipStatus,
) -> (i64, i64, String) {
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, kind).await;
    let user = app.create_user().await;
    let display_name = seed_project_member(project, user, status).await;
    (channel, user, display_name)
}

/// A channel plus a user who HAS joined it.
pub async fn seed_channel_with_member(app: &TestApp) -> (i64, i64) {
    let project = seed_project().await;
    let channel = seed_channel(project).await;
    let user = app.create_user().await;

    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("Member {user}"),
            role: "developer".to_string(),
            joined_at: None,
        })
        .await
        .expect("create channel member");

    (channel, user)
}

/// A channel plus an authenticated user who has NOT joined it. The user is
/// a real, valid, logged-in caller — the only thing they lack is membership,
/// which is precisely what the 403 must be caused by.
pub async fn seed_channel_without_member(app: &TestApp) -> (i64, i64) {
    let project = seed_project().await;
    let channel = seed_channel(project).await;
    let outsider = app.create_user().await;
    (channel, outsider)
}
