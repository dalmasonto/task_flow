//! Phase 1 acceptance: storage + validator + composer + sandbox serving.
//!
//! The flow under test is the one the spec pins down: hand-written tokens.css,
//! one app-header.js, and two page fragments render as two styled pages with
//! working links between them — composed by the server, never by an agent.

mod support;

use serde_json::json;
use support::{TestApp, sample_header_component, sample_index_page, sample_settings_page, sample_tokens};

async fn seed_minimal_project(app: &TestApp) -> (i64, i64) {
    let (user, project) = app.create_member_with_project().await;
    (user.id, project)
}

/// PUT the three sample artifacts through the real HTTP path.
async fn seed_samples(user_id: i64, project_id: i64, app: &TestApp) {
    for (path, content) in [
        ("styles/tokens.css", sample_tokens()),
        ("components/app-header.js", sample_header_component()),
        ("pages/index.html", sample_index_page()),
        ("pages/settings.html", sample_settings_page()),
    ] {
        let res = app
            .put_json_as(
                user_id,
                &format!("/api/design/{project_id}/file"),
                &json!({ "path": path, "content": content }),
            )
            .await;
        assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_render_as_styled_documents_with_working_links() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    seed_samples(user_id, project_id, &app).await;

    // A sandbox read token minted server-side (the chrome would embed this in
    // the artboard URL).
    let token = taskflow_design::sandbox::mint(project_id);

    // --- the index page -----------------------------------------------------
    let root = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(root.status(), 200, "root page failed to serve");
    let html = root.text();

    // Full document shell, server-composed.
    assert!(html.starts_with("<!doctype html>"), "shell missing doctype");
    assert!(html.contains("<html lang=\"en\""), "shell missing html tag");
    assert!(html.contains("<body class="), "shell missing body");

    // Identical head: Tailwind browser build, tokens stylesheet, component
    // script, picker runtime. This is the anti-drift guarantee.
    assert!(html.contains("cdn.jsdelivr.net/npm/@tailwindcss/browser@4"));
    assert!(html.contains(&format!("/s/{token}/f/styles/tokens.css")));
    assert!(html.contains(&format!("/s/{token}/f/components/app-header.js")));
    assert!(html.contains("design:select"), "picker runtime not injected");

    // The fragment body with its internal link rewritten into the sandbox.
    assert!(html.contains("Dashboard"), "fragment content missing");
    assert!(
        html.contains(&format!("href=\"/s/{token}/settings\"")),
        "internal link was not rewritten into the sandbox namespace"
    );
    assert!(
        !html.contains("href=\"/settings\""),
        "raw /settings href leaked through unrewritten"
    );

    // Source annotation: elements carry data-src back to their page line.
    assert!(html.contains("data-src=\"pages/index.html:"), "no data-src annotation");

    // Sandbox headers present.
    let csp = root.header("content-security-policy").unwrap_or_default();
    assert!(csp.contains("connect-src 'self' https://cdn.jsdelivr.net"));

    // --- the settings page, reached the way a user would --------------------
    let settings = app.get_sandbox(&format!("/s/{token}/settings")).await;
    assert_eq!(settings.status(), 200);
    let shtml = settings.text();
    assert!(shtml.contains("Workspace name"));
    // Back-link works too.
    assert!(shtml.contains(&format!("href=\"/s/{token}/\"")));

    // Both pages share ONE head — same tokens URL, same component script URL.
    let head_of = |doc: &str| doc.split("<body").next().unwrap_or("").to_string();
    assert_eq!(head_of(&html), head_of(&shtml), "heads drifted between pages");
}

#[tokio::test(flavor = "multi_thread")]
async fn composed_head_includes_thin_scrollbar_css() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    seed_samples(user_id, project_id, &app).await;

    let token = taskflow_design::sandbox::mint(project_id);
    let root = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(root.status(), 200);
    let html = root.text();

    // Small-device previews must scroll with a thin/overlay scrollbar, not
    // the ~16px OS desktop scrollbar, inside the fixed device width. Scoped
    // to the composed sandbox document only.
    assert!(
        html.contains("::-webkit-scrollbar"),
        "composed head missing webkit thin-scrollbar rule"
    );
    assert!(
        html.contains("scrollbar-width"),
        "composed head missing standard thin-scrollbar property"
    );
    // Phone-width previews must hide the track entirely (overlay-style), like a
    // real phone — a visible track inside a 390px frame reads as chaos.
    assert!(
        html.contains("@media (max-width: 500px)"),
        "composed head missing phone-width scrollbar media query"
    );
    assert!(
        html.contains("scrollbar-width: none"),
        "composed head missing phone-width scrollbar-hide rule"
    );
    // The sandbox <body> must paint the shadcn background/foreground tokens, not
    // the removed legacy --bg/--fg (which no longer resolve → transparent body,
    // breaking dark mode around the page content). Scoped to the <body> tag so a
    // sample page/component that references other vars can't skew the check.
    let body_tag = html
        .split_once("<body")
        .and_then(|(_, rest)| rest.split_once('>').map(|(attrs, _)| attrs))
        .expect("composed document has a <body> tag");
    assert!(
        body_tag.contains("bg-[var(--background)]") && body_tag.contains("text-[var(--foreground)]"),
        "composed body must use shadcn --background/--foreground tokens, got: {body_tag}"
    );
    assert!(
        !body_tag.contains("var(--bg)") && !body_tag.contains("var(--fg)"),
        "composed <body> still references removed legacy --bg/--fg tokens: {body_tag}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn manifest_reports_routes_components_and_usage() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    seed_samples(user_id, project_id, &app).await;

    let m = app
        .get_as(user_id, &format!("/api/design/{project_id}/manifest"))
        .await;
    assert_eq!(m.status(), 200);
    let v = m.json();

    let routes = v["routes"].as_array().expect("routes array");
    let route_paths: Vec<&str> = routes.iter().map(|r| r["path"].as_str().unwrap()).collect();
    assert!(route_paths.contains(&"/"));
    assert!(route_paths.contains(&"/settings"));

    let components = v["components"].as_array().expect("components array");
    assert_eq!(components.len(), 1);
    let header = &components[0];
    assert_eq!(header["name"], "app-header");
    assert_eq!(header["usedOn"].as_array().map(|a| a.len()), Some(2));
    assert_eq!(header["usageCount"], 2, "app-header used once per page");
    assert!(
        header["attrs"].as_array().unwrap().iter().any(|a| a == "title"),
        "observedAttributes not parsed"
    );
}

// ---------------------------------------------------------------------------
// Validator rejections over the wire
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn full_document_is_rejected() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/broken.html", "content": "<!doctype html><html><head></head><body><p>x</p></body></html>" }),
        )
        .await;
    assert_eq!(res.status(), 422);
    let v = res.json();
    assert_eq!(v["ok"], false);
    assert_eq!(v["errors"][0]["rule"], "full-document");
}

