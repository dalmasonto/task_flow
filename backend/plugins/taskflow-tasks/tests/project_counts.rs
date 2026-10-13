//! #706: every project's task/review totals in ONE request, scoped to what the
//! caller may see. Replaces the sidebar's 2×N fan-out of `page_size=1` counts.

mod support;

use support::{TestApp, seed_active_member, seed_project, seed_task, set_status};
use taskflow_tasks::models::TaskflowTaskStatus;

#[tokio::test(flavor = "multi_thread")]
async fn counts_cover_the_callers_projects_in_one_response() {
    support::init().await;
    let app = TestApp::new().await;
    let user = app.create_user().await;

    let mine = seed_project().await;
    seed_active_member(mine, user).await;
    let theirs = seed_project().await; // no membership for `user`

    // Three in mine (one of them in review), one in a project they cannot see.
    seed_task(mine).await;
    let in_review = seed_task(mine).await;
    set_status(in_review, TaskflowTaskStatus::PartialDone).await;
    seed_task(mine).await;
    seed_task(theirs).await;

    let res = app.get_as(user, "/api/taskflow/projects/counts").await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json().await;
    let counts = &body["counts"];

    assert_eq!(counts[mine.to_string()]["tasks"], 3, "{body}");
    assert_eq!(counts[mine.to_string()]["reviews"], 1, "{body}");
    // A project the caller cannot see is ABSENT, not zero: "nothing here yet"
    // and "not yours" must not look alike.
    assert!(counts.get(theirs.to_string()).is_none(), "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_with_no_tasks_is_simply_absent() {
    support::init().await;
    let app = TestApp::new().await;
    let user = app.create_user().await;
    let project = seed_project().await;
    seed_active_member(project, user).await;

    let body = app.get_as(user, "/api/taskflow/projects/counts").await.json().await;
    // No rows to group, so no entry — a zero is the CLIENT's job to default,
    // and grouping cannot invent one.
    assert!(body["counts"].get(project.to_string()).is_none(), "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stranger_sees_no_projects() {
    support::init().await;
    let app = TestApp::new().await;
    let owner = app.create_user().await;
    let stranger = app.create_user().await;
    let project = seed_project().await;
    seed_active_member(project, owner).await;
    seed_task(project).await;

    let body = app.get_as(stranger, "/api/taskflow/projects/counts").await.json().await;
    assert_eq!(body["counts"].as_object().map(|m| m.len()), Some(0), "{body}");
}
