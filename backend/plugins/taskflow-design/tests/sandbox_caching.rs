//! Cacheability of the sandbox's subresources.
//!
//! One design frame holds an iframe per artboard, and every artboard pulls the
//! same component files and `tokens.css`. With `no-store` on all of them that
//! was one full re-download per artboard, per render — and a render happens on
//! every edit, because the chrome re-keys each iframe to refresh it.
//!
//! The way out is for each subresource URL to NAME the revision it serves, so
//! the URL→bytes mapping never changes under the client and the response can be
//! cached for as long as the token that fetched it lives. These tests pin the
//! two halves of that: the composer stamps the right revision, and `serve_file`
//! only makes cacheable what is actually version-pinned.

mod support;

use support::TestApp;

/// A minimal valid tokens source. `serve_file` takes its GENERATED branch for
/// `styles/tokens.css` when this row exists, so the tokens revision under test
/// is this file's version rather than the legacy CSS row's.
const TOKENS_JSON: &str = r##"{"version":1,"categories":{
    "colors":{"accent":{"light":"#6366f1","dark":"#818cf8"}}
}}"##;

/// The full URL of the first tag mentioning `needle` — the quoted attribute
/// value around it. Reads the URL the composer ACTUALLY emitted, rather than
/// rebuilding it, so a change to how URLs are composed cannot silently stop
/// being covered by these assertions.
fn url_containing(html: &str, needle: &str) -> String {
    let at = html
        .find(needle)
        .unwrap_or_else(|| panic!("no url containing `{needle}` in the composed document"));
    let start = html[..at].rfind('"').expect("an opening quote before the url") + 1;
    let end = html[at..].find('"').expect("a closing quote after the url") + at;
    html[start..end].to_string()
}

async fn seed(app: &TestApp, user: i64, project_id: i64, path: &str, content: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project_id}/file"),
            &serde_json::json!({ "path": path, "content": content }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
}

/// Seed a project with one page, one component and a tokens source — enough
/// for `/` to compose with both subresource kinds in its head.
async fn seeded(app: &TestApp) -> (i64, i64) {
    let (user, project_id) = app.create_member_with_project().await;
    seed(app, user.id, project_id, "pages/index.html", "<main><h1>Home</h1></main>").await;
    seed(app, user.id, project_id, "components/app-header.js", &support::sample_header_component()).await;
    seed(app, user.id, project_id, "styles/tokens.json", TOKENS_JSON).await;
    (user.id, project_id)
}

async fn composed(app: &TestApp, token: &str) -> String {
    let res = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(res.status(), 200, "compose failed: {}", res.text());
    res.text()
}

/// Every subresource URL in the head carries a revision, and it is the
/// revision OF THAT FILE — not one global stamp.
///
/// The granularity is the point. A design session edits pages constantly and
/// components rarely; keying every URL to a single project-wide revision would
/// evict every component from the cache on every page edit, which is the
/// common case and so most of the benefit.
#[tokio::test(flavor = "multi_thread")]
async fn each_subresource_url_names_its_own_revision() {
    let app = TestApp::new().await;
    let (user, project_id) = seeded(&app).await;
    let token = taskflow_design::sandbox::mint(project_id);

    let before = composed(&app, &token).await;
    let comp_before = url_containing(&before, "f/components/app-header.js");
    let toks_before = url_containing(&before, "f/styles/tokens.css");
    assert!(comp_before.contains("?v="), "component url is not versioned: {comp_before}");
    assert!(toks_before.contains("?v="), "tokens.css url is not versioned: {toks_before}");

    // Edit a PAGE. It shares the manifest with the component, so a global
    // revision would move both URLs here.
    seed(&app, user, project_id, "pages/index.html", "<main><h1>Home v2</h1></main>").await;
    let after_page_edit = composed(&app, &token).await;
    assert_eq!(
        url_containing(&after_page_edit, "f/components/app-header.js"),
        comp_before,
        "a page edit must not evict a component that did not change"
    );

    // Edit the COMPONENT: now its own URL must move, and only its own.
    seed(
        &app,
        user,
        project_id,
        "components/app-header.js",
        &format!("{}\n// edited", support::sample_header_component()),
    )
    .await;
    let after_component_edit = composed(&app, &token).await;
    assert_ne!(
        url_containing(&after_component_edit, "f/components/app-header.js"),
        comp_before,
        "an edited component must move its url, or the cache would serve the old one"
    );
    assert_eq!(
        url_containing(&after_component_edit, "f/styles/tokens.css"),
        toks_before,
        "editing a component must not evict tokens.css"
    );
}

/// A version-pinned subresource is cacheable, and only for as long as the token
/// that fetched it is valid. Everything else stays `no-store`.
#[tokio::test(flavor = "multi_thread")]
async fn only_version_pinned_subresources_are_cacheable() {
    let app = TestApp::new().await;
    let (_, project_id) = seeded(&app).await;
    let token = taskflow_design::sandbox::mint(project_id);

    let comp_url = url_containing(&composed(&app, &token).await, "f/components/app-header.js");

    let versioned = app.get_sandbox(&comp_url).await;
    assert_eq!(versioned.status(), 200, "serving {comp_url} failed: {}", versioned.text());
    let cc = versioned
        .header("cache-control")
        .unwrap_or_else(|| panic!("no cache-control on {comp_url}"));
    let secs: i64 = cc
        .strip_prefix("private, max-age=")
        .unwrap_or_else(|| panic!("expected a private bounded lifetime, got: {cc}"))
        .parse()
        .expect("max-age is a number");
    // `private` keeps a token-bearing URL out of any shared cache; the bound is
    // the token's own remaining life, whose ceiling is the 600s TTL.
    assert!(secs > 0 && secs <= 600, "max-age must not outlive the token: {secs}");

    // The same file WITHOUT the version param: no revision is pinned, so there
    // is nothing a stored response could be trusted to mean.
    let unversioned = app
        .get_sandbox(&format!("/s/{token}/f/components/app-header.js"))
        .await;
    assert_eq!(
        unversioned.header("cache-control").as_deref(),
        Some("no-store"),
        "an unversioned subresource url must stay uncacheable"
    );

    // And the composed documents, which are per-route and must reflect the
    // current revision on every render, keep the original no-store.
    let doc = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(
        doc.header("cache-control").as_deref(),
        Some("no-store"),
        "the composed document must not be cached"
    );
}
