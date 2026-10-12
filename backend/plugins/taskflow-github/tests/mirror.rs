mod support;
use support::{seed_pref, seed_project_linked, seed_task, seed_task_with_issue, TestApp, set_task_repo};

use taskflow_github::api::FakeGithubApi;
use taskflow_github::mirror::{mirror_comment, MirrorOutcome};
use taskflow_github::tokens::FakeTokenSource;

#[tokio::test]
async fn posts_when_opted_in_and_published() {
    let app = TestApp::with_owner_token("ignored").await;
    let user = app.owner_user().id;
    let project = seed_project_linked(user, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(user, project, true).await;

    let api = FakeGithubApi::returning(0, "");
    let tokens = FakeTokenSource::new().with(user, "user-tok");
    let outcome = mirror_comment(&api, &tokens, project, task, user, "hello issue")
        .await
        .expect("mirror");
    assert_eq!(outcome, MirrorOutcome::Posted);
    let comments = api.comments();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].0, "user-tok"); // actor's key
    assert_eq!(comments[0].2, 7);
    assert_eq!(comments[0].3, "hello issue");
}

// #606: the comment belongs to the TASK's issue, so it is mirrored into the
// task's repo — not the project default, which after a re-link may be a
// different repository entirely.
#[tokio::test]
async fn mirrors_into_the_tasks_own_repo() {
    let app = TestApp::with_owner_token("ignored").await;
    let user = app.owner_user().id;
    let project = seed_project_linked(user, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    set_task_repo(task, "acme/api").await;
    seed_pref(user, project, true).await;

    let api = FakeGithubApi::returning(0, "");
    let tokens = FakeTokenSource::new().with(user, "user-tok");
    let outcome = mirror_comment(&api, &tokens, project, task, user, "hello issue").await.expect("mirror");
    assert_eq!(outcome, MirrorOutcome::Posted);
    assert_eq!(api.comments()[0].1, "acme/api");
}

#[tokio::test]
async fn needs_connect_when_opted_out() {
    let app = TestApp::with_owner_token("ignored").await;
    let user = app.owner_user().id;
    let project = seed_project_linked(user, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(user, project, false).await; // opted OUT

    let api = FakeGithubApi::returning(0, "");
    let tokens = FakeTokenSource::new().with(user, "user-tok");
    let outcome = mirror_comment(&api, &tokens, project, task, user, "hi").await.expect("mirror");
    assert_eq!(outcome, MirrorOutcome::NeedsConnect);
    assert!(api.comments().is_empty());
}

#[tokio::test]
async fn not_published_when_task_has_no_issue() {
    let app = TestApp::with_owner_token("ignored").await;
    let user = app.owner_user().id;
    let project = seed_project_linked(user, "acme/widgets").await;
    let task = seed_task(project, "unpublished").await;
    seed_pref(user, project, true).await;

    let api = FakeGithubApi::returning(0, "");
    let tokens = FakeTokenSource::new().with(user, "user-tok");
    let outcome = mirror_comment(&api, &tokens, project, task, user, "hi").await.expect("mirror");
    assert_eq!(outcome, MirrorOutcome::NotPublished);
    assert!(api.comments().is_empty());
}
