//! Realtime group-policy membership gate.
//!
//! `project:{id}:*` rooms carry projected fields (chat `body_markdown` among
//! them). Before this gate any authenticated user could join any project room
//! and receive them over SSE. `backend::realtime::may_join` now admits a caller
//! only when they are an active member of that project (superuser: any).
//!
//! `may_join` runs the membership query from `GroupPolicy::can_join`'s
//! synchronous context via `block_in_place` + a runtime handle, which is valid
//! only on a MULTI-THREADED runtime — hence `flavor = "multi_thread"`. On the
//! default current-thread test runtime it would panic, which mirrors the
//! production `#[tokio::main]` (multi-thread) contract exactly.

use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::boot;

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

use backend::realtime::may_join;

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

async fn make_project(slug: &str) -> i64 {
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: slug.to_string(),
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

/// One test so `boot` + seed run exactly once; the assertions are the interesting
/// part.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn membership_gates_project_rooms() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
    })
    .await;

    let alice = make_user("rt-alice", false).await;
    let bob = make_user("rt-bob", false).await;
    let root = make_user("rt-root", true).await;

    let p = make_project("rt-project-p").await;
    let q = make_project("rt-project-q").await;

    make_member(p, alice, TaskflowMembershipStatus::Active).await;
    // A non-active membership in Q must NOT grant access.
    make_member(q, alice, TaskflowMembershipStatus::Invited).await;

    let (alice, bob, root) = (alice.to_string(), bob.to_string(), root.to_string());
    let p_msgs = format!("project:{p}:messages");
    let q_msgs = format!("project:{q}:messages");

    // Member of P → may join P's rooms.
    assert!(
        may_join(Some(&alice), &p_msgs),
        "an active member of P must be able to join {p_msgs}",
    );
    // Not an active member of Q (only `invited`) → may NOT join Q's rooms.
    assert!(
        !may_join(Some(&alice), &q_msgs),
        "alice is only `invited` to Q and must not join {q_msgs}",
    );
    // A user with no membership at all → nothing.
    assert!(
        !may_join(Some(&bob), &p_msgs),
        "a non-member must not join {p_msgs}",
    );
    // Superuser → any project room.
    assert!(
        may_join(Some(&root), &q_msgs),
        "a superuser must be able to join any project room",
    );
    // Anonymous → nothing.
    assert!(
        !may_join(None, &p_msgs),
        "anonymous callers must not join project rooms",
    );
    // The projects-list group stays open to any authenticated user.
    assert!(
        may_join(Some(&alice), "taskflow:projects"),
        "an authenticated user may join the projects-list group",
    );
    assert!(
        !may_join(None, "taskflow:projects"),
        "anonymous callers may not even join the projects-list group",
    );
    // A malformed / unknown group is still rejected regardless of membership.
    assert!(
        !may_join(Some(&root), "project:{p}:bogus"),
        "unknown suffixes stay rejected even for a superuser",
    );
}
