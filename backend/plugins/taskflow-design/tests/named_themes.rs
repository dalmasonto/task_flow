//! #619: named design themes end to end — the token write, the manifest, the
//! sandbox, compare and screenshot validation. The renderer is not configured
//! in tests, so a render that got past validation answers 503.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

const LEGACY_TOKENS: &str =
    r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}}}"##;

/// A project with a home page and the legacy light/dark tokens, plus an agent key.
async fn seeded(app: &TestApp) -> (i64, i64, String) {
    let (user, project) = app.create_member_with_project().await;
    for (path, content) in [("pages/index.html", "<main><h1>Home</h1></main>"), ("styles/tokens.json", LEGACY_TOKENS)] {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    let (_agent, key) = seed_agent(project, "Designer").await;
    (user.id, project, key)
}

async fn patch(app: &TestApp, key: &str, project: i64, patch: serde_json::Value) -> support::TestResponse {
    app.put_as_agent(
        key,
        "/api/taskflow/agents/design/tokens",
        json!({ "project": project, "reason": "Try a named theme palette", "patch": patch }),
    )
    .await
}

async fn stored(project: i64) -> serde_json::Value {
    let row = taskflow_design::store::load_file(project, "styles/tokens.json").await.expect("tokens row");
    serde_json::from_str(&row.content).expect("tokens json")
}

/// Declare `ocean` (keeping dark) with a primary of its own.
async fn add_ocean(app: &TestApp, key: &str, project: i64) {
    let res = patch(app, key, project, json!({
        "themes": [{ "name": "dark" }, { "name": "ocean" }],
        "colors": { "primary": { "ocean": "#0af" } },
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_patch_declares_a_theme_and_edits_only_that_theme() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    let res = patch(&app, &key, project, json!({
        "themes": [{ "name": "dark" }, { "name": "ocean", "label": "Ocean" }],
        "colors": { "primary": { "ocean": "#0af" } },
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["themes"], json!(["light", "dark", "ocean"]));
    let doc = stored(project).await;
    assert_eq!(doc["themes"], json!([{ "name": "dark" }, { "name": "ocean", "label": "Ocean" }]));
    assert_eq!(doc["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0af" }));

    // Acceptance 6: a later per-theme patch touches ONLY that theme.
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "ocean": "#0bf" } } })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0bf" }));

    // null drops the override: ocean inherits light again.
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "ocean": null } } })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_theme_is_a_clear_error() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "sunset": "#f00" } } })).await;
    assert_eq!(res.status(), 422, "{}", res.text());
    let message = res.json()["errors"][0]["message"].as_str().unwrap_or_default().to_string();
    assert!(message.contains("unknown theme `sunset`") && message.contains("light, dark"), "{message}");
    // A whole-document write is held to the same rule by the validator.
    let res = app
        .put_as_agent(&key, "/api/taskflow/agents/design/tokens", json!({
            "project": project,
            "reason": "Replace the whole document",
            "tokens": { "version": 1, "categories": { "colors": { "p": { "light": "red", "sunset": "blue" } } } },
        }))
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(res.json()["errors"][0]["rule"], "theme-unknown");
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_moves_values_and_an_omitted_theme_is_reported_removed() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;

    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "dark" }, { "name": "sea", "rename_from": "ocean" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert!(res.json().get("themes_removed").is_none(), "a rename removes nothing: {}", res.text());
    assert_eq!(res.json()["themes_renamed"], json!([{ "from": "ocean", "to": "sea" }]), "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "sea": "#0af" }));

    // Review focus 1: listing only the new theme deletes dark — and says so.
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "sea" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let reply = res.json();
    assert_eq!(reply["themes_removed"], json!(["dark"]), "{reply}");
    assert!(reply["note"].as_str().unwrap_or_default().contains("Removed theme(s) dark"), "{reply}");
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "sea": "#0af" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_manifest_and_context_list_themes_with_swatches() {
    let app = TestApp::new().await;
    let (user, project, key) = seeded(&app).await;
    let manifest = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json();
    let themes = manifest["themes"].clone();
    assert_eq!(themes.as_array().map(|t| t.len()), Some(2), "legacy: light + dark: {themes}");
    assert_eq!(themes[0]["name"], "light");
    assert_eq!(themes[1], json!({ "name": "dark", "label": "Dark", "swatch": { "primary": "#22C55E", "background": "oklch(0.145 0 0)" } }));

    add_ocean(&app, &key, project).await;
    let themes = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json()["themes"].clone();
    // Ruling 3: ocean sets no background, so it inherits the LIGHT default.
    assert_eq!(themes[2], json!({ "name": "ocean", "label": "Ocean", "swatch": { "primary": "#0af", "background": "oklch(1 0 0)" } }));

    let ctx = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/context?project={project}"))
        .await
        .json();
    let names: Vec<serde_json::Value> = ctx["themes"].as_array().cloned().unwrap_or_default().iter().map(|t| t["name"].clone()).collect();
    assert_eq!(names, vec![json!("light"), json!("dark"), json!("ocean")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn renaming_onto_an_existing_theme_is_refused_and_stores_nothing() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    let before = stored(project).await;
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "ocean", "rename_from": "dark" }] })).await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert!(res.text().contains("already exists"), "{}", res.text());
    assert_eq!(stored(project).await, before);
    // A swap is legal and trades the values.
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "ocean", "rename_from": "dark" }, { "name": "dark", "rename_from": "ocean" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "ocean": "#22C55E", "dark": "#0af" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sandbox_renders_any_declared_theme_and_falls_back_to_light() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    let token = taskflow_design::sandbox::mint(project);
    for (query, expected) in [
        ("?theme=ocean", "ocean"),
        ("?theme=dark", "dark"),
        ("?theme=light", "light"),
        ("", "light"),
        ("?theme=sunset", "light"),
        ("?theme=both", "light"),
        ("?theme=Ocean", "light"),
        ("?theme=%22%3E%3Cscript%3E", "light"),
    ] {
        let res = app.get_sandbox(&format!("/s/{token}/{query}")).await;
        assert_eq!(res.status(), 200, "{query}: {}", res.text());
        assert!(
            res.text().contains(&format!("<html lang=\"en\" data-theme=\"{expected}\">")),
            "{query}: expected data-theme={expected}"
        );
    }
    let css = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await.text();
    assert!(css.contains(":root[data-theme=\"ocean\"] {\n  --primary: #0af;\n}"), "{css}");
}

