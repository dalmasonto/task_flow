mod support;
use support::TestApp;

use taskflow_github::models::{TaskflowGithubPref, taskflow_github_pref};
use umbral::orm::ForeignKey;

#[tokio::test]
async fn pref_row_roundtrips_and_defaults_false() {
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = support::seed_project().await;

    let pref = TaskflowGithubPref::objects()
        .create(TaskflowGithubPref {
            id: 0,
            user: ForeignKey::new(user.id),
            project: ForeignKey::new(project),
            post_as_me: false,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create pref");

    let loaded = TaskflowGithubPref::objects()
        .filter(taskflow_github_pref::ID.eq(pref.id))
        .first()
        .await
        .expect("query")
        .expect("exists");
    assert!(!loaded.post_as_me);
}
