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
use axum::body::Body;
use http::Method;
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
    TaskflowChannelMemberKind, TaskflowChannelReadCursor, TaskflowMessageAttachment,
    TaskflowMessagePriority,
};
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
    /// A second ACTIVE member of project P — the person alice must not spy on.
    carol: i64,
    /// The project room in P: shared, so both members see it.
    shared_channel: i64,
    /// Alice's DM. Carol is in the same project but NOT on this roster.
    alice_dm: i64,
    /// Carol's DM. Alice must never see it, nor its messages.
    carol_dm: i64,
    /// A Direct channel rostered to `dave` and nobody else — the DM an intruder
    /// tries to write themselves onto. Kept separate from `carol_dm` so the
    /// escalation tests never perturb the rows the DM-privacy tests read.
    private_dm: i64,
    /// An attachment on a message in `carol_dm`. Alice must never see it — the
    /// row exposes the storage key, and `/media/<key>` serves the file.
    carol_dm_attachment: i64,
    /// An attachment in `shared_channel`, which both alice and carol are on.
    shared_attachment: i64,
    /// Carol's read cursor in her own DM. It names her, the channel and when she
    /// read it — alice must not be able to list it.
    carol_dm_cursor: i64,
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

    // Two people in the SAME project, each with their own DM. Project scope
    // alone made these visible to each other: every row carries the same
    // `project` FK, so "restrict to my projects" let a member read a private
    // conversation they were never on.
    let carol = make_user("carol", false).await;
    make_member(project_p, carol, TaskflowMembershipStatus::Active).await;

    let shared_channel = make_channel(project_p, "Project room", TaskflowChannelKind::Project).await;
    make_channel_member(project_p, shared_channel, alice).await;
    make_channel_member(project_p, shared_channel, carol).await;
    let shared_message = make_message(project_p, shared_channel, "shared hello").await;
    // A file in a room both alice and carol are on — the control case, proving
    // the new scope does not over-restrict.
    let shared_attachment = make_attachment(project_p, shared_channel, shared_message, "shared-deck.pdf").await;

    let alice_dm = make_channel(project_p, "alice dm", TaskflowChannelKind::Direct).await;
    make_channel_member(project_p, alice_dm, alice).await;
    make_message(project_p, alice_dm, "alice private").await;

    let carol_dm = make_channel(project_p, "carol dm", TaskflowChannelKind::Direct).await;
    make_channel_member(project_p, carol_dm, carol).await;
    let carol_dm_message = make_message(project_p, carol_dm, "carol private").await;
    // The file alice must never reach. Its storage key is the sensitive part:
    // `/media/<key>` serves it.
    let carol_dm_attachment =
        make_attachment(project_p, carol_dm, carol_dm_message, "carol-secret.pdf").await;
    let carol_dm_cursor = make_read_cursor(project_p, carol_dm, carol, carol_dm_message).await;

    // A DM belonging to a third person entirely. The roster-escalation tests
    // target this one, so nothing they do can disturb alice's or carol's rows.
    let dave = make_user("dave", false).await;
    make_member(project_p, dave, TaskflowMembershipStatus::Active).await;
    let private_dm = make_channel(project_p, "dave dm", TaskflowChannelKind::Direct).await;
    make_channel_member(project_p, private_dm, dave).await;
    make_message(project_p, private_dm, "dave private").await;

    Seed {
        alice,
        bob,
        root,
        project_p,
        project_q,
        carol,
        shared_channel,
        alice_dm,
        carol_dm,
        private_dm,
        carol_dm_attachment,
        shared_attachment,
        carol_dm_cursor,
    }
}

