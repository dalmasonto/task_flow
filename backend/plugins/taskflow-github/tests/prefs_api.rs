mod support;
use serde_json::json;
use support::{TestApp, seed_project};

#[tokio::test]
async fn pref_defaults_false_then_toggles_on() {
    let app = TestApp::with_user_token("alice", "t").await;
    let alice = app.user("alice");
    let project = seed_project().await;

    let got = app
        .get_as(alice.id, &format!("/api/taskflow/github/projects/{project}/pref"))
        .await;
    assert_eq!(got.status(), 200);
    assert_eq!(got.json()["post_as_me"], false);

    let set = app
        .post_body_as(
            alice.id,
            &format!("/api/taskflow/github/projects/{project}/pref"),
            json!({ "post_as_me": true }),
        )
        .await;
    assert_eq!(set.status(), 200);
    assert_eq!(set.json()["post_as_me"], true);

    let again = app
        .get_as(alice.id, &format!("/api/taskflow/github/projects/{project}/pref"))
        .await;
    assert_eq!(again.json()["post_as_me"], true);
}
