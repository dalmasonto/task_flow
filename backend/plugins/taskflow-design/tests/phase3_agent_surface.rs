//! Phase 3 acceptance: the agent (MCP) surface.
//!
//! An agent with a real credential can create a third page composed only of
//! existing components; a deliberate `bg-[#ff0000]` is rejected with a usable
//! message; registry-level writes demand a `reason`; and the structured
//! comment targets carry file + element path + blast radius.

mod support;

use serde_json::json;
use support::TestApp;

/// Seed an agent + ACTIVE credential directly, returning the raw key. Uses the
/// same hashing scheme as `link_agent` (`sha256(raw)` stored, prefix indexed).
async fn seed_agent(
    project: i64,
    display_name: &str,
) -> (i64, String) {
    use taskflow_agents::agent_auth::hash_key;
    use taskflow_agents::models::{
        TaskflowAgent, TaskflowAgentCredential, TaskflowAgentStatus, TaskflowCredentialStatus,
    };
    use umbral::orm::ForeignKey;

    let n = umbral_testing::seq();
    let agent = TaskflowAgent::objects()
        .create(TaskflowAgent {
            id: 0,
            project: ForeignKey::new(project),
            display_name: display_name.to_string(),
            identifier: format!("design-agent-{n}"),
            fingerprint: None,
            project_root: None,
            taskflow_file_path: None,
            runtime: Some("test".into()),
            version: None,
            status: TaskflowAgentStatus::Offline,
            linked_by: None,
            linked_user_label: None,
            last_seen_at: None,
            created_at: None,
        })
        .await
        .expect("seed agent");

    let raw_key = format!("tfk_test{random}_{random}", random = format!("{n:08x}"));
    let prefix = format!("tfk_test{random}", random = format!("{n:08x}"));
    TaskflowAgentCredential::objects()
        .create(TaskflowAgentCredential {
            id: 0,
            project: ForeignKey::new(project),
            agent: Some(ForeignKey::new(agent.id)),
            issued_by: None,
            name: format!("test key {n}"),
            key_prefix: prefix,
            key_hash: hash_key(&raw_key),
            status: TaskflowCredentialStatus::Active,
            expires_at: None,
            revoked_at: None,
            created_at: None,
        })
        .await
        .expect("seed credential");

    (agent.id, raw_key)
}

