// Each test binary compiles this module but uses only part of it, so items
// unused by a given binary would warn. Shared test support, allow it.
#![allow(dead_code)]

//! Test harness for the taskflow-projects plugin — mirrors the agents harness.
//!
//! `boot()` stands up one in-process app per test binary against a throwaway
//! SQLite database (schema derived from the plugins' own models), and
//! `TestClient` drives the plugin's `Router` in-process. `post_as` / `get_as`
//! mint a real bearer token per seeded user so requests traverse the
//! framework's genuine auth chain — a test can't assert against a fake identity.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowInviteStatus, TaskflowMembershipStatus, TaskflowProject, TaskflowProjectInvite,
    TaskflowProjectMember, TaskflowProjectRole, TaskflowProjectStatus, taskflow_project_member,
};

/// A seeded, authenticated user plus the account details a test needs to line
/// an invite up against (email match is the whole security boundary).
#[derive(Clone)]
pub struct TestUser {
    pub id: i64,
    pub email: String,
    pub username: String,
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
}

pub struct TestApp {
    client: TestClient,
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        boot(|b| {
            b.plugin(AuthPlugin::<AuthUser>::default())
                .plugin(TaskflowProjectsPlugin)
        })
        .await;

        Self {
            client: TestClient::new(taskflow_projects::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a real `AuthUser` + mint a real bearer token for it.
    pub async fn create_user(&self) -> TestUser {
        self.create_user_with(false).await
    }

    /// Create a real `AuthUser` with `is_superuser = true` + mint a real
    /// bearer token for it — for tests asserting the superuser bypass on
    /// project-scoped authorization (e.g. `create_invite`).
    pub async fn create_superuser(&self) -> TestUser {
        self.create_user_with(true).await
    }

    async fn create_user_with(&self, is_superuser: bool) -> TestUser {
        let n = seq();
        let email = format!("user-{n}@example.test");
        let username = format!("user-{n}");
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: username.clone(),
                email: email.clone(),
                password_hash: "unused-tests-authenticate-by-token".to_string(),
                is_active: true,
                is_staff: false,
                is_superuser,
                date_joined: Utc::now(),
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

        TestUser {
            id: user.id,
            email,
            username,
        }
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

    pub async fn post_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.post_body_as(user_id, path, json!({})).await
    }

    pub async fn post_body_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        self.set_auth(user_id);
        TestResponse {
            inner: self.client.post_json(path, &body).await,
        }
    }

    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.set_auth(user_id);
        TestResponse {
            inner: self.client.get(path).await,
        }
    }

    pub async fn count_active_members(&self, project: i64, user_id: i64) -> i64 {
        TaskflowProjectMember::objects()
            .filter(
                taskflow_project_member::PROJECT.eq(project)
                    & taskflow_project_member::USER.eq(user_id)
                    & taskflow_project_member::STATUS.eq("active"),
            )
            .count()
            .await
            .expect("count members")
    }

    pub async fn count_members(&self, project: i64) -> i64 {
        TaskflowProjectMember::objects()
            .filter(taskflow_project_member::PROJECT.eq(project))
            .count()
            .await
            .expect("count members")
    }

    /// The stored `status` of a (project, user) membership, or `None` if there
    /// is no such row. Lets a test assert a suspended member was NOT reactivated.
    pub async fn member_status(&self, project: i64, user_id: i64) -> Option<String> {
        TaskflowProjectMember::objects()
            .filter(
                taskflow_project_member::PROJECT.eq(project)
                    & taskflow_project_member::USER.eq(user_id),
            )
            .first()
            .await
            .expect("load member")
            .map(|m| {
                serde_json::to_value(m.status)
                    .expect("serialize status")
                    .as_str()
                    .expect("status serializes to a string")
                    .to_string()
            })
    }
}

/// Seed a membership row with an explicit role and status (the create-invite
/// authorization boundary and the suspended-reactivation guard both key on
/// these). Links `user` and `member_key: user:{id}` so the accept flow's
/// `unique_together` lookup finds it.
pub async fn seed_member(
    project: i64,
    user_id: i64,
    role: TaskflowProjectRole,
    status: TaskflowMembershipStatus,
) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user_id}"),
            user: Some(ForeignKey::new(user_id)),
            display_name: format!("user-{user_id}"),
            email: None,
            role,
            status,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

pub async fn seed_project() -> i64 {
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

/// Seed an invite. Returns its opaque token. `status` defaults to pending;
/// `expires_at` is optional so a test can force the expired path.
pub async fn seed_invite(
    project: i64,
    email: &str,
    status: TaskflowInviteStatus,
    expires_at: Option<DateTime<Utc>>,
) -> String {
    let n = seq();
    let token = format!("tok-{n}");
    TaskflowProjectInvite::objects()
        .create(TaskflowProjectInvite {
            id: 0,
            project: ForeignKey::new(project),
            email: email.to_string(),
            display_name: None,
            role: TaskflowProjectRole::Developer,
            status,
            invite_token: token.clone(),
            invited_by: None,
            expires_at,
            accepted_at: None,
            created_at: None,
        })
        .await
        .expect("create invite");
    token
}
