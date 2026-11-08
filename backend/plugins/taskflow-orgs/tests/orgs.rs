//! #1133: org foundations. What must hold:
//! - a new project lands in its owner's personal org (one per user); the
//!   backfill places unlinked projects by the written rule, idempotently;
//! - org roles gate only org routes: an outsider gets 404, billing reads seats
//!   but no members and no project, and NO org role opens a project;
//! - invites: hash-only, single use, expiring, email-bound, throttled; resend
//!   rotates the token; accepting grants the org role only;
//! - the last owner can't be demoted or removed; only an owner touches owner.

mod support;

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use support::{TestApp, email_of, seed_member, seed_project};
use taskflow_orgs::models::{TaskflowOrgInvite, TaskflowOrgProject, taskflow_org_invite, taskflow_org_project};
use taskflow_orgs::service;

async fn org_of(project: i64) -> i64 {
    service::org_of_project(project).await.unwrap().expect("project has an org")
}

async fn invite(app: &TestApp, by: i64, org: i64, email: &str, role: &str) -> (u16, Value) {
    let r = app.post_json_as(by, &format!("/api/taskflow/orgs/{org}/invites"), json!({ "email": email, "role": role })).await;
    let s = r.status();
    (s, serde_json::from_str(&r.text()).unwrap_or(Value::Null))
}