async fn setup_app() -> (TestApp, i64, i64, i64, String) {
    let app = TestApp::new().await;
    // The design router alone serves /api/taskflow/agents/design/*; booting the
    // agents plugin registers its MODELS so the FK targets exist.
    let (user, project) = app.create_member_with_project().await;
    let (agent_id, key) = seed_agent(project, "Designer").await;
    let _ = user;
    (app, project, user.id, agent_id, key)
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_reads_context_and_registry() {
    let (app, project, _user, _agent, key) = setup_app().await;
    // Seed tokens + one component AS THE AGENT via its own write endpoint.
    let res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/tokens", json!({
        "project": project,
        "css": "@theme { --color-accent: #4f46e5; --spacing-1: 4px; }",
        "reason": "fresh project has no token scale yet"
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());

    let comp = r#"customElements.define('app-card', class extends HTMLElement {
  static get observedAttributes() { return ['title']; }
  connectedCallback() { this.innerHTML = `<section data-component="app-card" class="rounded p-3 bg-[var(--color-accent)]"><b>${this.getAttribute('title') ?? ''}</b></section>`; }
});"#;
    let res2 = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/component", json!({
        "project": project,
        "name": "app-card",
        "js": comp,
        "reason": "no card component in registry"
    }))
    .await;
    assert_eq!(res2.status(), 201, "{}", res2.text());
    let body = res2.json();
    assert_eq!(body["ok"], true);
    let note = body["note"].as_str().unwrap_or("");
    assert!(
        !note.contains("route(s) changed") || note.contains("0 route"),
        "no pages yet, so no routes affected: {note}"
    );

    let ctx = app.get_as_agent(key.as_str(), &format!("/api/taskflow/agents/design/context?project={project}")).await;
    assert_eq!(ctx.status(), 200);
    let v = ctx.json();
    assert!(v["tokens_css"].as_str().unwrap().contains("@theme"));
    let names: Vec<&str> = v["components"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["app-card"]);

    let primitive_names: Vec<&str> = v["primitives"]
        .as_array()
        .expect("context response has a primitives array")
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(
        primitive_names.contains(&"ui-tabs"),
        "primitives catalog should include ui-tabs: {primitive_names:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn context_serves_the_link_back_and_media_guidance() {
    let (app, project, _user, _agent, key) = setup_app().await;

    // The check that makes the guidance real: ask the endpoint the way an agent
    // does, and read what it actually SERVES. A string that is written into
    // `agent_views.rs` but never reaches this response is indistinguishable
    // from a capability that was never delivered.
    let ctx = app
        .get_as_agent(
            key.as_str(),
            &format!("/api/taskflow/agents/design/context?project={project}"),
        )
        .await;
    assert_eq!(ctx.status(), 200, "{}", ctx.text());
    let v = ctx.json();
    let guide = v["guide"]
        .as_str()
        .expect("context response carries the authoring guide");
    println!("--- context.guide as served ---\n{guide}\n--- end ---");

    // Linking, back navigation, and the habits that would silently undo them:
    // a hand-written sandbox URL, a new tab, and a Back button on a frame that
    // has no history to step back into.
    for needle in [
        "<a href=\"/route\">",
        "the browser's back/forward work",
        "<button onclick=\"history.back()\">Back</button>",
        "only once the frame HAS history",
        "opened directly at one route",
        // The claim itself, not just its setup and its remedy. The two markers
        // around it pin the CONDITION (`opened directly at one route`) and the
        // escape hatch (`A link to a known route always`), so a rewrite to
        // "and Back works there" — the sentence saying the opposite of what it
        // was added for — would satisfy both while the advice inverts.
        "and Back there does nothing",
        "A link to a known route always",
        "Do NOT hand-write sandbox URLs",
        "target=\"_blank\"",
    ] {
        assert!(guide.contains(needle), "guide is missing {needle:?}: {guide}");
    }

    // The media half, including the three things the policy does NOT allow:
    // plain http, a `<script src>` in a page fragment, and an inlined
    // animation larger than the per-file cap its component has to fit in.
    for needle in [
        "<img src=\"https://cdn.example/hero.png\"",
        "<video src=\"https://cdn.example/clip.mp4\" controls>",
        "data:/blob: URIs still work",
        "Plain http is refused",
        "<script src> in a page",
        "COMPONENT instead",
        "INLINE in that component",
        "assets/ accepts image",
        "128 KB per-file cap",
        "size-cap",
    ] {
        assert!(guide.contains(needle), "guide is missing {needle:?}: {guide}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_creates_third_page_from_existing_components() {
    let (app, project, _user, _agent, key) = setup_app().await;
    // Registry: tokens + two components (the shared parts).
    app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/tokens", json!({
        "project": project,
        "css": "@theme { --bg: #fff; --fg: #000; --accent: #4f46e5; }",
        "reason": "bootstrap the scale"
    }))
    .await;
    for (name, js) in [
        ("app-header", r#"customElements.define('app-header', class extends HTMLElement { connectedCallback() { this.innerHTML = '<header data-component="app-header"></header>'; } });"#),
        ("app-sidebar", r#"customElements.define('app-sidebar', class extends HTMLElement { connectedCallback() { this.innerHTML = '<aside-nav data-component="app-sidebar"></aside-nav>'; } });"#),
        ("ui-danger-zone", r#"customElements.define('ui-danger-zone', class extends HTMLElement { connectedCallback() { this.innerHTML = '<section data-component="ui-danger-zone" class="border border-[var(--accent)]">danger</section>'; } });"#),
    ] {
        let res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/component", json!({
            "project": project, "name": name, "js": js,
            "reason": "settings page composition needs this part"
        })).await;
        assert_eq!(res.status(), 201, "{name}: {}", res.text());
    }

    // THE acceptance flow: a third page from ONLY registered components.
    let page = concat!(
        "<app-header></app-header>\n",
        "<div class=\"flex\">\n",
        "  <app-sidebar></app-sidebar>\n",
        "  <main class=\"p-4\">\n",
        "    <h1>Settings</h1>\n",
        "    <form class=\"space-y-2\">\n",
        "      <input type=\"text\" placeholder=\"Workspace name\" />\n",
        "      <button class=\"rounded bg-[var(--accent)] px-3 py-1 text-white\">Save</button>\n",
        "    </form>\n",
        "    <ui-danger-zone></ui-danger-zone>\n",
        "  </main>\n",
        "</div>"
    );
    let res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/page", json!({
        "project": project,
        "route": "/settings",
        "html": page
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["affected_routes"], json!(["/settings"]));

    // And it renders through the sandbox as a full document.
    let token = taskflow_design::sandbox::mint(project);
    let rendered = app.get_sandbox(&format!("/s/{token}/settings")).await;
    assert_eq!(rendered.status(), 200);
    let html = rendered.text();
    assert!(html.contains("<!doctype html>") && html.contains("app-sidebar"));
}

