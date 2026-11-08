//! #1134 (2, 3): the caller's own profile and the new settings.
//! What must hold: username/email follow the signup rules and are unique
//! case-insensitively (409 username_taken / email_taken); an email change
//! needs the current password, and drops verification; the timezone must be
//! IANA; a settings save writes only
//! what it names, so two saves of different fields don't revert each other.

use serde_json::json;
use umbral_auth::{AuthUser, auth_user};

mod support;
use support::TestApp;

const PROFILE: &str = "/api/taskflow/me/profile";
const SETTINGS: &str = "/api/taskflow/user/settings";

async fn set_password(user: i64, pw: &str) {
    let mut v = serde_json::Map::new();
    v.insert("password_hash".into(), json!(umbral_auth::hash_password(pw).unwrap()));
    AuthUser::objects().filter(auth_user::ID.eq(user)).update_values(v).await.unwrap();
}

#[tokio::test]
async fn the_profile_follows_the_signup_rules_and_guards_the_email() {
    let app = TestApp::new().await;
    let me = app.create_user().await;
    let other = app.create_user().await;
    set_password(me.id, "the-right-password").await;

    let p = app.get_as(me.id, PROFILE).await;
    assert_eq!(p.status(), 200);
    assert_eq!(p.json()["username"], me.username);

    // Name and username: no password needed; stored lowercased.
    let r = app.patch_body_as(me.id, PROFILE, json!({ "full_name": "  Dalmas Ogembo ", "username": "Dalmas_O" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["full_name"], "Dalmas Ogembo");
    assert_eq!(r.json()["username"], "dalmas_o");
    // Bad shapes and someone else's name/address.
    for (body, code) in [
        (json!({ "username": "has space" }), "invalid_username"),
        (json!({ "username": other.username.to_uppercase() }), "username_taken"),
        (json!({ "email": "not-an-email", "current_password": "the-right-password" }), "invalid_email"),
        (json!({ "email": other.email.to_uppercase(), "current_password": "the-right-password" }), "email_taken"),
    ] {
        let r = app.patch_body_as(me.id, PROFILE, body.clone()).await;
        assert_eq!(r.json()["error"], code, "{body}: {}", r.text());
    }
    // The email: no password, or a wrong one, is a 403 and nothing changes.
    for pw in [None, Some("wrong-password")] {
        let mut body = json!({ "email": "new@example.test" });
        if let Some(pw) = pw {
            body["current_password"] = json!(pw);
        }
        let r = app.patch_body_as(me.id, PROFILE, body).await;
        assert_eq!(r.status(), 403, "{}", r.text());
        assert_eq!(r.json()["error"], "password_required");
    }
    assert_eq!(app.get_as(me.id, PROFILE).await.json()["email"], me.email);
    // With it: changed, lowercased, and no longer verified.
    let mut v = serde_json::Map::new();
    v.insert("email_verified_at".into(), json!(chrono::Utc::now()));
    AuthUser::objects().filter(auth_user::ID.eq(me.id)).update_values(v).await.unwrap();
    let r = app.patch_body_as(me.id, PROFILE, json!({ "email": "New@Example.test", "current_password": "the-right-password" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["email"], "new@example.test");
    assert_eq!(r.json()["email_verified"], false);
    // Unknown fields (an id, say) are refused.
    assert_eq!(app.patch_body_as(me.id, PROFILE, json!({ "id": other.id })).await.status(), 422);
}

#[tokio::test]
async fn the_timezone_is_validated_and_saves_dont_clobber() {
    let app = TestApp::new().await;
    let me = app.create_user().await;
    let r = app.post_body_as(me.id, SETTINGS, json!({ "timezone": "Africa/Nairobi" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["timezone"], "Africa/Nairobi");
    for body in [json!({ "timezone": "Mars/Olympus" }), json!({ "timezone": "Not a zone" })] {
        let r = app.post_body_as(me.id, SETTINGS, body.clone()).await;
        assert_eq!(r.status(), 400, "{body}");
    }
    // A save of one field leaves the others alone; null clears.
    let r = app.post_body_as(me.id, SETTINGS, json!({ "theme": "dark" })).await.json();
    assert_eq!(r["theme"], "dark");
    assert_eq!(r["timezone"], "Africa/Nairobi");
    let r = app.post_body_as(me.id, SETTINGS, json!({ "timezone": null })).await.json();
    assert!(r["timezone"].is_null());
    assert_eq!(r["theme"], "dark");
}
