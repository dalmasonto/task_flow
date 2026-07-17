//! The invite accept/decline flow: identity comes from the auth token, the
//! authorization boundary is the invite's email matching the caller's account,
//! and every path is idempotent-friendly.

use chrono::{Duration, Utc};
use serde_json::json;

mod support;
use support::{TestApp, seed_invite, seed_project};
use taskflow_projects::models::TaskflowInviteStatus;

// --- accept -----------------------------------------------------------------

#[tokio::test]
async fn accept_by_correct_email_creates_active_membership() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    let token = seed_invite(project, &user.email, TaskflowInviteStatus::Pending, None).await;

    let res = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/accept"))
        .await;

    assert_eq!(res.status(), 200);
    let row = res.json();
    assert_eq!(row["status"], json!("active"));
    assert_eq!(row["project"], json!(project));
    assert_eq!(row["user"], json!(user.id));
    assert_eq!(row["member_key"], json!(format!("user:{}", user.id)));
    assert_eq!(app.count_active_members(project, user.id).await, 1);
}

#[tokio::test]
async fn accept_by_wrong_email_is_403_and_creates_no_membership() {
    let app = TestApp::new().await;
    let invitee = app.create_user().await;
    let attacker = app.create_user().await;
    let project = seed_project().await;
    // Invite addressed to the invitee; the attacker holds the token.
    let token = seed_invite(project, &invitee.email, TaskflowInviteStatus::Pending, None).await;

    let res = app
        .post_as(
            attacker.id,
            &format!("/api/taskflow/projects/invites/{token}/accept"),
        )
        .await;

    assert_eq!(res.status(), 403);
    assert_eq!(app.count_members(project).await, 0);
}

#[tokio::test]
async fn second_accept_is_idempotent_single_membership() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    let token = seed_invite(project, &user.email, TaskflowInviteStatus::Pending, None).await;

    let first = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/accept"))
        .await;
    let second = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/accept"))
        .await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json()["id"], second.json()["id"]);
    assert_eq!(app.count_members(project).await, 1);
}

#[tokio::test]
async fn accept_expired_invite_is_410() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    let expired = Some(Utc::now() - Duration::hours(1));
    let token = seed_invite(project, &user.email, TaskflowInviteStatus::Pending, expired).await;

    let res = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/accept"))
        .await;

    assert_eq!(res.status(), 410);
    assert_eq!(app.count_members(project).await, 0);
}

#[tokio::test]
async fn accept_unknown_token_is_404() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let res = app
        .post_as(user.id, "/api/taskflow/projects/invites/does-not-exist/accept")
        .await;

    assert_eq!(res.status(), 404);
}

// --- decline ----------------------------------------------------------------

#[tokio::test]
async fn decline_sets_declined_and_creates_no_membership() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    let token = seed_invite(project, &user.email, TaskflowInviteStatus::Pending, None).await;

    let res = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/decline"))
        .await;

    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["status"], json!("declined"));
    assert_eq!(app.count_members(project).await, 0);

    // Idempotent: declining again is still 200.
    let again = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/decline"))
        .await;
    assert_eq!(again.status(), 200);
    assert_eq!(again.json()["status"], json!("declined"));
}

#[tokio::test]
async fn decline_by_wrong_email_is_403() {
    let app = TestApp::new().await;
    let invitee = app.create_user().await;
    let attacker = app.create_user().await;
    let project = seed_project().await;
    let token = seed_invite(project, &invitee.email, TaskflowInviteStatus::Pending, None).await;

    let res = app
        .post_as(
            attacker.id,
            &format!("/api/taskflow/projects/invites/{token}/decline"),
        )
        .await;

    assert_eq!(res.status(), 403);
}

// --- mine (inbox) -----------------------------------------------------------

#[tokio::test]
async fn mine_returns_only_callers_pending_unexpired_invites() {
    let app = TestApp::new().await;
    let me = app.create_user().await;
    let other = app.create_user().await;
    let project = seed_project().await;

    // Addressed to me, pending → visible.
    let mine_token = seed_invite(project, &me.email, TaskflowInviteStatus::Pending, None).await;
    // Addressed to someone else → not mine.
    seed_invite(project, &other.email, TaskflowInviteStatus::Pending, None).await;
    // Addressed to me but expired → hidden.
    let expired = Some(Utc::now() - Duration::hours(1));
    seed_invite(project, &me.email, TaskflowInviteStatus::Pending, expired).await;
    // Addressed to me but already accepted → not pending, hidden.
    seed_invite(project, &me.email, TaskflowInviteStatus::Accepted, None).await;

    let res = app.get_as(me.id, "/api/taskflow/projects/invites/mine").await;

    assert_eq!(res.status(), 200);
    let rows = res.json();
    let arr = rows.as_array().expect("array");
    assert_eq!(arr.len(), 1, "expected exactly one invite, got {arr:?}");
    assert_eq!(arr[0]["invite_token"], json!(mine_token));
    assert_eq!(arr[0]["project_name"].is_string(), true);
}