/// `user`'s read cursor in `channel`.
async fn make_read_cursor(project: i64, channel: i64, user: i64, message: i64) -> i64 {
    TaskflowChannelReadCursor::objects()
        .create(TaskflowChannelReadCursor {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            member_user: Some(ForeignKey::new(user)),
            member_agent: None,
            last_read_message: Some(ForeignKey::new(message)),
            last_read_at: chrono::Utc::now(),
            created_at: None,
        })
        .await
        .expect("create read cursor")
        .id
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

async fn make_message(project: i64, channel: i64, body: &str) -> i64 {
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
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .expect("create message")
        .id
}

/// A file attached to `message`. `project` is denormalized exactly as the
/// trusted send endpoint does it.
async fn make_attachment(project: i64, channel: i64, message: i64, name: &str) -> i64 {
    TaskflowMessageAttachment::objects()
        .create(TaskflowMessageAttachment {
            id: 0,
            message: ForeignKey::new(message),
            project: ForeignKey::new(project),
            channel: Some(ForeignKey::new(channel)),
            file: umbral::orm::FileField::from(format!("uploads/{name}")),
            name: name.to_string(),
            content_type: "application/pdf".to_string(),
            size_bytes: 1234,
            created_at: None,
        })
        .await
        .expect("create attachment")
        .id
}


/// Status only — a 404 renders an HTML error page, and `body_json` panics on it.
async fn status_as(user: i64, path: &str) -> u16 {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    client.get(path).await.status().as_u16()
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

/// PATCH `body` to `path` as `user`. Fresh client per call so the per-user
/// header never races across concurrent tests.
async fn patch_as(user: i64, path: &str, body: Value) -> (u16, Value) {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    client.set_default_header(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    let bytes = serde_json::to_vec(&body).expect("serialize body");
    let res = client
        .send(Method::PATCH, path, Body::from(bytes))
        .await;
    (res.status().as_u16(), res.body_json())
}

/// DELETE `path` as `user`. Fresh client per call so the per-user header
/// never races across concurrent tests.
async fn delete_as(user: i64, path: &str) -> u16 {
    let (router, _) = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        HeaderName::from_static("x-user"),
        HeaderValue::from_str(&user.to_string()).unwrap(),
    );
    client.delete(path).await.status().as_u16()
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


// --- DM privacy -------------------------------------------------------------
//
// The reported symptom: one member of a project saw another member's DM with an
// agent, unread count and all. Project scope is the wrong boundary for chat.

#[tokio::test]
async fn a_member_cannot_list_another_members_dm() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_agent_channel/").await;
    assert_eq!(status, 200);

    let ids: Vec<i64> = body["results"]
        .as_array()
        .expect("results")
        .iter()
        .filter_map(|row| row["id"].as_i64())
        .collect();

    assert!(ids.contains(&seed.shared_channel), "shared rooms stay visible");
    assert!(ids.contains(&seed.alice_dm), "her own DM stays visible");
    assert!(
        !ids.contains(&seed.carol_dm),
        "carol's DM must NOT be listed for alice, got {ids:?}"
    );
}

#[tokio::test]
async fn a_member_cannot_read_messages_from_another_members_dm() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_agent_message/").await;
    assert_eq!(status, 200);

    let bodies: Vec<String> = body["results"]
        .as_array()
        .expect("results")
        .iter()
        .filter_map(|row| row["body_markdown"].as_str().map(str::to_string))
        .collect();

    assert!(bodies.iter().any(|b| b == "shared hello"), "shared room messages stay visible");
    assert!(bodies.iter().any(|b| b == "alice private"), "her own DM stays readable");
    assert!(
        !bodies.iter().any(|b| b == "carol private"),
        "another member's DM message leaked: {bodies:?}"
    );
}

// Read cursors are channel-scoped, and were not.
//
// `taskflow_channel_read_cursor` sat in BOTH `CHANNEL_SCOPED_TABLES` and
// `READ_ONLY_PROJECT_SCOPED_TABLES`, so it was registered twice.
// `RestPlugin::resource` is last-write-wins on the scope and the read-only pass
// ran second, so the project scope silently replaced the channel scope: every
// project member could read who had read which DM message, and when.
#[tokio::test]
async fn a_member_cannot_list_read_cursors_from_another_members_dm() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_channel_read_cursor/").await;
    assert_eq!(status, 200);
    let ids = result_ids(&body);
    assert!(
        !ids.contains(&seed.carol_dm_cursor),
        "a read cursor from another member's DM leaked: {ids:?}"
    );
}

