mod support;
use support::TestApp;

use taskflow_projects::models::{TaskflowProject, TaskflowProjectStatus, taskflow_project};
use umbral::orm::ForeignKey;

#[tokio::test]
async fn project_persists_github_link_fields() {
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let created = TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: "GH".into(),
            slug: "gh-proj".into(),
            description_markdown: String::new(),
            repository_url: Some("https://github.com/acme/widgets".into()),
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: Some(ForeignKey::new(user.id)),
            github_repo: Some("acme/widgets".into()),
            github_linked_by: Some(ForeignKey::new(user.id)),
            github_default_branch: Some("main".into()),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project");

    let loaded = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(created.id))
        .first()
        .await
        .expect("query")
        .expect("row exists");

    assert_eq!(loaded.github_repo.as_deref(), Some("acme/widgets"));
    assert_eq!(loaded.github_linked_by.map(|fk| fk.id()), Some(user.id));
    assert_eq!(loaded.github_default_branch.as_deref(), Some("main"));
}
