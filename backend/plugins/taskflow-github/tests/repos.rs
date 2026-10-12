//! #606: a project links SEVERAL GitHub repos, and a task may say which one it
//! belongs to.
//!
//! The rules this file pins, because each one is a correctness claim rather
//! than a preference:
//!  - exactly one repo is the DEFAULT; `TaskflowProject.github_repo` mirrors it,
//!    so every reader that predates this table keeps seeing the truth;
//!  - a task's `github_repo` wins over the project default, and `null` means the
//!    default — which is what keeps every existing task behaving as it did;
//!  - publishing pins the issue to the repo it actually went to, so a later
//!    default change cannot orphan an issue number;
//!  - a repo a project no longer links is refused at publish time, because an
//!    old row naming it must not be able to push into it.

mod support;
use support::{TestApp, seed_member, seed_project_linked, seed_task};
use taskflow_projects::models::TaskflowProjectRole;

use serde_json::json;

async fn owner_linked(app: &TestApp, repo: &str) -> (support::TestUser, i64) {
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, repo).await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    (owner, project)
}

async fn repos_of(app: &TestApp, owner: &support::TestUser, project: i64) -> serde_json::Value {
    let res = app.get_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    res.json()
}

#[tokio::test]
async fn a_project_links_several_repos_with_one_default() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let (owner, project) = owner_linked(&app, "acme/widgets").await;

    // The legacy link IS the first repo, and it starts as the default.
    let listed = repos_of(&app, &owner, project).await;
    assert_eq!(listed["repos"], json!([{ "repo": "acme/widgets", "is_default": true }]), "{listed}");

    let added = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "acme/api" }))
        .await;
    assert_eq!(added.status(), 200, "{}", added.text());
    let listed = repos_of(&app, &owner, project).await;
    assert_eq!(listed["repos"].as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(listed["repos"][1], json!({ "repo": "acme/api", "is_default": false }));

    // The default follows the table, and the project row still mirrors it.
    let made_default = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos/default"), json!({ "repo": "acme/api" }))
        .await;
    assert_eq!(made_default.status(), 200, "{}", made_default.text());
    let (legacy, _) = support::project_github_link(project).await;
    assert_eq!(legacy.as_deref(), Some("acme/api"), "the legacy column mirrors the default");

    // Removing the DEFAULT is refused while another repo exists — a project
    // whose default is gone has none for every task that never named one.
    let refused = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos/remove"), json!({ "repo": "acme/api" }))
        .await;
    assert_eq!(refused.status(), 400, "{}", refused.text());
    assert!(refused.text().contains("default"), "{}", refused.text());

    // Removing a repo that is NOT the default is fine, and leaves the default
    // untouched.
    let removed = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos/remove"), json!({ "repo": "acme/widgets" }))
        .await;
    assert_eq!(removed.status(), 200, "{}", removed.text());
    let (legacy, _) = support::project_github_link(project).await;
    assert_eq!(legacy.as_deref(), Some("acme/api"), "the default survived the removal");

    // Bad input is refused where it enters, not at render time.
    let malformed = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "not-a-repo" }))
        .await;
    assert_eq!(malformed.status(), 400, "{}", malformed.text());
    let duplicate = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "acme/api" }))
        .await;
    assert_eq!(duplicate.status(), 400, "{}", duplicate.text());

    // Nobody without admin reaches any of it.
    let stranger = app.create_user().await;
    let denied = app
        .post_body_as(stranger.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "acme/evil" }))
        .await;
    assert_ne!(denied.status(), 200, "{}", denied.text());
}

#[tokio::test]
async fn the_last_repo_can_be_removed_and_unlinks_the_project() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let (owner, project) = owner_linked(&app, "acme/widgets").await;

    // The only repo IS the default; removing it is the one case that is allowed
    // to clear the default, because it leaves the project unlinked rather than
    // defaultless.
    let removed = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos/remove"), json!({ "repo": "acme/widgets" }))
        .await;
    assert_eq!(removed.status(), 200, "{}", removed.text());
    let (legacy, _) = support::project_github_link(project).await;
    assert_eq!(legacy, None, "an unlinked project has no default repo either");
}

#[tokio::test]
async fn publishing_goes_to_the_tasks_own_repo_and_pins_it() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let (owner, project) = owner_linked(&app, "acme/widgets").await;
    app.post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "acme/api" }))
        .await;

    // A task that names a repo publishes into THAT repo.
    let named = seed_task(project, "API work").await;
    support::set_task_repo(named, "acme/api").await;
    let res = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/tasks/{named}/publish"), json!({}))
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let calls = app.api_created_issues();
    assert_eq!(calls.last().unwrap().1, "acme/api", "published into the task's repo");
    assert_eq!(support::task_repo_column(named).await.as_deref(), Some("acme/api"));

    // A task that names none keeps today's behaviour: the project default.
    let plain = seed_task(project, "Widgets work").await;
    let res = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/tasks/{plain}/publish"), json!({}))
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let calls = app.api_created_issues();
    assert_eq!(calls.last().unwrap().1, "acme/widgets", "no repo named means the default");

    // A repo the project no longer links is refused, even when a stale row
    // names it — publishing into whatever an old row says would push to a repo
    // the project has since dropped.
    let stale = seed_task(project, "Stale work").await;
    support::set_task_repo(stale, "acme/gone").await;
    let res = app
        .post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/tasks/{stale}/publish"), json!({}))
        .await;
    assert_eq!(res.status(), 400, "{}", res.text());
    assert!(res.text().contains("not linked"), "{}", res.text());
}

#[tokio::test]
async fn status_reports_every_linked_repo() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let (owner, project) = owner_linked(&app, "acme/widgets").await;
    app.post_body_as(owner.id, &format!("/api/taskflow/github/projects/{project}/repos"), json!({ "repo": "acme/api" }))
        .await;

    let res = app.get_as(owner.id, &format!("/api/taskflow/github/projects/{project}/status")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json();
    // The legacy shape stays: `project_linked` + the default repo.
    assert_eq!(body["project_linked"], true);
    assert_eq!(body["github_repo"], "acme/widgets");
    // ...and the list rides along for the UI that lets you manage them.
    let repos = body["repos"].as_array().expect("repos");
    assert_eq!(repos.len(), 2, "{body}");
    assert_eq!(repos[0]["repo"], "acme/widgets");
    assert_eq!(repos[0]["is_default"], true);
    assert_eq!(repos[1]["repo"], "acme/api");
}