async fn compare(app: &TestApp, key: &str, body: serde_json::Value) -> support::TestResponse {
    app.post_json_as_agent(key, "/api/taskflow/agents/design/compare", &body).await
}

#[tokio::test(flavor = "multi_thread")]
async fn compare_takes_any_declared_theme_and_refuses_the_rest() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    // Acceptance 5: three themes, no overrides — valid; no renderer in tests.
    let ok = compare(&app, &key, json!({ "project": project, "routes": ["/"], "variants": [{ "label": "Current" }], "themes": ["light", "dark", "ocean"] })).await;
    assert_eq!(ok.status(), 503, "{}", ok.text());
    let unknown = compare(&app, &key, json!({ "project": project, "routes": ["/"], "variants": [{ "label": "Current" }], "themes": ["light", "sunset"] })).await;
    assert_eq!(unknown.status(), 400, "{}", unknown.text());
    assert!(unknown.text().contains("sunset") && unknown.text().contains("light, dark, ocean"), "{}", unknown.text());
    let bad_variant = compare(&app, &key, json!({
        "project": project, "routes": ["/"],
        "variants": [{ "label": "X", "tokens": { "--primary": { "sunset": "#f00" } } }],
    }))
    .await;
    assert_eq!(bad_variant.status(), 400, "{}", bad_variant.text());
    // Review focus 5: an unsaved single value beats the ocean block on an ocean page.
    let token = taskflow_design::sandbox::mint(project);
    let ov = taskflow_design::compare::encode(&taskflow_design::compare::Overrides {
        tokens: [("--primary".to_string(), taskflow_design::compare::OverrideValue::Both("#448502".into()))].into(),
        css: None,
    });
    let html = app.get_sandbox(&format!("/s/{token}/?theme=ocean&ov={ov}")).await.text();
    assert!(html.contains(":root[data-theme]{--primary:#448502;}"), "{html}");
}
