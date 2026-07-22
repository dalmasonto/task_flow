#![allow(dead_code, unused_imports)]
//! Test harness for the taskflow-github plugin — mirrors the projects harness.
//!
//! `boot()` stands up one in-process app per test binary against a throwaway
//! SQLite DB (schema derived from the plugins' models). Real bearer tokens are
//! minted per user so requests traverse the genuine auth chain.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::Utc;
use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

use taskflow_github::TaskflowGithubPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus};

#[derive(Clone)]
pub struct TestUser {
    pub id: i64,
    pub email: String,
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
                .plugin(TaskflowGithubPlugin)
        })
        .await;
        Self {
            client: TestClient::new(taskflow_github::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub async fn create_user(&self) -> TestUser {
        let n = seq();
        let email = format!("user-{n}@example.test");
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: format!("user-{n}"),
                email: email.clone(),
                password_hash: "unused".into(),
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: Utc::now(),
                last_login: None,
                email_verified_at: None,
            })
            .await
            .expect("create user");
        let (_, plaintext) = AuthToken::create_for(&user, "test").await.expect("token");
        self.tokens.lock().unwrap().insert(user.id, plaintext.0);
        TestUser { id: user.id, email }
    }

    fn set_auth(&self, user_id: i64) {
        let token = self.tokens.lock().unwrap().get(&user_id).cloned().unwrap();
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
    }

    pub async fn post_body_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        self.set_auth(user_id);
        TestResponse { inner: self.client.post_json(path, &body).await }
    }

    pub async fn get_as(&self, user_id: i64, path: &str) -> TestResponse {
        self.set_auth(user_id);
        TestResponse { inner: self.client.get(path).await }
    }
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
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}