// Attachments follow their CHANNEL, not their project.
//
// The row carries the storage key, and `/media/<key>` serves the file, so a
// leaked attachment row is a leaked file. `project` is denormalized onto this
// table for query convenience, and scoping by it made every DM's files readable
// by every member of the project.
#[tokio::test]
async fn a_member_cannot_list_attachments_from_another_members_dm() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.alice, false, "/api/taskflow_message_attachment/").await;
    assert_eq!(status, 200);
    let ids = result_ids(&body);
    assert!(
        ids.contains(&seed.shared_attachment),
        "a file in a room alice is on must stay visible: {ids:?}"
    );
    assert!(
        !ids.contains(&seed.carol_dm_attachment),
        "another member's DM attachment leaked: {ids:?}"
    );
}

// The storage key is the payload here — listing is not the only way to reach it.
#[tokio::test]
async fn fetching_another_members_dm_attachment_by_id_is_not_found() {
    let (_, seed) = app().await;
    let status = status_as(
        seed.alice,
        &format!("/api/taskflow_message_attachment/{}", seed.carol_dm_attachment),
    )
    .await;
    assert_eq!(
        status, 404,
        "an attachment on a DM you are not on must not be retrievable by id"
    );
}

// The scope must not over-correct: carol owns the DM and must still get her file.
#[tokio::test]
async fn the_dm_owner_still_sees_their_own_attachment() {
    let (_, seed) = app().await;
    let status = status_as(
        seed.carol,
        &format!("/api/taskflow_message_attachment/{}", seed.carol_dm_attachment),
    )
    .await;
    assert_eq!(status, 200, "carol is on this DM and must still read its file");
}

// Retrieve-by-id must be gated too: hiding a row from the list while serving it
// to anyone who guesses the id is not a boundary.
#[tokio::test]
async fn fetching_another_members_dm_by_id_is_not_found() {
    let (_, seed) = app().await;
    let status = status_as(seed.alice, &format!("/api/taskflow_agent_channel/{}", seed.carol_dm)).await;
    assert_eq!(status, 404, "a DM you are not on must not be retrievable by id");
}

#[tokio::test]
async fn the_dm_owner_still_sees_their_own() {
    let (_, seed) = app().await;
    let status = status_as(seed.carol, &format!("/api/taskflow_agent_channel/{}", seed.carol_dm)).await;
    assert_eq!(status, 200, "carol must still see her own DM");
}

// --- Channel/roster writes are not client business ---------------------------

/// The escalation this whole change exists to stop: `visible_channel_ids` decides
/// DM access by READING the roster, so a client-writable roster let a project
/// member opt into any DM with one POST.
#[tokio::test]
async fn a_member_cannot_post_themselves_onto_someone_elses_dm() {
    let (_, seed) = app().await;
    let intruder = make_user("intruder", false).await;
    make_member(seed.project_p, intruder, TaskflowMembershipStatus::Active).await;

    let (status, body) = post_as(
        intruder,
        "/api/taskflow_agent_channel_member/",
        serde_json::json!({
            "project": seed.project_p,
            "channel": seed.private_dm,
            "member_kind": "user",
            "user": intruder,
            "display_name": "intruder",
            "role": "member",
        }),
    )
    .await;

    // 405, observed, not assumed: before the fix this POST returned 201. umbral
    // mounts a method per exposed action (`exposed_methods` in umbral-rest), so
    // dropping Create unmounts POST while the collection path itself stays (GET
    // List is still exposed) — the method router answers 405 Method Not Allowed
    // with an `Allow: GET`. It is 405 rather than 403 because this is a property
    // of the resource, not of who is asking.
    assert_eq!(
        status, 405,
        "roster create must be refused, got {status}: {body}",
    );

    // And the DM is still invisible to them.
    let (_, channels) = get_as(intruder, false, "/api/taskflow_agent_channel/").await;
    assert!(
        !result_ids(&channels).contains(&seed.private_dm),
        "DM must stay hidden; got {channels}",
    );
}

/// Channels come only from `POST /api/taskflow/channels`, which writes the
/// channel and its roster in one transaction. An auto-REST create would make a
/// channel with no roster — invisible to its own creator.
#[tokio::test]
async fn auto_rest_cannot_create_a_channel() {
    let (_, seed) = app().await;
    let member = make_user("creator_via_rest", false).await;
    make_member(seed.project_p, member, TaskflowMembershipStatus::Active).await;

    let (status, body) = post_as(
        member,
        "/api/taskflow_agent_channel/",
        serde_json::json!({ "project": seed.project_p, "kind": "direct", "title": "Sneaky" }),
    )
    .await;

    assert_eq!(
        status, 405,
        "channel create must go through POST /api/taskflow/channels, got {status}: {body}",
    );
}