#[tokio::test(flavor = "multi_thread")]
async fn deliberate_raw_hex_is_rejected_with_a_usable_message() {
    let (app, project, _user, _agent, key) = setup_app().await;
    app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/tokens", json!({
        "project": project,
        "css": "@theme { --accent: #4f46e5; }",
        "reason": "bootstrap"
    })).await;

    let bad = "<div class=\"bg-[#ff0000] text-white\">alert</div>";
    let res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/page", json!({
        "project": project,
        "route": "/billing",
        "html": bad
    }))
    .await;
    assert_eq!(res.status(), 422, "raw hex MUST be rejected");
    let v = res.json();
    assert_eq!(v["ok"], false);
    let err = &v["errors"][0];
    assert_eq!(err["rule"], "raw-color");
    let msg = err["message"].as_str().unwrap();
    assert!(msg.contains("bg-[#ff0000]"), "names what it found: {msg}");
    assert!(msg.contains("var(--"), "names the token to use instead: {msg}");
    assert_eq!(err["suggest"], "bg-[var(--accent)]");
}

#[tokio::test(flavor = "multi_thread")]
async fn registry_writes_require_a_real_reason() {
    let (app, project, _user, _agent, key) = setup_app().await;

    // Missing reason entirely → 400 from serde-less validation.
    let res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/tokens", json!({
        "project": project,
        "css": "@theme { --x: 1; }"
    }))
    .await;
    assert_eq!(res.status(), 422);

    // Token reason present → accepted.
    let ok_res = app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/tokens", json!({
        "project": project,
        "css": "@theme { --x: 1; }",
        "reason": "brand refresh across all surfaces"
    }))
    .await;
    assert_eq!(ok_res.status(), 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn comments_surface_as_structured_targets_and_resolve() {
    let (app, project, user_id, _agent, key) = setup_app().await;
    // A component used on one page so usedOn is non-empty.
    app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/component", json!({
        "project": project,
        "name": "app-avatar",
        "js": r#"customElements.define('app-avatar', class extends HTMLElement { connectedCallback() { this.innerHTML = '<img data-component="app-avatar" class="h-8 w-8 rounded-full" alt="">'; } });"#,
        "reason": "avatars recur on every page header"
    })).await;
    app.put_as_agent(key.as_str(), "/api/taskflow/agents/design/page", json!({
        "project": project,
        "route": "/profile",
        "html": "<app-avatar></app-avatar>"
    })).await;

    // Operator leaves a comment anchored to that avatar.
    let created = app.post_json_as(user_id, &format!("/api/design/{project}/comments"), &json!({
        "page_path": "/profile",
        "component_name": "app-avatar",
        "element_path": "app-avatar > img:nth-child(1)",
        "src_ref": null,
        "viewport": "iphone-16-pro",
        "rect": {"x": 12, "y": 8, "w": 32, "h": 32},
        "snippet": "<img class=\"h-8 w-8 rounded-full\" ...>",
        "body": "make the avatar smaller and add a dropdown on click",
        "scope": "instance"
    }))
    .await;
    assert_eq!(created.status(), 201);

    // The agent reads them as STRUCTURED TARGETS.
    let list = app.get_as_agent(key.as_str(), &format!("/api/taskflow/agents/design/comments?project={project}&status=open")).await;
    assert_eq!(list.status(), 200);
    let target = &list.json()["comments"][0];
    assert_eq!(target["target"]["file"], "components/app-avatar.js");
    assert_eq!(target["target"]["component"], "app-avatar");
    assert_eq!(target["target"]["usedOn"], json!(["/profile"]));
    assert!(target["instruction"].as_str().unwrap().contains("avatar smaller"));

    // Resolve with a note; operator PATCH view reflects addressed.
    let comment_row_id = {
        // cm_<hex-of-row-id>; row ids start at 1 per fresh DB.
        let raw = target["commentId"].as_str().unwrap().trim_start_matches("cm_");
        i64::from_str_radix(raw, 16).expect("hex comment id")
    };
    let resolved = app.post_json_as_agent(key.as_str(), &format!("/api/taskflow/agents/design/comments/{comment_row_id}/resolve"), &json!({
        "project": project,
        "note": "avatar is now h-6 w-6 with a click dropdown attribute"
    }))
    .await;
    assert_eq!(resolved.status(), 200);

    let mine = app.get_as(user_id, &format!("/api/design/{project}/comments?status=addressed")).await;
    let rows = mine.json().as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1);
    assert!(rows[0]["resolution_note"].as_str().unwrap().contains("dropdown"));
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_write_tokens_json_stores_json_row_and_get_tokens_returns_it() {
    let (app, project, _user, _agent, key) = setup_app().await;

    let res = app
        .put_as_agent(
            key.as_str(),
            "/api/taskflow/agents/design/tokens",
            json!({
                "project": project,
                "tokens": {
                    "version": 1,
                    "categories": {
                        "colors": { "accent": { "light": "#4f46e5" } }
                    }
                },
                "reason": "seed the scale as structured json"
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["file"]["path"], "styles/tokens.json");

    let ctx = app
        .get_as_agent(
            key.as_str(),
            &format!("/api/taskflow/agents/design/context?project={project}"),
        )
        .await;
    assert_eq!(ctx.status(), 200);
    let v = ctx.json();
    assert_eq!(v["tokens_json"]["categories"]["colors"]["accent"]["light"], "#4f46e5");
    assert!(
        v["tokens_css"].as_str().unwrap().contains("--accent: #4f46e5;"),
        "{}",
        v["tokens_css"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_write_tokens_requires_exactly_one_of_tokens_or_css() {
    let (app, project, _user, _agent, key) = setup_app().await;

    // Neither.
    let neither = app
        .put_as_agent(
            key.as_str(),
            "/api/taskflow/agents/design/tokens",
            json!({ "project": project, "reason": "bootstrap the scale now" }),
        )
        .await;
    assert_eq!(neither.status(), 422, "{}", neither.text());

    // Both.
    let both = app
        .put_as_agent(
            key.as_str(),
            "/api/taskflow/agents/design/tokens",
            json!({
                "project": project,
                "css": "@theme { --accent: #fff; }",
                "tokens": {"version": 1, "categories": {}},
                "reason": "bootstrap the scale now"
            }),
        )
        .await;
    assert_eq!(both.status(), 422, "{}", both.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_tokens_css_only_project_context_derives_json_without_a_write() {
    use taskflow_design::models::{DesignFile, DesignFileKind};
    use umbral::orm::ForeignKey;

    let (app, project, _user, _agent, key) = setup_app().await;

    // Seed ONLY a legacy tokens.css row directly (no json row, no agent write).
    DesignFile::objects()
        .create(DesignFile {
            id: 0,
            project: ForeignKey::new(project),
            kind: DesignFileKind::Token,
            path: "styles/tokens.css".to_string(),
            content: "@theme { --accent: #112233; }".to_string(),
            version: 1,
            updated_by: "operator".to_string(),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("seed legacy tokens.css");

    let ctx = app
        .get_as_agent(
            key.as_str(),
            &format!("/api/taskflow/agents/design/context?project={project}"),
        )
        .await;
    assert_eq!(ctx.status(), 200);
    let v = ctx.json();
    // A bare `--accent` var (no known category prefix) round-trips into the
    // `custom` bucket with the full var name kept verbatim as the key — see
    // `tokens.rs::var_name_to_category`.
    assert_eq!(v["tokens_json"]["categories"]["custom"]["--accent"]["light"], "#112233");
    assert!(v["tokens_css"].as_str().unwrap().contains("--accent: #112233;"));
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_write_tokens_css_migrates_legacy_project_to_json_row() {
    use taskflow_design::models::{DesignFile, DesignFileKind};
    use umbral::orm::ForeignKey;

    let (app, project, _user, _agent, key) = setup_app().await;

    // Legacy-only project (mirrors a pre-Phase-2 project on disk).
    DesignFile::objects()
        .create(DesignFile {
            id: 0,
            project: ForeignKey::new(project),
            kind: DesignFileKind::Token,
            path: "styles/tokens.css".to_string(),
            content: "@theme { --accent: #112233; }".to_string(),
            version: 1,
            updated_by: "operator".to_string(),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("seed legacy tokens.css");

    let res = app
        .put_as_agent(
            key.as_str(),
            "/api/taskflow/agents/design/tokens",
            json!({
                "project": project,
                "css": "@theme { --accent: #445566; --spacing-1: 4px; }",
                "reason": "brand refresh migrates the legacy file"
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["file"]["path"], "styles/tokens.json");

    let row = app
        .get_as_agent(
            key.as_str(),
            &format!("/api/taskflow/agents/design/context?project={project}"),
        )
        .await;
    let v = row.json();
    assert_eq!(v["tokens_json"]["categories"]["custom"]["--accent"]["light"], "#445566");
}

#[tokio::test(flavor = "multi_thread")]
async fn foreign_project_is_refused_not_routed() {
    let (app, project, _user, _agent, key) = setup_app().await;
    // Another project the agent does NOT belong to.
    let (_other_user, other_project) = app.create_member_with_project().await;

    let res = app
        .get_as_agent(
            key.as_str(),
            &format!("/api/taskflow/agents/design/context?project={other_project}"),
        )
        .await;
    assert_eq!(res.status(), 403, "credential pins ONE project");

    let _ = project;
}