#[tokio::test(flavor = "multi_thread")]
async fn raw_layout_tag_is_rejected_with_suggestion() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    // Register nothing; even WITH a registry this page is wrong because it
    // uses <header> directly instead of <app-header>.
    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/dash.html",
                "content": "<div>\n  <header class=\"flex\">Top</header>\n</div>"
            }),
        )
        .await;
    assert_eq!(res.status(), 422);
    let v = res.json();
    assert_eq!(v["errors"][0]["rule"], "raw-layout-tag");
    assert_eq!(v["errors"][0]["line"], 2, "error must carry the offending line");
    assert_eq!(v["errors"][0]["suggest"], "<app-header></app-header>");
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_custom_element_names_the_registration_path() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/dash.html",
                "content": "<fancy-widget>hi</fancy-widget>"
            }),
        )
        .await;
    assert_eq!(res.status(), 422);
    let msg = res.json()["errors"][0]["message"].as_str().unwrap().to_string();
    assert!(msg.contains("unknown component: fancy-widget"), "{msg}");
    assert!(msg.contains("design_write_component"), "{msg}");
}

#[tokio::test(flavor = "multi_thread")]
async fn arbitrary_tailwind_values_are_rejected_with_token_hint() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    // app-header IS registered here so only the raw-colour rule can fire.
    app.put_json_as(
        user_id,
        &format!("/api/design/{project_id}/file"),
        &json!({ "path": "components/app-header.js", "content": sample_header_component() }),
    )
    .await;

    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/dash.html",
                "content": "<div class=\"bg-[#3b82f6] p-[13px]\"><app-header title=\"x\"></app-header></div>"
            }),
        )
        .await;
    assert_eq!(res.status(), 422);
    let e = &res.json()["errors"][0];
    assert_eq!(e["rule"], "raw-color");
    let msg = e["message"].as_str().unwrap();
    assert!(msg.contains("var(--accent)"), "must name the token to use: {msg}");

    // px spacing values are caught by the same rule.
    let res2 = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/dash.html",
                "content": "<div class=\"mt-[42px]\"><app-header title=\"x\"></app-header></div>"
            }),
        )
        .await;
    assert_eq!(res2.status(), 422);
}