async fn accept(app: &TestApp, who: i64, token: &str) -> (u16, Value) {
    let r = app.post_json_as(who, "/api/taskflow/org-invites/accept", json!({ "token": token })).await;
    let s = r.status();
    (s, serde_json::from_str(&r.text()).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_project_lands_in_its_owners_personal_org_and_the_backfill_follows_the_rule() {
    let app = TestApp::new().await;
    let (owner, p1) = seed_project(&app).await;
    let org = org_of(p1).await;
    let mine = app.get_as(owner.id, "/api/taskflow/orgs").await.json().await;
    assert_eq!(mine["results"][0]["id"], org);
    assert_eq!(mine["results"][0]["my_role"], "owner");
    assert_eq!(mine["results"][0]["personal"], true);

    // The backfill rule: the active owner-role MEMBER with the lowest id wins
    // over the `owner` column. Unlink a project and give it such a member.
    let (_, p2) = seed_project(&app).await;
    let lead = app.create_user().await;
    seed_member(p2, lead, "owner").await;
    TaskflowOrgProject::objects().filter(taskflow_org_project::PROJECT.eq(p2)).delete().await.unwrap();
    assert!(service::org_of_project(p2).await.unwrap().is_none());
    assert!(service::backfill_once().await.unwrap() >= 1);
    let lead_org = service::personal_org(lead).await.unwrap();
    assert_eq!(org_of(p2).await, lead_org.id, "placed with the owner-role member, not the owner column");
    // Idempotent: nothing left to place, and nobody gets a second personal org.
    assert_eq!(service::backfill_once().await.unwrap(), 0);
    assert_eq!(service::personal_org(lead).await.unwrap().id, lead_org.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn org_roles_open_org_routes_only_never_a_project() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let org = org_of(project).await;
    let outsider = app.create_user().await;
    let billing = app.create_user().await;
    let (_, inv) = invite(&app, owner.id, org, &email_of(billing).await, "billing").await;
    assert_eq!(accept(&app, billing, inv["token"].as_str().unwrap()).await.0, 200);

    // An outsider learns nothing, not even that the org exists.
    for path in [format!("/api/taskflow/orgs/{org}"), format!("/api/taskflow/orgs/{org}/members"), format!("/api/taskflow/orgs/{org}/invites")] {
        assert_eq!(app.get_as(outsider, &path).await.status(), 404, "{path}");
    }
    // Billing reads the org and its seats, but no project and no people.
    let o = app.get_as(billing, &format!("/api/taskflow/orgs/{org}")).await;
    assert_eq!(o.status(), 200);
    let o = o.json().await;
    assert_eq!(o["my_role"], "billing");
    assert_eq!(o["seats_used"], 2);
    assert_eq!(o["project_count"], 1);
    assert_eq!(o["projects"], json!([]), "billing sees no project");
    assert_eq!(app.get_as(billing, &format!("/api/taskflow/orgs/{org}/members")).await.status(), 403);
    assert!(!taskflow_projects::scope::can_access_project(billing, project).await, "an org role never opens a project");
    // The owner sees the project (by its project membership).
    let o = app.get_as(owner.id, &format!("/api/taskflow/orgs/{org}")).await.json().await;
    assert_eq!(o["projects"][0]["id"], project);
}

#[tokio::test(flavor = "multi_thread")]
async fn invites_are_hashed_single_use_email_bound_expiring_and_rotate_on_resend() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    let org = org_of(project).await;
    let invitee = app.create_user().await;
    let stranger = app.create_user().await;
    let email = email_of(invitee).await;

    let (s, inv) = invite(&app, owner.id, org, &email.to_uppercase(), "member").await;
    assert_eq!(s, 201, "{inv}");
    let token = inv["token"].as_str().unwrap().to_string();
    let row = TaskflowOrgInvite::objects().filter(taskflow_org_invite::ID.eq(inv["id"].as_i64().unwrap())).first().await.unwrap().unwrap();
    assert_ne!(row.token_hash, token, "only the hash is stored");
    assert_eq!(row.email, email, "stored lowercased");
    assert_eq!((row.expires_at - Utc::now()).num_days(), 6, "a 7-day expiry");
    // The list never carries a token; a duplicate invite is refused.
    let list = app.get_as(owner.id, &format!("/api/taskflow/orgs/{org}/invites")).await.json().await;
    assert!(list["results"][0].get("token").is_none());
    assert_eq!(invite(&app, owner.id, org, &email, "member").await.0, 409);

    // Peek: the stranger sees whose invite it is, and that it isn't theirs.
    let peek = app.post_json_as(stranger, "/api/taskflow/org-invites/peek", json!({ "token": token })).await.json().await;
    assert_eq!(peek["email"], email);
    assert_eq!(peek["matches_me"], false);
    assert_eq!(peek["open"], true);
    // The wrong account can't use it; a made-up token is the same 404.
    assert_eq!(accept(&app, stranger, &token).await.0, 404);
    assert_eq!(accept(&app, stranger, "not-a-token").await.0, 404);

    // Resend: too soon is a 429; later, a new token and the old one is dead.
    assert_eq!(app.post_json_as(owner.id, &format!("/api/taskflow/orgs/{org}/invites/{}/resend", row.id), json!({})).await.status(), 429);
    let mut v = serde_json::Map::new();
    v.insert("sent_at".into(), json!(Utc::now() - Duration::minutes(5)));
    TaskflowOrgInvite::objects().filter(taskflow_org_invite::ID.eq(row.id)).update_values(v).await.unwrap();
    let re = app.post_json_as(owner.id, &format!("/api/taskflow/orgs/{org}/invites/{}/resend", row.id), json!({})).await;
    assert_eq!(re.status(), 200, "{}", re.text());
    let new_token = re.json().await["token"].as_str().unwrap().to_string();
    assert_eq!(accept(&app, invitee, &token).await.0, 404, "the old link stopped working");

    // The right account accepts once; the role is the org's only.
    let (s, a) = accept(&app, invitee, &new_token).await;
    assert_eq!(s, 200, "{a}");
    assert_eq!(a["role"], "member");
    assert_eq!(accept(&app, invitee, &new_token).await.0, 200, "idempotent for the one who accepted");
    assert!(!taskflow_projects::scope::can_access_project(invitee, project).await, "accepting grants no project");

    // Expired: a 410.
    let late = app.create_user().await;
    let (_, inv) = invite(&app, owner.id, org, &email_of(late).await, "member").await;
    let mut v = serde_json::Map::new();
    v.insert("expires_at".into(), json!(Utc::now() - Duration::minutes(1)));
    TaskflowOrgInvite::objects().filter(taskflow_org_invite::ID.eq(inv["id"].as_i64().unwrap())).update_values(v).await.unwrap();
    assert_eq!(accept(&app, late, inv["token"].as_str().unwrap()).await.0, 410);
    // Revoked: a 410 too.
    let gone = app.create_user().await;
    let (_, inv) = invite(&app, owner.id, org, &email_of(gone).await, "member").await;
    assert_eq!(app.delete_as(owner.id, &format!("/api/taskflow/orgs/{org}/invites/{}", inv["id"])).await.status(), 204);
    assert_eq!(accept(&app, gone, inv["token"].as_str().unwrap()).await.0, 410);
}

#[tokio::test(flavor = "multi_thread")]
async fn invites_are_throttled() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    let org = org_of(project).await;
    for i in 0..taskflow_orgs::views::MAX_INVITES_PER_HOUR {
        assert_eq!(invite(&app, owner.id, org, &format!("burst{i}@example.test"), "member").await.0, 201);
    }
    assert_eq!(invite(&app, owner.id, org, "one-more@example.test", "member").await.0, 429);
    assert_eq!(invite(&app, owner.id, org, "not an email", "member").await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_owner_stays_and_only_an_owner_touches_owner() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    let org = org_of(project).await;
    let admin = app.create_user().await;
    let (_, inv) = invite(&app, owner.id, org, &email_of(admin).await, "admin").await;
    accept(&app, admin, inv["token"].as_str().unwrap()).await;
    let role = |by: i64, who: i64, role: &'static str| {
        let app = &app;
        async move { app.patch_json_as(by, &format!("/api/taskflow/orgs/{org}/members/{who}"), json!({ "role": role })).await.status() }
    };

    // The last owner can neither step down nor leave.
    assert_eq!(role(owner.id, owner.id, "admin").await, 409);
    assert_eq!(app.delete_as(owner.id, &format!("/api/taskflow/orgs/{org}/members/{}", owner.id)).await.status(), 409);
    // An admin can't make an owner, demote one, remove one, or invite one.
    assert_eq!(role(admin, admin, "owner").await, 403);
    assert_eq!(role(admin, owner.id, "member").await, 403);
    assert_eq!(app.delete_as(admin, &format!("/api/taskflow/orgs/{org}/members/{}", owner.id)).await.status(), 403);
    assert_eq!(invite(&app, admin, org, "boss@example.test", "owner").await.0, 403);
    // With a second owner, the first may step down.
    assert_eq!(role(owner.id, admin, "owner").await, 200);
    assert_eq!(role(owner.id, owner.id, "member").await, 200);
    let members = app.get_as(admin, &format!("/api/taskflow/orgs/{org}/members")).await.json().await;
    assert_eq!(members["seats_used"], 2);
    // A member can leave on their own; a plain member can't remove others.
    assert_eq!(app.get_as(owner.id, &format!("/api/taskflow/orgs/{org}/members")).await.status(), 403, "now a member: no people list");
    assert_eq!(app.delete_as(owner.id, &format!("/api/taskflow/orgs/{org}/members/{admin}")).await.status(), 403);
    assert_eq!(app.delete_as(owner.id, &format!("/api/taskflow/orgs/{org}/members/{}", owner.id)).await.status(), 204);
    assert_eq!(app.get_as(owner.id, &format!("/api/taskflow/orgs/{org}")).await.status(), 404, "gone from the org");
}
