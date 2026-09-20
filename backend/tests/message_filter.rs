//! Auto-REST message list filtering by `is_design` — the read path Task 4
//! adds on top of the `is_design` column (Task 1) and both send paths
//! (Tasks 2-3).
//!
//! The frontend's design page needs to fetch ONLY design-flagged messages
//! from a channel's (potentially long) history, so the filter MUST happen
//! server-side: client-side filtering of a single paginated page could easily
//! yield zero design rows even though some exist further back.
//!
//! This boots the real `RestPlugin` wired through `backend::rest` — the same
//! `project_scoped_resources()` (which includes `taskflow_agent_message`,
//! channel-scoped, `.views([List, Retrieve])`) that `main.rs` ships — exactly
//! like `rest_scope.rs`, but as its own small app/seed so this test cannot
//! perturb (or be perturbed by) that file's shared message counts.

use axum::Router;
use http::header::{HeaderName, HeaderValue};
use serde_json::Value;
use tokio::sync::OnceCell;
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_rest::{FnAuthentication, Identity, IsAuthenticated, RestPlugin};
use umbral_testing::TestClient;

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowMessagePriority,
};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;

struct Seed {
    alice: i64,
    channel: i64,
}

static APP: OnceCell<(Router, Seed)> = OnceCell::const_new();

async fn app() -> &'static (Router, Seed) {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        let mut settings = umbral::Settings::from_env().expect("settings from env");
        settings.database_url = "sqlite::memory:".to_string();

        // Header-based auth, mirroring rest_scope.rs's harness: `x-user` is the pk.
        let auth = FnAuthentication::new(|headers| async move {
            let uid = headers.get("x-user")?.to_str().ok()?.to_string();
            Some(Identity::user(uid))
        });

        let mut rest = RestPlugin::default()
            .authenticate(auth)
            .default_permission(IsAuthenticated)
            .resource(backend::rest::project_resource());
        for resource in backend::rest::project_scoped_resources() {
            rest = rest.resource(resource);
        }

        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
            .plugin(TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            // `TaskflowMessageAttachment` carries a `FileField`, so the boot
            // storage check requires a registered backend, same as main.rs.
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(rest)
            .build()
            .expect("App::build");

        umbral::migrate::create_tables_for_tests()
            .await
            .expect("create the test schema");

        let seed = seed().await;
        (app.into_router(), seed)
    })
    .await
}

async fn make_user(username: &str) -> i64 {
    AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.to_string(),
            email: format!("{username}@example.test"),
            password_hash: "x".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser: false,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser")
        .id
}

async fn make_project(name: &str, slug: &str) -> i64 {
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: name.to_string(),
            slug: slug.to_string(),
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

async fn make_member(project: i64, user: i64, status: TaskflowMembershipStatus) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

async fn make_channel(project: i64, title: &str, kind: TaskflowChannelKind) -> i64 {
    TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project),
            title: title.to_string(),
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

async fn make_channel_member(project: i64, channel: i64, user: i64) {
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("user {user}"),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .expect("create channel member");
}

async fn make_message(project: i64, channel: i64, body: &str, is_design: bool) -> i64 {
    TaskflowAgentMessage::objects()
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
            sender_label: "someone".to_string(),
            body_markdown: body.to_string(),
            priority: TaskflowMessagePriority::Normal,
            is_design,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .expect("create message")
        .id
}

async fn seed() -> Seed {
    let alice = make_user("alice").await;
    let project = make_project("Project P", "project-p").await;
    make_member(project, alice, TaskflowMembershipStatus::Active).await;

    let channel = make_channel(project, "Project room", TaskflowChannelKind::Project).await;
    make_channel_member(project, channel, alice).await;

    make_message(project, channel, "plain", false).await;
    make_message(project, channel, "designy", true).await;

    Seed { alice, channel }
}

/// GET `path` as `user`. Fresh client per call so the per-user header never
/// races across concurrent tests.
async fn get_as(user: i64, path: &str) -> (u16, Value) {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    let res = client.get(path).await;
    (res.status().as_u16(), res.body_json())
}

/// The invariant the frontend's design page depends on: a boolean
/// `is_design=true` query filter on the auto-REST message list returns
/// exactly the design-flagged rows, none of the plain ones.
#[tokio::test]
async fn message_list_filters_by_is_design() {
    let (_, seed) = app().await;

    let (status, body) = get_as(
        seed.alice,
        &format!("/api/taskflow_agent_message/?channel={}&is_design=true", seed.channel),
    )
    .await;

    assert_eq!(status, 200, "list request failed: {body}");
    let rows = body["results"].as_array().expect("results array");
    assert_eq!(rows.len(), 1, "only the design row should match: {body}");
    assert_eq!(rows[0]["body_markdown"], Value::from("designy"));
    assert_eq!(rows[0]["is_design"], Value::from(true));
}
