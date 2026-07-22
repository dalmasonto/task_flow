mod support;
use support::TestApp;

#[tokio::test]
async fn me_reports_connected_when_user_has_token() {
    let app = TestApp::with_owner_token("tok").await;
    let user = app.owner_user();
    let res = app.get_as(user.id, "/api/taskflow/github/me").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["connected"], true);
}

#[tokio::test]
async fn me_reports_disconnected_without_token() {
    let app = TestApp::with_no_tokens().await;
    let user = app.owner_user();
    let res = app.get_as(user.id, "/api/taskflow/github/me").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["connected"], false);
}
