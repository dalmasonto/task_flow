//! #665: the manifest names the VERSION of everything a rendered page depends
//! on — each route's page file, each component, and the two style documents.
//!
//! The chrome caches board snapshots (images of a rendered page) client-side
//! and must know when one went stale WITHOUT re-rendering it to find out. Its
//! key is `(project, route, device, theme, versions)`, and the versions come
//! from here: the route's own file, plus the files whose change alters every
//! route (tokens, external resources) or this route (the components it uses).
//! An approximate signal — a max, a timestamp — would reuse a stale image
//! sometimes, and a stale image is worse than no image: it looks real.

mod support;

use serde_json::json;
use support::TestApp;

async fn seed(app: &TestApp, user: i64, project: i64, path: &str, content: &str) {
    let res = app
        .put_json_as(user, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content }))
        .await;
    assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
}

async fn manifest(app: &TestApp, user: i64, project: i64) -> serde_json::Value {
    let res = app.get_as(user, &format!("/api/design/{project}/manifest")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    res.json()
}

#[tokio::test(flavor = "multi_thread")]
async fn routes_and_components_carry_their_file_version() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    // The component first: a page that uses an unregistered tag is refused.
    seed(&app, user.id, project, "components/app-header.js", &support::sample_header_component()).await;
    seed(&app, user.id, project, "pages/index.html", "<main><app-header></app-header></main>").await;
    seed(&app, user.id, project, "styles/tokens.json",
        r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}}}"##).await;

    let m = manifest(&app, user.id, project).await;
    assert_eq!(m["routes"][0]["path"], "/");
    assert_eq!(m["routes"][0]["version"], 1, "the route names its page file's version: {m}");
    assert_eq!(m["components"][0]["name"], "app-header");
    assert_eq!(m["components"][0]["version"], 1, "the component names its version: {m}");
    assert_eq!(m["tokensVersion"], 1, "the token document names its version: {m}");
    assert_eq!(
        m["resourcesVersion"],
        0,
        "no resources.json: version 0, saying so rather than being absent: {m}"
    );

    // Write #2 of the page bumps ITS version, not the tokens'.
    let put = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({
                "path": "pages/index.html",
                "content": "<main><app-header></app-header><p>v3</p></main>",
                "base_version": 1,
            }),
        )
        .await;
    assert_eq!(put.status(), 201, "{}", put.text());

    let m = manifest(&app, user.id, project).await;
    assert_eq!(m["routes"][0]["version"], 2, "{m}");
    assert_eq!(m["tokensVersion"], 1, "a page edit leaves the tokens' version alone: {m}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_style_documents_track_their_own_versions() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    seed(&app, user.id, project, "pages/index.html", "<main><h1>Home</h1></main>").await;
    seed(&app, user.id, project, "styles/tokens.json",
        r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}}}"##).await;
    seed(&app, user.id, project, "styles/resources.json", r##"{"version":1,"sets":[]}"##).await;

    let m = manifest(&app, user.id, project).await;
    assert_eq!(m["tokensVersion"], 1, "{m}");
    assert_eq!(m["resourcesVersion"], 1, "{m}");

    // A resources-only change must move the resources version — a shared max
    // or a single "styles version" would not, and a stale snapshot would look
    // no different from a fresh one.
    let put = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({
                "path": "styles/resources.json",
                "content": r##"{"version":1,"sets":[{"id":"font","name":"Font","enabled":false,"links":[]}]}"##,
                "base_version": 1,
            }),
        )
        .await;
    assert_eq!(put.status(), 201, "{}", put.text());

    let m = manifest(&app, user.id, project).await;
    assert_eq!(m["resourcesVersion"], 2, "the edited document's own version moved: {m}");
    assert_eq!(m["tokensVersion"], 1, "and the other document's did not: {m}");
}