/// `Update`/`Delete` were left mounted on `taskflow_agent_channel` on the
/// claim that "the frontend renames and archives" — false. A grep of every
/// `taskflowApi.update|remove|delete` call in `v2_fe/src` shows only `tasks`,
/// `taskSessions`, and `projects` are ever mutated that way; `archived` is
/// read-only in the UI. Unlike the roster/message holes above,
/// `channel_scope("id")` already limits Update/Delete to a channel the caller
/// can already see — but every active project member CAN see the shared
/// project room, so a live PATCH could flip `kind` to "direct" and hide the
/// room from every human: `visible_channel_ids` requires a roster row for
/// Direct channels, and `ensure_project_room` only ever writes roster rows for
/// agents, never for the humans who share the room.
#[tokio::test]
async fn a_member_cannot_rename_or_archive_the_shared_room_via_patch() {
    let (_, seed) = app().await;

    let (status, body) = patch_as(
        seed.alice,
        &format!("/api/taskflow_agent_channel/{}", seed.shared_channel),
        serde_json::json!({ "kind": "direct" }),
    )
    .await;

    // 405, observed not assumed: umbral mounts PUT/PATCH on the detail route
    // only when Update is exposed (`exposed_methods`, umbral-rest src/lib.rs:
    // 533-535); dropping it unmounts both while GET (Retrieve) stays mounted,
    // so the method router answers 405 rather than 404.
    assert_eq!(
        status, 405,
        "channel PATCH must be refused, got {status}: {body}",
    );

    // And the room is untouched: still a Project channel, still visible to
    // every member.
    let (rstatus, row) = get_as(
        seed.alice,
        false,
        &format!("/api/taskflow_agent_channel/{}", seed.shared_channel),
    )
    .await;
    assert_eq!(rstatus, 200);
    assert_eq!(
        row["kind"], "project",
        "the shared room must still be a Project channel, got {row}",
    );
}

/// The other half of the same finding: DELETE cascades every message in the
/// channel (`taskflow_agent_message.channel` is `on_delete = "cascade"`), and
/// `channel_scope` cannot stop it — the shared project room is exactly the
/// channel every member is scoped to see.
#[tokio::test]
async fn a_member_cannot_delete_the_shared_room() {
    let (_, seed) = app().await;

    let status = delete_as(
        seed.alice,
        &format!("/api/taskflow_agent_channel/{}", seed.shared_channel),
    )
    .await;

    // 405 for the same reason as the PATCH: dropping Delete unmounts DELETE
    // while GET stays mounted for List/Retrieve.
    assert_eq!(status, 405, "channel DELETE must be refused, got {status}");

    // And it — and its message — survive, for every member, not just alice.
    let rstatus = status_as(
        seed.carol,
        &format!("/api/taskflow_agent_channel/{}", seed.shared_channel),
    )
    .await;
    assert_eq!(rstatus, 200, "the shared room must still exist for carol");

    let (_, messages) = get_as(seed.carol, false, "/api/taskflow_agent_message/").await;
    assert!(
        messages["results"]
            .as_array()
            .expect("results")
            .iter()
            .any(|row| row["body_markdown"].as_str() == Some("shared hello")),
        "the shared room's message must survive the refused delete; got {messages}",
    );
}

/// The actions that stayed. Stripping create must not have taken reads with it:
/// the frontend lists channels and rosters constantly, and `visible_channel_ids`
/// itself reads the roster table.
#[tokio::test]
async fn channels_and_rosters_are_still_readable() {
    let (_, seed) = app().await;

    let (status, channels) = get_as(seed.carol, false, "/api/taskflow_agent_channel/").await;
    assert_eq!(status, 200, "listing channels must still work; got {channels}");
    assert!(
        result_ids(&channels).contains(&seed.carol_dm),
        "carol must still list her own DM; got {channels}",
    );

    let (status, roster) = get_as(seed.carol, false, "/api/taskflow_agent_channel_member/").await;
    assert_eq!(status, 200, "listing rosters must still work; got {roster}");
    assert!(
        !roster["results"].as_array().expect("results").is_empty(),
        "carol must still see her own roster rows; got {roster}",
    );
}

