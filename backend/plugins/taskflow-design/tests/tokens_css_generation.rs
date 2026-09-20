//! Task 3 acceptance: the served `styles/tokens.css` is GENERATED from the
//! `styles/tokens.json` source (Task 1's `tokens_json_to_css`), and a
//! chrome-facing export endpoint downloads that same generated CSS.
//!
//! Covers both serving paths named in the brief:
//!   - the sandbox-token serve path (`GET /s/{token}/f/styles/tokens.css`),
//!     exercised the same way `phase1_storage_composer.rs` exercises it;
//!   - the chrome-facing export endpoint (`GET
//!     /api/design/{project}/tokens.css`), which carries the download header.

mod support;

use serde_json::json;
use support::TestApp;

const TOKENS_JSON: &str = r##"{"version":1,"categories":{
    "colors":{"accent":{"light":"#6366f1","dark":"#818cf8"}}
}}"##;

/// Seed a project with ONLY a `styles/tokens.json` row (no legacy
/// `styles/tokens.css` row) via the real write path, so generation is the
/// only way either serving path can produce CSS.
async fn seed_project_with_tokens_json(app: &TestApp) -> (i64, i64) {
    let (user, project_id) = app.create_member_with_project().await;
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.json", "content": TOKENS_JSON }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed tokens.json failed: {}", res.text());
    (user.id, project_id)
}

#[tokio::test(flavor = "multi_thread")]
async fn export_endpoint_downloads_generated_css() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_project_with_tokens_json(&app).await;

    let res = app
        .get_as(user_id, &format!("/api/design/{project_id}/tokens.css"))
        .await;
    assert_eq!(res.status(), 200, "export failed: {}", res.text());

    let body = res.text();
    assert!(body.contains("--accent: #6366f1"), "light value missing: {body}");
    assert!(body.contains("[data-theme=\"dark\"]"), "dark block missing: {body}");
    assert!(body.contains("--accent: #818cf8"), "dark value missing: {body}");

    let ct = res.header("content-type").unwrap_or_default();
    assert!(ct.contains("text/css"), "content-type: {ct}");

    let cd = res.header("content-disposition").unwrap_or_default();
    assert!(cd.contains("attachment"), "content-disposition: {cd}");
    assert!(cd.contains("tokens.css"), "content-disposition: {cd}");
}

#[tokio::test(flavor = "multi_thread")]
async fn export_endpoint_rejects_non_member() {
    let app = TestApp::new().await;
    let (_user_id, project_id) = seed_project_with_tokens_json(&app).await;
    // A user who belongs to a different project entirely, mirroring
    // `foreign_project_is_refused_not_routed` in phase3_agent_surface.rs.
    let (other_user, _other_project) = app.create_member_with_project().await;

    let res = app
        .get_as(other_user.id, &format!("/api/design/{project_id}/tokens.css"))
        .await;
    assert_eq!(res.status(), 403, "non-member must be refused: {}", res.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn sandbox_serve_generates_css_from_json_row() {
    let app = TestApp::new().await;
    let (_user_id, project_id) = seed_project_with_tokens_json(&app).await;

    // A sandbox read token minted server-side, exactly as
    // phase1_storage_composer.rs does for the composed-page assertions.
    let token = taskflow_design::sandbox::mint(project_id);

    let res = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await;
    assert_eq!(res.status(), 200, "sandbox serve failed: {}", res.text());

    let body = res.text();
    assert!(body.contains("--accent: #6366f1"), "light value missing: {body}");
    assert!(body.contains("[data-theme=\"dark\"]"), "dark block missing: {body}");
    assert!(body.contains("--accent: #818cf8"), "dark value missing: {body}");

    let ct = res.header("content-type").unwrap_or_default();
    assert!(ct.contains("text/css"), "content-type: {ct}");
    assert_eq!(
        res.header("cache-control").as_deref(),
        Some("no-store"),
        "sandbox serve must keep no-store"
    );
}

/// Seed a project whose `pages/index.html` uses a `<ui-accordion>` primitive,
/// via the real HTTP write path (Task 5 allowlisted `ui-*` tags in page
/// validation, so this no longer needs the ORM-seed workaround
/// `phase1_storage_composer.rs`'s composer test uses).
async fn seed_project_with_accordion_page(app: &TestApp) -> (i64, i64) {
    let (user, project_id) = app.create_member_with_project().await;
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/index.html",
                "content": r#"<main class="p-4"><ui-accordion title="Q">A</ui-accordion></main>"#
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed page with ui-accordion failed: {}", res.text());
    (user.id, project_id)
}

/// `GET /api/design/{project}/page.html?route=/` — the same expanded HTML the
/// sandbox serves, downloaded as an attachment.
#[tokio::test(flavor = "multi_thread")]
async fn page_html_export_downloads_expanded_document() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_project_with_accordion_page(&app).await;

    let res = app
        .get_as(user_id, &format!("/api/design/{project_id}/page.html?route=/"))
        .await;
    assert_eq!(res.status(), 200, "export failed: {}", res.text());

    let cd = res.header("content-disposition").unwrap_or_default();
    assert!(cd.contains("attachment"), "content-disposition: {cd}");

    let body = res.text();
    assert!(body.contains("<details"), "primitive was not expanded: {body}");
    assert!(!body.contains("<ui-accordion"), "raw <ui-accordion> tag leaked: {body}");
}

/// `?fragment=1` returns only the expanded body markup, inline, with no
/// document shell and no surviving `<ui-` tags.
#[tokio::test(flavor = "multi_thread")]
async fn page_html_export_fragment_returns_body_only() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_project_with_accordion_page(&app).await;

    let res = app
        .get_as(
            user_id,
            &format!("/api/design/{project_id}/page.html?route=/&fragment=1"),
        )
        .await;
    assert_eq!(res.status(), 200, "fragment export failed: {}", res.text());

    let cd = res.header("content-disposition").unwrap_or_default();
    assert!(!cd.contains("attachment"), "fragment must be inline, not attachment: {cd}");

    let body = res.text();
    assert!(body.contains("<details"), "primitive was not expanded: {body}");
    assert!(!body.contains("<ui-"), "raw primitive tag leaked: {body}");
    assert!(
        !body.to_lowercase().contains("<!doctype html>"),
        "fragment must not include the document shell: {body}"
    );
}

/// A non-member is refused, mirroring `export_endpoint_rejects_non_member`.
#[tokio::test(flavor = "multi_thread")]
async fn page_html_export_rejects_non_member() {
    let app = TestApp::new().await;
    let (_user_id, project_id) = seed_project_with_accordion_page(&app).await;
    let (other_user, _other_project) = app.create_member_with_project().await;

    let res = app
        .get_as(other_user.id, &format!("/api/design/{project_id}/page.html?route=/"))
        .await;
    assert_eq!(res.status(), 403, "non-member must be refused: {}", res.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn sandbox_serve_falls_back_to_legacy_css_row_when_no_json() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;

    // Legacy hand-authored tokens.css, no tokens.json row at all.
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.css", "content": "@theme {\n  --accent: #111111;\n}\n" }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed legacy tokens.css failed: {}", res.text());

    let token = taskflow_design::sandbox::mint(project_id);
    let served = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await;
    assert_eq!(served.status(), 200);
    assert!(
        served.text().contains("--accent: #111111"),
        "legacy row content should be served verbatim when no json row exists: {}",
        served.text()
    );
}