#[tokio::test(flavor = "multi_thread")]
async fn hex_in_style_attribute_is_rejected() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    app.put_json_as(
        user_id,
        &format!("/api/design/{project_id}/file"),
        &json!({ "path": "components/app-header.js", "content": sample_header_component() }),
    )
    .await;

    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "pages/dash.html",
                "content": "<div style=\"background:#ff00aa\"><app-header title=\"x\"></app-header></div>"
            }),
        )
        .await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.json()["errors"][0]["rule"], "style-hex");
}

#[tokio::test(flavor = "multi_thread")]
async fn inline_style_block_is_rejected() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/dash.html", "content": "<style>.x{color:red}</style><p>hi</p>" }),
        )
        .await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.json()["errors"][0]["rule"], "inline-style-block");
}

#[tokio::test(flavor = "multi_thread")]
async fn build_tooling_paths_are_rejected() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    for path in ["package.json", "components/tailwind.config.js", "pages/util.mjs"] {
        let res = app
            .put_json_as(
                user_id,
                &format!("/api/design/{project_id}/file"),
                &json!({ "path": path, "content": "{}" }),
            )
            .await;
        assert_eq!(res.status(), 422, "{path} must be rejected");
        assert_eq!(res.json()["errors"][0]["rule"], "path", "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn traversal_and_nesting_are_rejected() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    for path in ["../escape.html", "pages/deep/thing.html", "/abs.html", "pages\\win.html"] {
        let res = app
            .put_json_as(
                user_id,
                &format!("/api/design/{project_id}/file"),
                &json!({ "path": path, "content": "<p>hi</p>" }),
            )
            .await;
        assert_eq!(res.status(), 422, "{path} must be rejected");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn component_rules_enforce_one_define_matching_filename() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;

    // Name mismatch.
    let res = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "components/app-footer.js",
                "content": "customElements.define('app-header', class extends HTMLElement {});"
            }),
        )
        .await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.json()["errors"][0]["rule"], "define-name");

    // Banned API.
    let res2 = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "components/app-bad.js",
                "content": "customElements.define('app-bad', class extends HTMLElement { connectedCallback(){ fetch('/etc'); } });"
            }),
        )
        .await;
    assert_eq!(res2.status(), 422);
    assert_eq!(res2.json()["errors"][0]["rule"], "banned-api");

    // Shadow DOM ban (Tailwind's scanner cannot see shadow content).
    let res3 = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "components/app-shadow.js",
                "content": "customElements.define('app-shadow', class extends HTMLElement { connectedCallback(){ this.attachShadow({mode:'open'}); } });"
            }),
        )
        .await;
    assert_eq!(res3.status(), 422);

    // Oversized file warns but does NOT reject.
    let filler = "// padding\n".repeat(700); // ~7.7 KB > 6 KB soft cap
    let ok = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "components/app-big.js",
                "content": format!("{filler}customElements.define('app-big', class extends HTMLElement {{}});")
            }),
        )
        .await;
    assert_eq!(ok.status(), 201, "oversize warns, never rejects");
    let warnings = ok.json()["warnings"].as_array().cloned().unwrap_or_default();
    assert!(warnings.iter().any(|w| w["rule"] == "component-size"));
}

#[tokio::test(flavor = "multi_thread")]
async fn tokens_must_carry_a_theme_block_and_no_remote_import() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;

    let no_theme = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.css", "content": ":root { --x: 1; }" }),
        )
        .await;
    assert_eq!(no_theme.status(), 422);
    assert_eq!(no_theme.json()["errors"][0]["rule"], "missing-theme");

    let remote = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.css", "content": "@theme { --bg: #fff; }\n@import url(https://evil.example/x.css);" }),
        )
        .await;
    assert_eq!(remote.status(), 422);
    assert_eq!(remote.json()["errors"][0]["rule"], "remote-import");
}