/// The same create-path hole as the roster, one table over: `scope_async` governs
/// READS, so a writable message table let a project member POST into a DM they
/// cannot list or retrieve — and `sender_label`/`sender_user` were taken verbatim
/// from the body, making it forgery as well as injection. The SSE fan-out then
/// delivered the forged message to the real participants.
#[tokio::test]
async fn a_member_cannot_inject_a_message_into_someone_elses_dm() {
    let (_, seed) = app().await;
    let intruder = make_user("message_intruder", false).await;
    make_member(seed.project_p, intruder, TaskflowMembershipStatus::Active).await;

    // Targeting dave's DM, which the intruder cannot see at all.
    let (status, body) = post_as(
        intruder,
        "/api/taskflow_agent_message/",
        serde_json::json!({
            "project": seed.project_p,
            "channel": seed.private_dm,
            "sender_kind": "user",
            "sender_user": seed.alice,
            "sender_label": "alice",
            "body_markdown": "forged",
            "priority": "normal",
        }),
    )
    .await;

    // 405 for the same reason as the roster: dropping Create unmounts POST while
    // the collection path stays for GET List. Observed, not assumed — before the
    // fix this returned 201 Created.
    assert_eq!(
        status, 405,
        "message create must go through POST /api/taskflow/agents/messages, got {status}: {body}",
    );

    // And nothing landed: the DM's participant must not see the forged message.
    let (_, messages) = get_as(seed.root, true, "/api/taskflow_agent_message/").await;
    assert!(
        !messages["results"]
            .as_array()
            .expect("results")
            .iter()
            .any(|row| row["body_markdown"].as_str() == Some("forged")),
        "no forged message may be persisted; got {messages}",
    );
}

/// Stripping create must not have taken reads with it — the frontend lists
/// messages constantly.
#[tokio::test]
async fn messages_are_still_readable() {
    let (_, seed) = app().await;

    let (status, messages) = get_as(seed.carol, false, "/api/taskflow_agent_message/").await;
    assert_eq!(status, 200, "listing messages must still work; got {messages}");

    let bodies: Vec<String> = messages["results"]
        .as_array()
        .expect("results")
        .iter()
        .filter_map(|row| row["body_markdown"].as_str().map(str::to_string))
        .collect();

    assert!(
        bodies.iter().any(|b| b == "shared hello"),
        "the shared room message must still be listed; got {bodies:?}",
    );
    assert!(
        bodies.iter().any(|b| b == "carol private"),
        "carol's own DM message must still be listed; got {bodies:?}",
    );
}

// Prompts carry a question an agent is blocked on, and answering one sends
// keystrokes into a live terminal. They were exposed with NO scope at all.
#[tokio::test]
async fn prompts_are_project_scoped() {
    let (_, seed) = app().await;
    let (status, body) = get_as(seed.bob, false, "/api/taskflow_agent_prompt/").await;
    assert_eq!(status, 200);
    assert_eq!(
        body["results"].as_array().map(Vec::len),
        Some(0),
        "a user with no memberships must see no prompts"
    );
}

// The dialog persists owner/operator/due/estimate/review through the auto-REST
// create; before these columns existed they were silently dropped.
#[tokio::test]
async fn task_create_round_trips_the_new_columns() {
    let (_, seed) = app().await;
    let (status, body) = post_as(
        seed.alice,
        "/api/taskflow_task/",
        serde_json::json!({
            "project": seed.project_p,
            "title": "with real fields",
            "description_markdown": "d",
            "review_gate": "human signs off",
            "estimate_minutes": 90,
            "operator_agent_id": 7,
            "created_by": seed.alice,
        }),
    )
    .await;
    assert_eq!(status, 201, "create failed: {body:?}");
    let id = body["id"].as_i64().unwrap();
    let (_s, got) = get_as(seed.alice, false, &format!("/api/taskflow_task/{id}")).await;
    assert_eq!(got["review_gate"], serde_json::json!("human signs off"));
    assert_eq!(got["estimate_minutes"], serde_json::json!(90));
    assert_eq!(got["operator_agent_id"], serde_json::json!(7));
    assert_eq!(got["created_by"], serde_json::json!(seed.alice));
}
