//! #520: design history — every accepted write is recorded, a past revision
//! reads back as the WHOLE project it was, and retention keeps the versions a
//! retained page still renders with.
//!
//! These tests are at the `store` level on purpose: the write path is where
//! history is born, and an API test that went through HTTP would pin the same
//! behaviour one layer further from the thing that can silently stop
//! recording.

mod support;

use support::TestApp;

use taskflow_design::store::{self, KEEP_VERSIONS_PER_PATH, WriteOutcome};

/// Write through the real store path (the same function every route runs) and
/// return the saved row.
async fn write(project: i64, path: &str, content: &str) -> taskflow_design::models::DesignFile {
    match store::write_file(project, path, content, None, "test").await {
        WriteOutcome::Saved(row, _) => *row,
        WriteOutcome::Rejected(verdict) => panic!("write {path} rejected: {verdict:?}"),
        WriteOutcome::Conflict(row) => panic!("write {path} conflicted at v{}", row.version),
    }
}

async fn state_at(project: i64, revision: i64) -> Vec<(String, String)> {
    let mut state: Vec<(String, String)> = store::project_state_at(project, revision)
        .await
        .into_iter()
        .map(|row| (row.path, row.content))
        .collect();
    state.sort();
    state
}

#[tokio::test(flavor = "multi_thread")]
async fn every_write_is_recorded_and_reads_back_in_order() {
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    write(project, "pages/index.html", "<p>v1</p>").await;
    write(project, "pages/index.html", "<p>v2</p>").await;
    write(project, "pages/index.html", "<p>v3</p>").await;

    let versions = store::list_versions(project, "pages/index.html").await;
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        [3, 2, 1],
        "newest first: {versions:?}"
    );
    assert!(
        versions[0].project_revision > versions[2].project_revision,
        "revisions advance with the writes: {versions:?}"
    );
    assert!(versions.iter().all(|v| !v.deleted));

    let old = store::read_version(project, "pages/index.html", 2)
        .await
        .expect("version 2 is kept");
    assert_eq!(old.content, "<p>v2</p>");
    assert!(store::read_version(project, "pages/index.html", 99).await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_past_revision_reads_back_with_the_tokens_of_its_time() {
    // The requirement the whole feature turns on: a screen version is not
    // renderable on its own. Writing the page alone is not enough.
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    write(project, "styles/tokens.json", r##"{"version":1,"categories":{"colors":{"accent":{"light":"#111111"}}}}"##).await;
    let page_v1 = write(project, "pages/index.html", "<p>first</p>").await;
    let at_v1 = page_v1.version;
    let revision_v1 = store::list_versions(project, "pages/index.html").await[0].project_revision;

    // The tokens move on, and the page with them.
    write(project, "styles/tokens.json", r##"{"version":1,"categories":{"colors":{"accent":{"light":"#222222"}}}}"##).await;
    write(project, "pages/index.html", "<p>second</p>").await;
    let revision_v2 = store::list_versions(project, "pages/index.html").await[0].project_revision;
    assert!(at_v1 == 1 && revision_v2 > revision_v1);

    let state = state_at(project, revision_v1).await;
    let page = state.iter().find(|(path, _)| path == "pages/index.html").unwrap();
    let tokens = state.iter().find(|(path, _)| path == "styles/tokens.json").unwrap();
    assert_eq!(page.1, "<p>first</p>");
    assert!(
        tokens.1.contains("#111111"),
        "the tokens in force AT THAT REVISION — not today's: {tokens:?}"
    );

    let now = state_at(project, i64::MAX).await;
    let tokens_now = now.iter().find(|(path, _)| path == "styles/tokens.json").unwrap();
    assert!(tokens_now.1.contains("#222222"), "today's state is unaffected: {now:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn trash_and_restore_are_part_of_the_history() {
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    write(project, "pages/about.html", "<p>about</p>").await;
    assert!(store::trash_file(project, "pages/about.html").await.is_some());

    let after_trash = store::list_versions(project, "pages/about.html").await;
    assert!(after_trash[0].deleted, "the newest row is the tombstone: {after_trash:?}");
    let last_revision = after_trash[0].project_revision;
    let state = state_at(project, last_revision).await;
    assert!(
        !state.iter().any(|(path, _)| path == "pages/about.html"),
        "a trashed page is GONE at its revision: {state:?}"
    );

    assert!(store::restore_file(project, "pages/about.html").await.is_ok());
    let after_restore = store::list_versions(project, "pages/about.html").await;
    assert!(!after_restore[0].deleted, "{after_restore:?}");
    assert!(
        after_restore[0].project_revision > last_revision,
        "the restore is a later event: {after_restore:?}"
    );
    let state = state_at(project, after_restore[0].project_revision).await;
    assert!(state.iter().any(|(path, _)| path == "pages/about.html"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restore_repeats_a_version_number_and_the_newest_row_wins() {
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    let first = write(project, "pages/kept.html", "<p>kept</p>").await;
    assert!(store::trash_file(project, "pages/kept.html").await.is_some());
    assert!(store::restore_file(project, "pages/kept.html").await.is_ok());

    let versions = store::list_versions(project, "pages/kept.html").await;
    // Three rows carry this FILE version — the write, the tombstone (which
    // records what was trashed) and the restore. The file's version counter
    // never moved, so the number alone does not identify a row; the revision
    // does.
    assert_eq!(
        versions.iter().filter(|v| v.version == first.version).count(),
        3,
        "a restore re-records the same FILE version: {versions:?}"
    );
    let read = store::read_version(project, "pages/kept.html", first.version)
        .await
        .expect("the version reads back");
    assert!(!read.deleted, "the newest row for that version is the restore");
}

#[tokio::test(flavor = "multi_thread")]
async fn history_is_pruned_per_path_to_twenty() {
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    for i in 1..=25 {
        write(project, "pages/long.html", &format!("<p>{i}</p>")).await;
    }
    let versions = store::list_versions(project, "pages/long.html").await;
    assert_eq!(versions.len(), KEEP_VERSIONS_PER_PATH);
    assert_eq!(versions[0].version, 25, "newest kept");
    assert_eq!(versions.last().unwrap().version, 6, "oldest kept");
    assert!(
        store::read_version(project, "pages/long.html", 5).await.is_none(),
        "v5 aged out"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tokens_a_retained_page_renders_with_survive_their_own_count() {
    // Style versions are inputs of page versions: pruning them by count alone
    // would leave a kept page rendering with tokens that never existed
    // alongside it. This is the rule, tested with the count it defeats.
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;

    write(project, "styles/tokens.json", r##"{"version":1,"categories":{"colors":{"accent":{"light":"#aaaaaa"}}}}"##).await;
    write(project, "pages/index.html", "<p>the page this started with</p>").await;
    let page_revision = store::list_versions(project, "pages/index.html").await[0].project_revision;

    // Far more token writes than a count rule would keep.
    for i in 0..30 {
        write(
            project,
            "styles/tokens.json",
            &format!(r##"{{"version":1,"categories":{{"colors":{{"accent":{{"light":"#{i:06x}"}}}}}}}}"##),
        )
        .await;
    }

    let state = state_at(project, page_revision).await;
    let tokens = state
        .iter()
        .find(|(path, _)| path == "styles/tokens.json")
        .expect("the tokens in force at the page's revision are still there");
    assert!(
        tokens.1.contains("#aaaaaa"),
        "the version in effect at that page's revision, not merely the newest: {tokens:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_with_no_history_reads_back_empty_not_broken() {
    let app = TestApp::new().await;
    let (_, project) = app.create_member_with_project().await;
    assert!(store::list_versions(project, "pages/none.html").await.is_empty());
    assert!(store::project_state_at(project, 1).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sandbox_renders_a_past_revision_with_the_files_of_its_time() {
    async fn put(app: &TestApp, user: i64, project: i64, path: &str, content: &str) {
        let res = app
            .put_json_as(user, &format!("/api/design/{project}/file"), &serde_json::json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "write {path}: {}", res.text());
    }

    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    let component_v1 = "class AppHeader extends HTMLElement { connectedCallback() { this.innerHTML = '<b>header v1</b>' } }\ncustomElements.define('app-header', AppHeader);";
    put(&app, user.id, project, "components/app-header.js", component_v1).await;
    put(
        &app,
        user.id,
        project,
        "styles/tokens.json",
        r##"{"version":1,"categories":{"colors":{"accent":{"light":"#111111"}}}}"##,
    )
    .await;
    put(&app, user.id, project, "pages/index.html", "<main><app-header></app-header><p>first wording</p></main>").await;
    let rev1 = store::list_versions(project, "pages/index.html").await[0].project_revision;

    // Everything moves on: component v2, tokens v2, page v2.
    put(
        &app,
        user.id,
        project,
        "components/app-header.js",
        "class AppHeader extends HTMLElement { connectedCallback() { this.innerHTML = '<b>header v2</b>' } }\ncustomElements.define('app-header', AppHeader);",
    )
    .await;
    put(
        &app,
        user.id,
        project,
        "styles/tokens.json",
        r##"{"version":1,"categories":{"colors":{"accent":{"light":"#222222"}}}}"##,
    )
    .await;
    put(&app, user.id, project, "pages/index.html", "<main><app-header></app-header><p>second wording</p></main>").await;

    let token = taskflow_design::sandbox::mint(project);
    let past = app.get_sandbox(&format!("/s/{token}/?rev={rev1}")).await;
    assert_eq!(past.status(), 200, "{}", past.text());
    let past = past.text();
    assert!(past.contains("first wording"), "the page of that revision: {past}");
    assert!(!past.contains("second wording"));
    assert!(
        past.contains("/f/styles/tokens.css?v=1"),
        "the token sheet of that revision is what the document names: {past}"
    );
    assert!(past.contains("/f/components/app-header.js?v=1"), "{past}");

    // And those versioned subresources really serve the past — the sheet is
    // GENERATED, so it has to be generated from the revision's tokens.
    let sheet = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css?v=1")).await;
    assert!(sheet.text().contains("#111111"), "{}", sheet.text());
    let component = app.get_sandbox(&format!("/s/{token}/f/components/app-header.js?v=1")).await;
    assert!(component.text().contains("header v1"), "{}", component.text());

    // Without `?rev`, the live project — unchanged behaviour.
    let live = app.get_sandbox(&format!("/s/{token}/")).await;
    assert!(live.text().contains("second wording"), "{}", live.text());
    let sheet_now = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css?v=2")).await;
    assert!(sheet_now.text().contains("#222222"), "{}", sheet_now.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_agent_api_lists_reads_and_restores_versions() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent, key) = support::seed_agent(project, "Historian").await;

    async fn put(app: &TestApp, user: i64, project: i64, content: &str) {
        let res = app
            .put_json_as(user, &format!("/api/design/{project}/file"), &serde_json::json!({ "path": "pages/index.html", "content": content }))
            .await;
        assert_eq!(res.status(), 201, "{}", res.text());
    }
    put(&app, user.id, project, "<p>first</p>").await;
    put(&app, user.id, project, "<p>second</p>").await;

    let listed = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/versions?project={project}&path=pages/index.html"))
        .await;
    assert_eq!(listed.status(), 200, "{}", listed.text());
    let versions = listed.json()["versions"].clone();
    assert_eq!(versions[0]["version"], 2);
    assert_eq!(versions[1]["version"], 1);
    let first_revision = versions[1]["project_revision"].as_i64().unwrap();

    let read = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/version?project={project}&path=pages/index.html&version=1"))
        .await;
    assert_eq!(read.status(), 200, "{}", read.text());
    assert_eq!(read.json()["content"], "<p>first</p>");
    assert_eq!(
        read.json()["preview_revision"].as_i64(),
        Some(first_revision),
        "the revision to preview it at is handed back with it: {}",
        read.text()
    );

    let restored = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/restore-version",
            &serde_json::json!({ "project": project, "path": "pages/index.html", "version": 1 }),
        )
        .await;
    assert_eq!(restored.status(), 201, "{}", restored.text());
    assert_eq!(restored.json()["file"]["version"], 3, "a restore is a NEW write");
    assert_eq!(restored.json()["file"]["content"], "<p>first</p>");

    // The history still holds what the restore replaced.
    let listed = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/versions?project={project}&path=pages/index.html"))
        .await
        .json();
    let numbers: Vec<i64> = listed["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["version"].as_i64().unwrap())
        .collect();
    assert_eq!(
        numbers,
        [3, 2, 1],
        "the restore is a NEW version (3), and the version it replaced (2) is still recorded: {listed}"
    );

    let missing = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/restore-version",
            &serde_json::json!({ "project": project, "path": "pages/index.html", "version": 99 }),
        )
        .await;
    assert_eq!(missing.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_operator_api_mirrors_the_agent_one() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    for content in ["<p>v1</p>", "<p>v2</p>"] {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project}/file"), &serde_json::json!({ "path": "pages/index.html", "content": content }))
            .await;
        assert_eq!(res.status(), 201, "{}", res.text());
    }

    let listed = app.get_as(user.id, &format!("/api/design/{project}/versions?path=pages/index.html")).await;
    assert_eq!(listed.status(), 200, "{}", listed.text());
    assert_eq!(listed.json()["versions"][1]["version"], 1);

    let read = app
        .get_as(user.id, &format!("/api/design/{project}/version?path=pages/index.html&version=1"))
        .await;
    assert_eq!(read.json()["content"], "<p>v1</p>");

    let restored = app
        .post_json_as(
            user.id,
            &format!("/api/design/{project}/version/restore"),
            &serde_json::json!({ "path": "pages/index.html", "version": 1 }),
        )
        .await;
    assert_eq!(restored.status(), 200, "{}", restored.text());
    assert_eq!(restored.json()["file"]["content"], "<p>v1</p>");
    assert_eq!(restored.json()["file"]["version"], 3);
}
