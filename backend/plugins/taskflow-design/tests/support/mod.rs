// Each test binary compiles this module but uses only part of it, so items
// unused by a given binary would warn. Shared test support, allow it.
#![allow(dead_code)]

//! Test harness for the taskflow-design plugin — mirrors the projects harness.
//!
//! `boot_app()` stands up an in-process app (auth + projects + design plugins)
//! against a throwaway SQLite database, and `TestApp` drives the plugin's real
//! router with REAL bearer tokens, so every request traverses the genuine auth
//! chain and the membership gate.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

// An in-memory storage backend. The taskflow-agents models include a
// FileField (message attachments), and App::build's storage check refuses to
// boot without SOME backend registered — same shim the agents tests use.
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
        Ok(StoredFile { url: format!("/media/{key}"), size: bytes.len() as u64, key })
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

struct MemoryMediaPlugin;
impl Plugin for MemoryMediaPlugin {
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

use taskflow_design::TaskflowDesignPlugin;
use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectMember, TaskflowProjectRole, TaskflowProjectStatus,
    TaskflowMembershipStatus, taskflow_project_member,
};

#[derive(Clone)]
pub struct TestUser {
    pub id: i64,
    pub email: String,
    pub username: String,
}

pub struct TestApp {
    client: TestClient,
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        Self::boot(false).await
    }

    /// Same app, plus the realtime plugin. `taskflow_design::signals` broadcasts
    /// through `Realtime::to_group(..).send(..)`, which no-ops without the
    /// ambient realtime handle — so a test that asserts on what a write
    /// BROADCASTS (not just what it stores) needs this boot.
    pub async fn new_with_realtime() -> Self {
        Self::boot(true).await
    }

    async fn boot(with_realtime: bool) -> Self {
        // Boot the full plugin set so FK targets and the membership tables the
        // scope helpers read actually exist. Schema comes from the plugins'
        // own models — no hand-written DDL anywhere.
        boot(|b| {
            let b = b
                .plugin(AuthPlugin::<AuthUser>::default())
                .plugin(taskflow_projects::TaskflowProjectsPlugin::default())
                .plugin(taskflow_tasks::TaskflowTasksPlugin::default())
                .plugin(taskflow_agents::TaskflowAgentsPlugin::default())
                // The agents plugin's attachment model has a FileField; the
                // boot storage check needs a registered backend.
                .plugin(MemoryMediaPlugin)
                .plugin(TaskflowDesignPlugin::default());
            if with_realtime {
                b.plugin(umbral_realtime::RealtimePlugin::new())
            } else {
                b
            }
        })
        .await;

        Self {
            client: TestClient::new(taskflow_design::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// A real user + bearer token, plus a project they OWN (and therefore are
    /// an active member of).
    pub async fn create_member_with_project(&self) -> (TestUser, i64) {
        let n = seq();
        let email = format!("design-user-{n}@example.test");
        let username = format!("design-user-{n}");
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: username.clone(),
                email: email.clone(),
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

        let project = TaskflowProject::objects()
            .create(TaskflowProject {
                id: 0,
                name: format!("Design Project {n}"),
                slug: format!("design-project-{n}"),
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
            .await
            .expect("create project");

        TaskflowProjectMember::objects()
            .create(TaskflowProjectMember {
                id: 0,
                project: ForeignKey::new(project.id),
                member_key: format!("user:{}", user.id),
                user: Some(ForeignKey::new(user.id)),
                display_name: username.clone(),
                email: Some(email.clone()),
                role: TaskflowProjectRole::Owner,
                status: TaskflowMembershipStatus::Active,
                invited_by: None,
                created_at: None,
                joined_at: None,
            })
            .await
            .expect("seed member");

        (
            TestUser {
                id: user.id,
                email,
                username,
            },
            project.id,
        )
    }

    fn set_auth(&self, user_id: i64) {
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

    pub async fn put_json_as(&self, user_id: i64, path: &str, body: &Value) -> TestResponse {
        self.set_auth(user_id);
        TestResponse {
            inner: self.client.put_json(path, body).await,
        }
    }

    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.set_auth(user_id);
        TestResponse {
            inner: self.client.get(path).await,
        }
    }

    pub async fn post_json_as(&self, user_id: i64, path: &str, body: &Value) -> TestResponse {
        self.set_auth(user_id);
        TestResponse {
            inner: self.client.post_json(path, body).await,
        }
    }

    /// Agent-authed variants: `Authorization: Agent <key>` is the whole
    /// identity, exactly as the MCP client presents it.
    fn set_agent_auth(&self, key: &str) {
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Agent {key}")).expect("agent header"),
        );
    }

    pub async fn get_as_agent(&self, key: &str, path: &str) -> TestResponse {
        self.set_agent_auth(key);
        TestResponse {
            inner: self.client.get(path).await,
        }
    }

    pub async fn put_as_agent(&self, key: &str, path: &str, body: Value) -> TestResponse {
        self.set_agent_auth(key);
        TestResponse {
            inner: self.client.put_json(path, &body).await,
        }
    }

    pub async fn post_json_as_agent(&self, key: &str, path: &str, body: &Value) -> TestResponse {
        self.set_agent_auth(key);
        TestResponse {
            inner: self.client.post_json(path, body).await,
        }
    }

    /// Sandbox requests carry NO auth — the token in the path is the grant.
    /// Deliberately does NOT call set_auth; also clears the default header so
    /// a test cannot accidentally authenticate the sandbox origin.
    pub async fn get_sandbox(&self, path: &str) -> TestResponse {
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_static(""),
        );
        TestResponse {
            inner: self.client.get(path).await,
        }
    }
}

pub struct TestResponse {
    inner: umbral_testing::TestResponse,
}

impl TestResponse {
    pub fn status(&self) -> u16 {
        self.inner.status().as_u16()
    }

    pub fn json(&self) -> Value {
        self.inner.body_json()
    }

    pub fn text(&self) -> String {
        self.inner.body_text()
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.inner.header(name)
    }
}

/// The canonical sample artifacts Phase 1 acceptance renders: one token file,
/// one component, two linked page fragments.
pub fn sample_tokens() -> String {
    r#"@theme {
  --bg: #0b0b10;
  --surface: #16161d;
  --fg: #f4f4f5;
  --muted: #a1a1aa;
  --border: #27272a;
  --accent: #6366f1;
  --radius-md: 8px;
}
:root {
  --spacing-1: 4px; --spacing-2: 8px; --spacing-4: 16px;
}
"#
    .to_string()
}

pub fn sample_header_component() -> String {
    r#"customElements.define('app-header', class extends HTMLElement {
  static get observedAttributes() { return ['title', 'variant']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { this.isConnected && this.render(); }
  render() {
    const compact = this.getAttribute('variant') === 'compact';
    this.innerHTML = `
      <header data-component="app-header"
        class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] ${compact ? 'h-11' : 'h-14'}">
        <span class="font-medium">${esc(this.getAttribute('title') ?? '')}</span>
      </header>`;
  }
});
function esc(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
"#
    .to_string()
}

pub fn sample_index_page() -> String {
    r#"<main class="p-4 space-y-4 bg-[var(--bg)] text-[var(--fg)]">
  <app-header title="Dashboard"></app-header>
  <section class="rounded-[var(--radius-md)] border border-[var(--border)] p-4">
    <h1 class="text-lg">Overview</h1>
    <a href="/settings">Open settings</a>
  </section>
</main>
"#
    .to_string()
}

pub fn sample_settings_page() -> String {
    r#"<main class="p-4 space-y-4 bg-[var(--bg)] text-[var(--fg)]">
  <app-header title="Settings" variant="compact"></app-header>
  <form class="space-y-2">
    <label for="name">Workspace name</label>
    <input id="name" type="text" />
    <button type="submit" class="bg-[var(--accent)] text-white rounded px-3 py-1">Save</button>
  </form>
  <a href="/">Back to dashboard</a>
</main>
"#
    .to_string()
}
