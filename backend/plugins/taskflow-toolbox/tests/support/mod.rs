//! Test harness for the taskflow-toolbox plugin.
//!
//! Mirrors `plugins/taskflow-agents/tests/support/mod.rs`: `boot()` brings up
//! one in-process app per test binary against a throwaway SQLite database, and
//! `TestClient` drives the plugin's `Router` in-process. Callers authenticate
//! through the framework's real chain — a real `AuthUser` with a real minted
//! bearer token — so a test cannot accidentally assert against a stub identity.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use http::header::AUTHORIZATION;
use http::HeaderValue;
use serde_json::Value;
use umbral::orm::{ForeignKey, Model as _};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_projects::TaskflowProjectsPlugin;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};

/// #700: the agents + tasks plugins declare `FileField`s, and the storage
/// system check fails without a backend. The toolbox never reads or writes a
/// blob; this exists so the harness can boot those plugins for their credential
/// tables, exactly as `taskflow-agents/tests/support` does.
#[derive(Debug, Default)]
struct MemoryStorage;

#[umbral::storage::async_trait]
impl Storage for MemoryStorage {
    async fn store(&self, filename: &str, _content_type: &str, bytes: &[u8]) -> Result<StoredFile, StorageError> {
        let key = format!("{}-{filename}", seq());
        Ok(StoredFile { url: format!("/media/{key}"), key, size: bytes.len() as u64 })
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
        "mem_media_test_toolbox"
    }
    fn provides_storage(&self) -> bool {
        true
    }
    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        set_storage(Arc::new(MemoryStorage));
        Ok(())
    }
}
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

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

    pub fn text(&self) -> String {
        self.inner.body_text()
    }
}

pub struct TestApp {
    client: TestClient,
    /// user id -> that user's plaintext bearer token.
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        boot(|b| {
            b.plugin(AuthPlugin::<AuthUser>::default())
                .plugin(TaskflowProjectsPlugin)
                // #700: the agent routes resolve credentials to identities, so
                // the agents plugin (and its tables) must be booted even though
                // every route under test is the toolbox's own.
                .plugin(taskflow_tasks::TaskflowTasksPlugin)
                .plugin(taskflow_agents::TaskflowAgentsPlugin)
                .plugin(taskflow_toolbox::TaskflowToolboxPlugin)
                .plugin(MediaTestPlugin)
        })
        .await;
        Self {
            client: TestClient::new(taskflow_toolbox::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a real `AuthUser` and mint a real bearer token for it.
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

    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.set_bearer(user_id);
        TestResponse { inner: self.client.get(path).await }
    }

    pub async fn post_json_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        self.set_bearer(user_id);
        TestResponse { inner: self.client.post_json(path, &body).await }
    }

    /// #700: POST as an AGENT (`Authorization: Agent <key>`).
    pub async fn post_json_as_agent(&self, key: &str, path: &str, body: Value) -> TestResponse {
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Agent {key}")).expect("agent header"),
        );
        TestResponse { inner: self.client.post_json(path, &body).await }
    }

    /// #700: GET as an AGENT.
    pub async fn get_as_agent(&self, key: &str, path: &str) -> TestResponse {
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Agent {key}")).expect("agent header"),
        );
        TestResponse { inner: self.client.get(path).await }
    }

    fn set_bearer(&self, user_id: i64) {
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
    }
}

/// A project owned by a fresh user, who is NOT yet a member — the tests seed
/// membership explicitly so the authorization path is exercised, not assumed.
pub async fn seed_project(app: &TestApp) -> (TestUser, i64) {
    let user = app.create_user().await;
    let n = seq();
    let project = TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: format!("Project {n}"),
            slug: format!("project-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: Some(ForeignKey::new(user)),
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            github_auto_mirror: false,
            agent_instructions_markdown: None,
            agent_instructions_updated_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project");
    (TestUser { id: user }, project.id)
}

pub struct TestUser {
    pub id: i64,
}

/// An ACTIVE project member. The toolbox gates on `can_access_project`, which
/// reads exactly this row.
pub async fn seed_member(project: i64, user: i64, role: &str) -> i64 {
    let role = match role {
        "owner" => TaskflowProjectRole::Owner,
        "admin" => TaskflowProjectRole::Admin,
        _ => TaskflowProjectRole::Developer,
    };
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            user: Some(ForeignKey::new(user)),
            status: TaskflowMembershipStatus::Active,
            role,
            display_name: format!("Member {user}"),
            member_key: format!("user:{user}"),
            email: Some(format!("member{user}@example.test")),
            invited_by: None,
            joined_at: None,
            created_at: None,
        })
        .await
        .expect("create membership")
        .id
}

/// #700: a real agent credential for `project`, optionally with denied
/// capabilities. `denied` goes in unvalidated on purpose — these tests are
/// about enforcement, not about minting policy.
pub async fn seed_agent_key(project: i64, denied: &[&str]) -> String {
    use taskflow_agents::agent_auth::hash_key;
    use taskflow_agents::models::{
        TaskflowAgent, TaskflowAgentCredential, TaskflowAgentStatus, TaskflowCredentialStatus,
    };
    use umbral::orm::ForeignKey;

    let n = seq();
    let agent = TaskflowAgent::objects()
        .create(TaskflowAgent {
            id: 0,
            project: ForeignKey::new(project),
            display_name: format!("Toolbox Agent {n}"),
            identifier: format!("toolbox-agent-{n}"),
            fingerprint: None,
            project_root: None,
            taskflow_file_path: None,
            runtime: Some("test".into()),
            version: None,
            status: TaskflowAgentStatus::Offline,
            linked_by: None,
            linked_user_label: None,
            instructions_markdown: None,
            instructions_updated_at: None,
            last_seen_at: None,
            created_at: None,
        })
        .await
        .expect("seed agent");

    // `tfk_<prefix>_<secret>` — `RequireAgent` indexes by everything up to the
    // SECOND underscore, so the raw key needs one.
    let raw_key = format!("tfk_tb{n:08x}_{}", uuid_like(n));
    let prefix = format!("tfk_tb{n:08x}");
    TaskflowAgentCredential::objects()
        .create(TaskflowAgentCredential {
            id: 0,
            project: ForeignKey::new(project),
            agent: Some(ForeignKey::new(agent.id)),
            issued_by: None,
            name: format!("test key {n}"),
            key_prefix: prefix,
            key_hash: hash_key(&raw_key),
            status: TaskflowCredentialStatus::Active,
            scopes: None,
            denied_scopes: if denied.is_empty() {
                None
            } else {
                Some(serde_json::to_string(denied).expect("denied list serialises"))
            },
            expires_at: None,
            revoked_at: None,
            created_at: None,
        })
        .await
        .expect("seed credential");

    raw_key
}

fn uuid_like(n: u64) -> String {
    let hex = format!("{n:016x}{:016x}", n.wrapping_mul(0x9E3779B97F4A7C15));
    format!("{}{}", &hex[..12], &hex[12..])
}
