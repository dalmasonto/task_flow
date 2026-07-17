//! The invite accept/decline flow: identity comes from the auth token, the
//! authorization boundary is the invite's email matching the caller's account,
//! and every path is idempotent-friendly.

use chrono::{Duration, Utc};
use serde_json::json;

mod support;
use support::{TestApp, seed_invite, seed_member, seed_project};
use taskflow_projects::models::{
    TaskflowInviteStatus, TaskflowMembershipStatus, TaskflowProjectRole,
};

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

// --- create (authorized mint) -----------------------------------------------

#[tokio::test]
async fn owner_creates_invite_with_server_minted_token() {
    let app = TestApp::new().await;
    let owner = app.create_user().await;
    let project = seed_project().await;
    seed_member(
        project,
        owner.id,
        TaskflowProjectRole::Owner,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let res = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/projects/{project}/invites"),
            json!({
                "email": "invitee@example.test",
                "role": "developer",
                // A body-supplied token must be ignored — the server mints its own.
                "invite_token": "attacker-chosen",
                "status": "accepted",
            }),
        )
        .await;

    assert_eq!(res.status(), 200);
    let row = res.json();
    assert_eq!(row["project"], json!(project));
    assert_eq!(row["email"], json!("invitee@example.test"));
    assert_eq!(row["role"], json!("developer"));
    assert_eq!(row["status"], json!("pending"), "status is forced to pending");
    assert_eq!(row["invited_by"], json!(owner.id));
    assert!(
        row["expires_at"].is_string(),
        "an expiry window must be set server-side; got {row}",
    );
    let token = row["invite_token"].as_str().expect("token string");
    assert_ne!(token, "attacker-chosen", "the body token must be ignored");
    assert!(
        token.starts_with("inv_") && token.len() > 8,
        "token must be a server-minted, unguessable value; got {token}",
    );
}

#[tokio::test]
async fn admin_can_create_invite() {
    let app = TestApp::new().await;
    let admin = app.create_user().await;
    let project = seed_project().await;
    seed_member(
        project,
        admin.id,
        TaskflowProjectRole::Admin,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let res = app
        .post_body_as(
            admin.id,
            &format!("/api/taskflow/projects/{project}/invites"),
            json!({ "email": "dev@example.test", "role": "developer" }),
        )
        .await;

    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn non_member_cannot_create_invite() {
    let app = TestApp::new().await;
    let stranger = app.create_user().await;
    let project = seed_project().await;

    let res = app
        .post_body_as(
            stranger.id,
            &format!("/api/taskflow/projects/{project}/invites"),
            json!({ "email": "x@example.test", "role": "developer" }),
        )
        .await;

    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn viewer_and_developer_cannot_create_invite() {
    let app = TestApp::new().await;
    let project = seed_project().await;

    for role in [TaskflowProjectRole::Viewer, TaskflowProjectRole::Developer] {
        let user = app.create_user().await;
        seed_member(project, user.id, role, TaskflowMembershipStatus::Active).await;
        let res = app
            .post_body_as(
                user.id,
                &format!("/api/taskflow/projects/{project}/invites"),
                json!({ "email": "x@example.test", "role": "viewer" }),
            )
            .await;
        assert_eq!(res.status(), 403, "role {role:?} must not be able to invite");
    }
}

#[tokio::test]
async fn admin_cannot_mint_owner_invite() {
    let app = TestApp::new().await;
    let admin = app.create_user().await;
    let project = seed_project().await;
    seed_member(
        project,
        admin.id,
        TaskflowProjectRole::Admin,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let res = app
        .post_body_as(
            admin.id,
            &format!("/api/taskflow/projects/{project}/invites"),
            json!({ "email": "boss@example.test", "role": "owner" }),
        )
        .await;

    assert_eq!(
        res.status(),
        403,
        "an admin may not invite at a role above its own (owner)",
    );
}

#[tokio::test]
async fn owner_can_mint_owner_invite() {
    let app = TestApp::new().await;
    let owner = app.create_user().await;
    let project = seed_project().await;
    seed_member(
        project,
        owner.id,
        TaskflowProjectRole::Owner,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let res = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/projects/{project}/invites"),
            json!({ "email": "co-owner@example.test", "role": "owner" }),
        )
        .await;

    assert_eq!(res.status(), 200, "an owner may invite another owner");
}

// --- suspended-member self-reactivation (MEDIUM) ----------------------------

#[tokio::test]
async fn suspended_member_accepting_invite_is_not_reactivated() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    // The user was suspended by an admin — a terminal state.
    seed_member(
        project,
        user.id,
        TaskflowProjectRole::Developer,
        TaskflowMembershipStatus::Suspended,
    )
    .await;
    // A fresh pending invite addressed to their own email.
    let token = seed_invite(project, &user.email, TaskflowInviteStatus::Pending, None).await;

    let res = app
        .post_as(user.id, &format!("/api/taskflow/projects/invites/{token}/accept"))
        .await;

    assert_eq!(
        res.status(),
        403,
        "a suspended member must not self-reactivate by accepting an invite",
    );
    assert_eq!(
        app.member_status(project, user.id).await.as_deref(),
        Some("suspended"),
        "the membership must stay suspended",
    );
    assert_eq!(
        app.count_active_members(project, user.id).await,
        0,
        "no active membership may result",
    );
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
