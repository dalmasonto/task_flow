//! #522: unsaved overrides on sandbox pages, the comparison grid page, and the
//! agent `design/compare` endpoint's validation. The renderer itself is out of
//! reach here (no Chromium), so the endpoint is exercised up to the point it
//! would render: with no renderer configured it must answer 503, and every
//! request it should refuse must be refused BEFORE that.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};
use taskflow_design::compare::{self, GridRoute, GridSpec, GridVariant, OverrideValue, Overrides};

const TOKENS_JSON: &str = r##"{"version":1,"categories":{
    "colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}
}}"##;

async fn seeded(app: &TestApp) -> i64 {
    let (user, project_id) = app.create_member_with_project().await;
    for (path, content) in [
        ("pages/index.html", "<main><h1>Home</h1></main>"),
        ("pages/setup.html", "<main><h1>Setup</h1></main>"),
        ("styles/tokens.json", TOKENS_JSON),
    ] {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project_id}/file"), &json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    project_id
}

fn lime() -> Overrides {
    Overrides {
        tokens: [("--primary".to_string(), OverrideValue::Both("#448502".into()))].into(),
        css: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn overrides_are_appended_after_the_tokens_and_bad_ones_refused() {
    let app = TestApp::new().await;
    let project_id = seeded(&app).await;
    let token = taskflow_design::sandbox::mint(project_id);

    let plain = app.get_sandbox(&format!("/s/{token}/setup")).await.text();
    assert!(!plain.contains("tf-override"), "no override without ?ov=");

    let res = app.get_sandbox(&format!("/s/{token}/setup?ov={}", compare::encode(&lime()))).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let html = res.text();
    let style = html.find("<style id=\"tf-override\">:root{--primary:#448502;}").expect("override block");
    let tokens = html.find("f/styles/tokens.css").expect("tokens link");
    assert!(style > tokens, "the override must come after tokens.css to win");

    // Hand-crafted, invalid overrides are refused, not rendered.
    let crafted = base64_url(r#"{"tokens":{"--primary":"red;}</style><script>alert(1)</script>"}}"#);
    assert_eq!(app.get_sandbox(&format!("/s/{token}/setup?ov={crafted}")).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_grid_page_frames_each_route_variant_and_theme() {
    let app = TestApp::new().await;
    let project_id = seeded(&app).await;
    let token = taskflow_design::sandbox::mint(project_id);
    let spec = GridSpec {
        routes: vec![
            GridRoute { route: "/".into(), state: None, label: Some("Home".into()) },
            GridRoute { route: "/setup".into(), state: None, label: None },
        ],
        variants: vec![
            GridVariant { label: "Current".into(), overrides: Overrides::default() },
            GridVariant { label: "Lime <AA>".into(), overrides: lime() },
        ],
        themes: vec!["light".into(), "dark".into()],
        width: 393,
        height: 852,
        scale: 0.5,
        checks: vec![],
    };
    let res = app
        .get_sandbox(&format!("/s/{token}/{}?spec={}", compare::GRID_ROUTE, compare::encode_spec(&spec)))
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let html = res.text();
    assert_eq!(html.matches("<iframe").count(), 8, "2 routes × 2 variants × 2 themes");
    assert!(html.contains("Lime &lt;AA&gt;"), "labels are escaped");
    assert!(html.contains(&format!("/s/{token}/setup?theme=dark&amp;ov=")) || html.contains(&format!("/s/{token}/setup?theme=dark&ov=")));
    assert!(html.contains("window.__tfReady"));

    assert_eq!(app.get_sandbox(&format!("/s/{token}/{}", compare::GRID_ROUTE)).await.status(), 400, "no spec");
}

#[tokio::test(flavor = "multi_thread")]
async fn compare_refuses_bad_requests_before_rendering() {
    let app = TestApp::new().await;
    let project_id = seeded(&app).await;
    let (_agent, key) = seed_agent(project_id, "Designer").await;
    let post = |body: serde_json::Value| {
        let app = &app;
        let key = key.clone();
        async move { app.post_json_as_agent(&key, "/api/taskflow/agents/design/compare", &body).await }
    };
    let base = |routes: serde_json::Value, variants: serde_json::Value| {
        json!({ "project": project_id, "routes": routes, "variants": variants })
    };

    let unknown = post(base(json!(["/nope"]), json!([{ "label": "Current" }]))).await;
    assert_eq!(unknown.status(), 400, "{}", unknown.text());
    assert!(unknown.text().contains("not a page in this project"));

    let bad_value = post(base(json!(["/setup"]), json!([{ "label": "X", "tokens": { "--primary": "url(https://x)" } }]))).await;
    assert_eq!(bad_value.status(), 400, "{}", bad_value.text());

    let too_many = post(json!({
        "project": project_id,
        "routes": ["/", "/setup", "/", "/setup", "/", "/setup"],
        "variants": [{ "label": "a" }, { "label": "b" }, { "label": "c" }],
        "themes": ["light", "dark"],
    }))
    .await;
    assert_eq!(too_many.status(), 400, "{}", too_many.text());
    assert!(too_many.text().contains("over the limit"));

    // Valid, but no renderer in the test environment: it got as far as rendering.
    let valid = post(json!({
        "project": project_id,
        "routes": ["/", { "route": "/setup", "label": "Setup" }],
        "variants": [{ "label": "Current" }, { "label": "Lime", "tokens": { "--primary": "#448502" } }],
        "themes": ["light", "dark"],
        "checks": [{ "fg": "--primary-foreground", "bg": "--primary" }],
    }))
    .await;
    assert_eq!(valid.status(), 503, "{}", valid.text());

    let other_project = post(json!({ "project": project_id + 999, "routes": ["/"], "variants": [{ "label": "a" }] })).await;
    assert!(other_project.status() == 403 || other_project.status() == 404, "{}", other_project.status());
}

fn base64_url(raw: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// Builder's upgrade §2.2: `design_write_tokens({patch})` changes only what
/// it names, and a stale `base_version` is a 409, not a silent overwrite.
#[tokio::test(flavor = "multi_thread")]
async fn a_token_patch_merges_and_refuses_a_stale_base_version() {
    let app = TestApp::new().await;
    let project_id = seeded(&app).await;
    let (_agent, key) = seed_agent(project_id, "Designer").await;
    let path = "/api/taskflow/agents/design/tokens";
    let stored = || async {
        let row = taskflow_design::store::load_file(project_id, "styles/tokens.json").await.expect("tokens row");
        serde_json::from_str::<serde_json::Value>(&row.content).expect("tokens json")
    };

    let res = app
        .put_as_agent(
            &key,
            path,
            json!({
                "project": project_id,
                "reason": "Try the lime primary from the compare",
                "patch": { "colors": { "primary": { "light": "#448502" }, "accent": { "light": "#f59e0b" } } },
            }),
        )
        .await;
    assert!((200..300).contains(&res.status()), "{}: {}", res.status(), res.text());
    // The reply is the new version and what changed — not the stored file
    // echoed back, and not every route listed (a token write touches them all).
    let reply = res.json();
    assert!(reply.get("file").is_none(), "no echoed document: {reply}");
    assert!(reply.get("affected_routes").is_none(), "no route list: {reply}");
    assert!(reply["version"].as_i64().unwrap_or(0) >= 2, "{reply}");
    assert_eq!(reply["routes_affected"], 2, "a count of the project's routes: {reply}");
    assert_eq!(reply["changed_count"], 2);
    let primary_change = reply["changed"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["var"] == "--primary"))
        .cloned()
        .expect("--primary in changed");
    assert_eq!(primary_change["before"]["light"], "#15803D");
    assert_eq!(primary_change["after"], json!({ "light": "#448502", "dark": "#22C55E" }));
    assert!(reply.to_string().len() < 800, "compact reply, got {} bytes", reply.to_string().len());

    let tokens = stored().await;
    let primary = &tokens["categories"]["colors"]["primary"];
    assert_eq!(primary["light"], "#448502");
    assert_eq!(primary["dark"], "#22C55E", "the dark value the patch did not name is untouched");
    assert_eq!(tokens["categories"]["colors"]["accent"]["light"], "#f59e0b");

    let stale = app
        .put_as_agent(
            &key,
            path,
            json!({
                "project": project_id,
                "reason": "An edit based on an old read",
                "base_version": 1,
                "patch": { "colors": { "primary": { "light": "#000000" } } },
            }),
        )
        .await;
    assert_eq!(stale.status(), 409, "{}", stale.text());

    let both = app
        .put_as_agent(&key, path, json!({ "project": project_id, "reason": "two shapes at once", "patch": {}, "css": "@theme{}" }))
        .await;
    assert_eq!(both.status(), 422, "{}", both.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_diffs_against_the_effective_tokens_not_the_stored_doc() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    // A fresh project: no tokens row, `--primary` is served from the defaults.
    let _ = user;
    let files = taskflow_design::store::list_files(project).await;
    let dark_only = Overrides {
        tokens: [("--primary".to_string(), OverrideValue::PerTheme([("dark".to_string(), "oklch(0.9 0.1 250)".to_string())].into()))].into(),
        css: None,
    };
    let variants = vec![GridVariant { label: "Dark".into(), overrides: dark_only }];
    let (apply, _) = taskflow_design::agent_views::compare_apply(&files, &variants);
    assert_eq!(
        apply["Dark"]["patch"],
        json!({"colors":{"primary":{"light":"oklch(0.205 0 0)","dark":"oklch(0.9 0.1 250)"}}})
    );
    assert!(apply["Dark"].get("added_to_custom").is_none(), "{apply}");
}

/// #619 (I1): the built-in defaults carry `dark`, but a project that declares
/// only `ocean` must never be handed a `dark` value — the patch would be
/// refused by `design_write_tokens` ("unknown theme `dark`").
#[test]
fn apply_keeps_only_light_and_the_declared_themes() {
    use taskflow_design::tokens::{TokensDoc, apply_patch};
    let stored: TokensDoc = serde_json::from_str(
        r##"{"version":1,"themes":[{"name":"ocean"}],"categories":{"colors":{"bg":{"light":"#fff","ocean":"#024"}}}}"##,
    )
    .expect("doc");
    let effective = taskflow_design::defaults::effective_tokens(&stored);
    let ov = Overrides {
        tokens: [("--primary".to_string(), OverrideValue::Both("#448502".to_string()))].into(),
        css: None,
    };
    let (patch, added) = compare::apply_diff(&effective, &ov);
    assert!(added.is_empty(), "{added:?}");
    assert_eq!(patch, json!({"colors":{"primary":{"light":"#448502"}}}));
    // A per-theme override keeps its declared theme and still drops the default dark.
    let per_theme = Overrides {
        tokens: [("--primary".to_string(), OverrideValue::PerTheme([("ocean".to_string(), "#0af".to_string())].into()))].into(),
        css: None,
    };
    let (patch2, _) = compare::apply_diff(&effective, &per_theme);
    assert!(patch2["colors"]["primary"].get("dark").is_none(), "{patch2}");
    assert_eq!(patch2["colors"]["primary"]["ocean"], json!("#0af"));
    // Both patches apply cleanly and the result validates.
    for p in [&patch, &patch2] {
        let mut doc = stored.clone();
        apply_patch(&mut doc, p).expect("patch applies");
        let content = serde_json::to_string(&doc).expect("json");
        let v = taskflow_design::validation::validate_tokens_json(&content);
        assert!(v.ok, "{:?}", v.errors);
    }
}

/// A legacy light+dark project (no `themes` list) still gets its dark value.
#[test]
fn apply_on_a_legacy_project_still_carries_dark() {
    let stored: taskflow_design::tokens::TokensDoc = serde_json::from_str(TOKENS_JSON).expect("doc");
    let effective = taskflow_design::defaults::effective_tokens(&stored);
    let ov = Overrides {
        tokens: [
            ("--primary".to_string(), OverrideValue::Both("#448502".to_string())),
            ("--ring".to_string(), OverrideValue::Both("#111".to_string())),
        ]
        .into(),
        css: None,
    };
    let (patch, _) = compare::apply_diff(&effective, &ov);
    assert_eq!(patch["colors"]["primary"], json!({"light":"#448502","dark":"#448502"}));
    // `--ring` comes from the defaults, which carry dark: still kept.
    assert_eq!(patch["colors"]["ring"], json!({"light":"#111","dark":"#111"}));
}
