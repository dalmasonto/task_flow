//! REST access-scoping — the live security bug: every project-scoped resource
//! was registered bare, so any logged-in user could list EVERY project's data.
//!
//! These tests boot the real `RestPlugin` wired through `backend::rest`
//! (`project_resource` + `project_scoped_resources`) — the exact code
//! `main.rs` ships — against an in-process app, and assert that a caller sees
//! only the rows of the projects they actively belong to.
//!
//! The assertion that matters most is [`no_membership_sees_nothing`]: a logged-in
//! user with zero memberships must see ZERO projects, not all of them. That is
//! the reported regression (`dalmasogembo@gmail.com` seeing "TaskFlow v2").

use axum::Router;
use http::header::{HeaderName, HeaderValue};
use serde_json::Value;
use tokio::sync::OnceCell;
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_rest::{FnAuthentication, Identity, IsAuthenticated, RestPlugin};
use umbral_testing::TestClient;

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};

/// Ids the seed pins so the assertions can name concrete rows.
struct Seed {
    /// A user who is an active member of project P and nothing else.
    alice: i64,
    /// An authenticated user with NO memberships — the regression case.
    bob: i64,
    /// A superuser.
    root: i64,
    /// The project alice belongs to.
    project_p: i64,
    /// A project alice is NOT a member of.
    project_q: i64,
}

static APP: OnceCell<(Router, Seed)> = OnceCell::const_new();

async fn app() -> &'static (Router, Seed) {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        let mut settings = umbral::Settings::from_env().expect("settings from env");
        settings.database_url = "sqlite::memory:".to_string();

        // Auth from a header, so tests can be any user (and a superuser) without
        // minting tokens. `x-user` is the pk; `x-super: 1` flips the superuser
        // flag. Mirrors the framework's own membership_scope test harness.
        let auth = FnAuthentication::new(|headers| async move {
            let uid = headers.get("x-user")?.to_str().ok()?.to_string();
            let is_super = headers
                .get("x-super")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "1")
                .unwrap_or(false);
            Some(Identity::user(uid).with_superuser(is_super))
        });

        // The REST plugin exactly as main.rs builds it: scoped resources from
        // `backend::rest`.
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
            // storage check requires a registered backend — same as main.rs.
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

async fn make_user(username: &str, is_superuser: bool) -> i64 {
    AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.to_string(),
            email: format!("{username}@example.test"),
            password_hash: "x".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser,
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

async fn make_task(project: i64, title: &str) {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: title.to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            assignee_label: None,
            due_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task");
}

async fn seed() -> Seed {
    let alice = make_user("alice", false).await;
    let bob = make_user("bob", false).await;
    let root = make_user("root", true).await;

    let project_p = make_project("Project P", "project-p").await;
    let project_q = make_project("Project Q", "project-q").await;

    // Alice is an ACTIVE member of P only. She also has a non-active membership
    // in Q — `invited`, not `active` — which must NOT grant her access, proving
    // the status filter bites.
    make_member(project_p, alice, TaskflowMembershipStatus::Active).await;
    make_member(project_q, alice, TaskflowMembershipStatus::Invited).await;

    make_task(project_p, "P task").await;
    make_task(project_q, "Q task").await;

    Seed {
        alice,
        bob,
        root,
        project_p,
        project_q,
    }
}

/// GET `path` as `user`, optionally a superuser. Fresh client per call so the
/// per-user header never races across concurrent tests.
async fn get_as(user: i64, is_super: bool, path: &str) -> (u16, Value) {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    if is_super {
        client.set_default_header(
            HeaderName::from_static("x-super"),
            HeaderValue::from_static("1"),
        );
    }
    let res = client.get(path).await;
    (res.status().as_u16(), res.body_json())
}

/// POST `body` to `path` as `user`. Fresh client per call so the per-user
/// header never races across concurrent tests.
async fn post_as(user: i64, path: &str, body: Value) -> (u16, Value) {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    let res = client.post_json(path, &body).await;
    (res.status().as_u16(), res.body_json())
}

/// The `id`s in a list response's `results`.
fn result_ids(body: &Value) -> Vec<i64> {
    body["results"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|r| r["id"].as_i64()).collect())
        .unwrap_or_default()
}

/// The `project` fk ids in a list response's `results`.
fn result_project_ids(body: &Value) -> Vec<i64> {
    body["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r["project"].as_i64())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn member_sees_their_project_and_not_others() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_project/").await;
    assert_eq!(status, 200);
    let ids = result_ids(&body);
    assert!(
        ids.contains(&seed.project_p),
        "alice must see project P (she is an active member); got {body}",
    );
    assert!(
        !ids.contains(&seed.project_q),
        "alice must NOT see project Q (only an `invited` membership); got {body}",
    );
}

#[tokio::test]
async fn member_sees_only_their_projects_tasks() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_task/").await;
    assert_eq!(status, 200);
    let projects = result_project_ids(&body);
    assert!(
        projects.iter().all(|p| *p == seed.project_p),
        "every task alice sees must belong to project P; got {body}",
    );
    assert!(
        !projects.contains(&seed.project_q),
        "alice must not see project Q's tasks; got {body}",
    );
}

/// A second project-scoped resource, to prove the scope is applied uniformly and
/// not just to `taskflow_project`.
#[tokio::test]
async fn member_sees_only_their_projects_members() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_project_member/").await;
    assert_eq!(status, 200);
    let projects = result_project_ids(&body);
    assert!(
        !projects.is_empty(),
        "alice should see her own membership row in P; got {body}",
    );
    assert!(
        projects.iter().all(|p| *p == seed.project_p),
        "alice must only see member rows of project P, never Q's; got {body}",
    );
}