#[tokio::test(flavor = "multi_thread")]
async fn tokens_json_is_validated_as_json_not_css() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;

    // A well-formed tokens.json document is accepted.
    let valid = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "styles/tokens.json",
                "content": r##"{"version":1,"categories":{"colors":{"accent":{"light":"#6366f1","dark":"#818cf8"}}}}"##
            }),
        )
        .await;
    assert_eq!(valid.status(), 201, "valid tokens.json should be accepted: {}", valid.text());

    // Malformed JSON is rejected with a clear rule, not silently coerced.
    let malformed = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.json", "content": "{not json" }),
        )
        .await;
    assert_eq!(malformed.status(), 422);
    assert_eq!(malformed.json()["errors"][0]["rule"], "invalid-json");

    // A token value smuggling a remote URL is rejected, mirroring the CSS
    // @import ban.
    let remote = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({
                "path": "styles/tokens.json",
                "content": r#"{"version":1,"categories":{"custom":{"--x":{"light":"url(https://evil.example/x.css)"}}}}"#
            }),
        )
        .await;
    assert_eq!(remote.status(), 422);
    assert_eq!(remote.json()["errors"][0]["rule"], "remote-url");
}

// ---------------------------------------------------------------------------
// Versioning + concurrency
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn base_version_conflict_returns_409_with_current_content() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;

    let first = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v1</p>" }),
        )
        .await;
    assert_eq!(first.status(), 201);
    let version1 = first.json()["file"]["version"].as_i64().unwrap();

    // Stale writer: still holds base_version=1 while another write landed.
    app.put_json_as(
        user_id,
        &format!("/api/design/{project_id}/file"),
        &json!({ "path": "pages/index.html", "content": "<p>v2</p>", "base_version": version1 }),
    )
    .await;
    let stale = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v3-from-stale-agent</p>", "base_version": version1 }),
        )
        .await;
    assert_eq!(stale.status(), 409, "stale base must conflict");
    let v = stale.json();
    assert_eq!(v["error"], "version_conflict");
    assert_eq!(v["current_version"], 2);
    assert_eq!(v["current_content"], "<p>v2</p>", "conflict carries current content");

    // Correct base succeeds and bumps the version monotonically.
    let fresh = app
        .put_json_as(
            user_id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v3</p>", "base_version": 2 }),
        )
        .await;
    assert_eq!(fresh.status(), 201);
    assert_eq!(fresh.json()["file"]["version"], 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn files_listing_hides_content_but_file_endpoint_serves_it() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_minimal_project(&app).await;
    seed_samples(user_id, project_id, &app).await;

    let list = app
        .get_as(user_id, &format!("/api/design/{project_id}/files"))
        .await;
    assert_eq!(list.status(), 200);
    let rows = list.json().as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 4);
    let text = serde_json::to_string(&list.json()).unwrap();
    assert!(
        !text.contains("customElements.define('app-header'"),
        "listing must not leak content"
    );
    let summary = rows.iter().find(|r| r["path"] == "components/app-header.js").unwrap();
    assert_eq!(summary["version"], 1);
    let by = summary["updated_by"].as_str().unwrap();
    assert!(
        by.starts_with("operator:"),
        "operator writes are attributed, got {by}"
    );

    let one = app
        .get_as(
            user_id,
            &format!("/api/design/{project_id}/file?path=components/app-header.js"),
        )
        .await;
    assert_eq!(one.status(), 200);
    assert!(one.json()["content"].as_str().unwrap().contains("app-header"));
}

// ---------------------------------------------------------------------------
// Sandbox token security
// ---------------------------------------------------------------------------

#[test]
fn sandbox_token_rejects_forgery_and_expiry() {
    assert_eq!(taskflow_design::sandbox::verify("not-a-token"), None);
    let tok = taskflow_design::sandbox::mint(7);
    assert_eq!(taskflow_design::sandbox::verify(&tok), Some(7));
    let forged = tok.replacen("7.", "8.", 1);
    assert_ne!(taskflow_design::sandbox::verify(&forged), Some(8));
}
