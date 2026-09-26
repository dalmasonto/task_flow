//! The layout row carries a version, and the operator's save maintains it.
//!
//! This is the token an agent's `base_version` is checked against (spec §4 D1).
//! The operator never *sends* one — a human saving from the panel always wins —
//! but their save must still move the number, or an agent holding a stale
//! version would never be told.

mod support;

use support::TestApp;

fn layout_body() -> serde_json::Value {
    serde_json::json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [],
        "pageLabels": {}
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn an_operators_first_save_creates_the_row_at_version_one() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.version, 1, "a first save lands at version 1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_save_bumps_the_version() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    app.put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout_body())
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.version, 2, "the operator's save moves the number");
}
