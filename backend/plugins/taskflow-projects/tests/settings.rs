//! Per-user settings: the get-or-create endpoint is keyed purely on the
//! authenticated identity, so a caller can only ever reach their own row.

use serde_json::json;

mod support;
use support::TestApp;

const SETTINGS: &str = "/api/taskflow/user/settings";

#[tokio::test]
async fn first_read_creates_defaults() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let res = app.get_as(user.id, SETTINGS).await;

    assert_eq!(res.status(), 200);
    let row = res.json();
    assert_eq!(row["user"], json!(user.id));
    assert_eq!(row["theme"], json!("system"));
    assert_eq!(row["email_notifications"], json!(true));
    assert_eq!(row["default_project"], json!(null));
}

#[tokio::test]
async fn repeated_read_is_idempotent_same_row() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let first = app.get_as(user.id, SETTINGS).await;
    let second = app.get_as(user.id, SETTINGS).await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json()["id"], second.json()["id"]);
}

#[tokio::test]
async fn update_changes_only_the_callers_own_settings() {
    let app = TestApp::new().await;
    let alice = app.create_user().await;
    let bob = app.create_user().await;

    // Both start from defaults.
    let bob_before = app.get_as(bob.id, SETTINGS).await.json();

    // Alice updates her prefs.
    let res = app
        .post_body_as(
            alice.id,
            SETTINGS,
            json!({ "theme": "dark", "email_notifications": false }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let row = res.json();
    assert_eq!(row["theme"], json!("dark"));
    assert_eq!(row["email_notifications"], json!(false));
    assert_eq!(row["user"], json!(alice.id));

    // Bob's settings are untouched — the write is keyed to the caller, and the
    // body has no `user` field to point at anyone else's row.
    let bob_after = app.get_as(bob.id, SETTINGS).await.json();
    assert_eq!(bob_after["theme"], json!("system"));
    assert_eq!(bob_after["email_notifications"], json!(true));
    assert_eq!(bob_after["id"], bob_before["id"]);
    assert_eq!(bob_after["user"], json!(bob.id));

    // And Alice's own change persisted across a re-read.
    let alice_reread = app.get_as(alice.id, SETTINGS).await.json();
    assert_eq!(alice_reread["theme"], json!("dark"));
}

/// #52: the settings page saves a theme click on its own, without the rest of the
/// form. That sends a body naming ONLY `theme`, so a partial write must leave the
/// caller's other preferences alone — otherwise picking a theme would silently
/// reset their notifications and default project.
#[tokio::test]
async fn theme_only_update_leaves_the_other_preferences_alone() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    // Establish non-default values for everything else.
    let seeded = app
        .post_body_as(
            user.id,
            SETTINGS,
            json!({ "email_notifications": false, "default_project": null }),
        )
        .await;
    assert_eq!(seeded.status(), 200);
    assert_eq!(seeded.json()["email_notifications"], json!(false));

    // Now the theme-only write the UI actually sends.
    let res = app
        .post_body_as(user.id, SETTINGS, json!({ "theme": "light" }))
        .await;

    assert_eq!(res.status(), 200);
    let row = res.json();
    assert_eq!(row["theme"], json!("light"));
    assert_eq!(
        row["email_notifications"],
        json!(false),
        "a theme-only write must not reset email_notifications"
    );

    // And it survives a re-read, so the settings page finds it on the next visit.
    let reread = app.get_as(user.id, SETTINGS).await.json();
    assert_eq!(reread["theme"], json!("light"));
    assert_eq!(reread["email_notifications"], json!(false));
}

#[tokio::test]
async fn update_ignores_a_body_supplied_user_field() {
    let app = TestApp::new().await;
    let alice = app.create_user().await;
    let bob = app.create_user().await;

    // A malicious body tries to smuggle in `user: bob`. The handler's input
    // type has no `user` field, so serde drops it — the write still lands on
    // Alice's own row.
    let res = app
        .post_body_as(
            alice.id,
            SETTINGS,
            json!({ "theme": "dark", "user": bob.id }),
        )
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["user"], json!(alice.id));

    // Bob still has his own default row, unaffected.
    let bob_row = app.get_as(bob.id, SETTINGS).await.json();
    assert_eq!(bob_row["user"], json!(bob.id));
    assert_eq!(bob_row["theme"], json!("system"));
}

#[tokio::test]
async fn each_user_gets_their_own_isolated_row() {
    let app = TestApp::new().await;
    let alice = app.create_user().await;
    let bob = app.create_user().await;

    let a = app.get_as(alice.id, SETTINGS).await.json();
    let b = app.get_as(bob.id, SETTINGS).await.json();

    // Two distinct rows, each owned by the caller who read it. There is no
    // parameter by which either could name the other's row.
    assert_ne!(a["id"], b["id"]);
    assert_eq!(a["user"], json!(alice.id));
    assert_eq!(b["user"], json!(bob.id));
}