/// THE regression. A logged-in user with no active membership sees ZERO
/// projects — not all of them.
#[tokio::test]
async fn no_membership_sees_nothing() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.bob, false, "/api/taskflow_project/").await;
    assert_eq!(status, 200);
    assert!(
        result_ids(&body).is_empty(),
        "bob has no memberships and must see NO projects — an empty membership \
         set must never mean 'unconstrained'; got {body}",
    );

    // ...and no project-scoped rows either.
    let (_, tasks) = get_as(seed.bob, false, "/api/taskflow_task/").await;
    assert!(
        result_ids(&tasks).is_empty(),
        "bob must see no tasks; got {tasks}",
    );

    // ...and cannot reach a specific project by id (404, not 403 — no oracle).
    let (status, _) = get_as(
        seed.bob,
        false,
        &format!("/api/taskflow_project/{}", seed.project_p),
    )
    .await;
    assert_eq!(status, 404, "an out-of-scope row must 404, never 200/403");
}

/// THE escalation regression. `scope_async` governs reads, NOT creates, and
/// `taskflow_project_member.status` is client-writable — so before the fix a
/// non-member could `POST` themselves an ACTIVE membership and the read-scope
/// would then open the whole project to them. Locking the table read-only
/// (`.views([List, Retrieve])`) removes the create route entirely.
///
/// This test FAILS against the old code (the POST succeeds with 201, and bob
/// then sees project P) and PASSES after the fix (the POST is rejected and bob
/// still sees zero projects).
#[tokio::test]
async fn non_member_cannot_self_grant_membership() {
    let (_, seed) = app().await;

    // bob has zero memberships. He tries to grant himself an active membership
    // in project P — the exact self-service escalation from the report.
    let (status, body) = post_as(
        seed.bob,
        "/api/taskflow_project_member/",
        serde_json::json!({
            "project": seed.project_p,
            "user": seed.bob,
            "member_key": format!("user:{}", seed.bob),
            "display_name": "bob",
            "email": null,
            "role": "developer",
            "status": "active",
        }),
    )
    .await;

    assert!(
        status == 405 || status == 403 || status == 404,
        "a non-member's POST to taskflow_project_member must be REJECTED \
         (read-only resource → 405), got {status}: {body}",
    );

    // The escalation must not have taken effect: bob still belongs to nothing.
    let (pstatus, projects) = get_as(seed.bob, false, "/api/taskflow_project/").await;
    assert_eq!(pstatus, 200);
    assert!(
        result_ids(&projects).is_empty(),
        "after the rejected self-grant, bob must STILL see zero projects; got {projects}",
    );
}

/// THE invite-takeover regression. `taskflow_project_invite` was left writable,
/// and the SP-B accept endpoint mints membership from an invite whose only check
/// is that its `email` matches the caller. So a non-member could self-author an
/// invite (`role:"owner"`) addressed to their own account, POST it (create is
/// unscoped → 201), then accept it (email matches) to become an active OWNER of
/// a project they were never part of — a full takeover that defeats the
/// read-scope. Locking the table read-only (`.views([List, Retrieve])`) removes
/// the create route, killing the chain at step one.
///
/// This FAILS against the old code (the POST returns 201) and PASSES after the
/// fix (the POST is rejected 405 and bob still sees zero projects).
#[tokio::test]
async fn non_member_cannot_self_mint_invite() {
    let (_, seed) = app().await;

    // bob@example.test is bob's account email (see `make_user`). He tries to
    // author his own owner-invite into project P.
    let (status, body) = post_as(
        seed.bob,
        "/api/taskflow_project_invite/",
        serde_json::json!({
            "project": seed.project_p,
            "email": "bob@example.test",
            "role": "owner",
            "status": "pending",
            "invite_token": "x",
        }),
    )
    .await;

    assert!(
        status == 405 || status == 403 || status == 404,
        "a self-authored invite POST must be REJECTED (read-only resource → \
         405); a 201 here is the takeover primitive, got {status}: {body}",
    );

    // With the create route gone the takeover chain is dead at step one: there
    // is no invite for the SP-B accept endpoint to consume, so bob still belongs
    // to nothing. (The accept endpoint itself — under real token auth — is
    // covered in the taskflow-projects `invites` test suite.)
    let (pstatus, projects) = get_as(seed.bob, false, "/api/taskflow_project/").await;
    assert_eq!(pstatus, 200);
    assert!(
        result_ids(&projects).is_empty(),
        "after the rejected self-mint, bob must STILL see zero projects; got {projects}",
    );
}

/// The credential table holds `key_hash` and is never client-created; locking it
/// read-only means a non-member cannot POST into it either.
#[tokio::test]
async fn non_member_cannot_create_agent_credential() {
    let (_, seed) = app().await;
    let (status, body) = post_as(
        seed.bob,
        "/api/taskflow_agent_credential/",
        serde_json::json!({ "project": seed.project_p }),
    )
    .await;
    assert!(
        status == 405 || status == 403 || status == 404,
        "taskflow_agent_credential must be read-only via REST; got {status}: {body}",
    );
}

#[tokio::test]
async fn superuser_sees_all_projects() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.root, true, "/api/taskflow_project/").await;
    assert_eq!(status, 200);
    let ids = result_ids(&body);
    assert!(
        ids.contains(&seed.project_p) && ids.contains(&seed.project_q),
        "a superuser must see every project; got {body}",
    );
}
