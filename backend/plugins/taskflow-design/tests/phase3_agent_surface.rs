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
async fn the_page_read_spells_the_fragment_file_and_never_path() {
    // The other half of the misroute the arrangement read was renamed for.
    // `design_list_components` spells a ROUTE `path` (`manifest::RouteEntry`,
    // served verbatim, so `routes[].path` is `/settings`), so the habit that
    // tool teaches — `routes.find(r => r.path === page.path)` — compared a
    // route against `pages/settings.html` and found nothing. This response was
    // the last design read left spelling a FILE `path`; it spells it `file`
    // now, like `design_read_layout` and `design_read_component` do.
    //
    // It is a RENAME and not a second key: the MCP client returns this body
    // opaquely (`readDesignPage` is typed `Promise<unknown>` and the tool
    // serialises it whole), so nothing read the old key and a caller still
    // reaching for `path` gets nothing rather than a file name under a word the
    // registry uses for routes.
    let (app, project, _user, _agent, key) = setup_app().await;
    let written = app
        .put_as_agent(
            key.as_str(),
            AGENT_PAGE,
            json!({
                "project": project,
                "route": "/settings",
                "html": "<main class=\"p-4\">Settings</main>"
            }),
        )
        .await;
    assert_eq!(written.status(), 201, "{}", written.text());

    let read = app
        .get_as_agent(
            key.as_str(),
            &format!("{AGENT_PAGE}?project={project}&route=/settings"),
        )
        .await;
    assert_eq!(read.status(), 200, "{}", read.text());
    let v = read.json();
    assert_eq!(v["route"], "/settings", "the route is `route`: {v}");
    assert_eq!(v["file"], "pages/settings.html", "the fragment is `file`: {v}");
    assert_eq!(
        v["path"],
        serde_json::Value::Null,
        "`path` means the ROUTE next door — it must not appear here at all: {v}"
    );
    assert!(
        v["content"].as_str().unwrap_or("").contains("Settings"),
        "the fragment itself is still the body of this read: {v}"
    );
    assert!(
        v["version"].as_i64().unwrap_or(0) >= 1,
        "and so is the version an optimistic write needs: {v}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_component_read_spells_the_fragment_file_and_never_path() {
    // The last design read that spelled a FILE `path` while the same word is a
    // ROUTE in `design_list_components` (`routes[].path`, `manifest::RouteEntry`
    // served verbatim) — and while the registry's own component entries spell
    // the fragment `file` (`components[].file`), so the two spellings of one
    // value were in the same response's neighbourhood. Renamed for the same
    // reason and on the same evidence as `design_read_page`: the MCP client
    // returns this body opaquely and no test read the key.
    let (app, project, _user, _agent, key) = setup_app().await;
    let written = app
        .put_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            json!({
                "project": project,
                "name": "app-header",
                "js": "customElements.define('app-header', class extends HTMLElement {});",
                "reason": "the registry needs a header to compose pages from"
            }),
        )
        .await;
    assert_eq!(written.status(), 201, "{}", written.text());

    let read = app
        .get_as_agent(
            key.as_str(),
            &format!("{AGENT_COMPONENT}?project={project}&name=app-header"),
        )
        .await;
    assert_eq!(read.status(), 200, "{}", read.text());
    let v = read.json();
    assert_eq!(v["name"], "app-header");
    assert_eq!(
        v["file"], "components/app-header.js",
        "the fragment is `file`, as it is in the registry's `components[].file`: {v}"
    );
    assert_eq!(
        v["path"],
        serde_json::Value::Null,
        "`path` means the ROUTE in design_list_components — it must not appear here: {v}"
    );
    assert!(
        v["content"].as_str().unwrap_or("").contains("app-header"),
        "the source itself is still the body of this read: {v}"
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

// ---------------------------------------------------------------------------
// Component retirement and the asset route (the gap-batch additions)
//
// Both exist because the design plugin had no DELETE anywhere and no way for an
// agent to write `assets/` at all. The interesting half is what the delete must
// REFUSE: see `delete_component`'s docs for why a stranded page is worse than
// the registry drift retirement fixes.
// ---------------------------------------------------------------------------

const AGENT_COMPONENT: &str = "/api/taskflow/agents/design/component";
const AGENT_PAGE: &str = "/api/taskflow/agents/design/page";
const AGENT_ASSET: &str = "/api/taskflow/agents/design/asset";
const AGENT_CONTEXT: &str = "/api/taskflow/agents/design/context";

/// The component names the manifest currently lists.
fn manifest_component_names(ctx: &serde_json::Value) -> Vec<String> {
    ctx["components"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|c| c["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A token scale plus a component. The page that uses it is written by the
/// callers that need one, so "referenced" and "unreferenced" are one call
/// apart rather than two fixtures apart.
async fn seed_registry(app: &TestApp, project: i64, key: &str) {
    let res = app
        .put_as_agent(
            key,
            "/api/taskflow/agents/design/tokens",
            json!({
                "project": project,
                "css": "@theme { --bg: #fff; --fg: #000; --accent: #4f46e5; }",
                "reason": "bootstrap the scale"
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "token seed: {}", res.text());

    let res = app
        .put_as_agent(
            key,
            AGENT_COMPONENT,
            json!({
                "project": project,
                "name": "app-header",
                "js": support::sample_header_component(),
                "reason": "the settings page needs a header"
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "component seed: {}", res.text());
}

async fn write_settings_page_using_the_header(app: &TestApp, project: i64, key: &str, body: &str) {
    let res = app
        .put_as_agent(
            key,
            AGENT_PAGE,
            json!({
                "project": project,
                "route": "/settings",
                "html": format!("<app-header title=\"Settings\"></app-header>\n{body}")
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "page seed: {}", res.text());
}

/// THE assertion this feature lives or dies on.
///
/// `compose_document` emits a component's `<script src>` only while the
/// component is in the manifest, and `store::write_file` re-validates every
/// page against the registry on every write. So a page left holding a deleted
/// component's tag renders without its definition AND can never be written
/// again — rule `unknown-component`, forever. The refusal is what keeps that
/// state unreachable; the named routes are what make it actionable.
#[tokio::test(flavor = "multi_thread")]
async fn a_component_a_page_still_uses_is_refused_and_the_refusal_names_the_route() {
    let (app, project, _user, _agent, key) = setup_app().await;
    seed_registry(&app, project, key.as_str()).await;
    write_settings_page_using_the_header(&app, project, key.as_str(), "<main>hi</main>").await;

    let res = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({
                "project": project,
                "name": "app-header",
                "reason": "replaced by app-nav"
            }),
        )
        .await;
    assert_eq!(
        res.status(),
        409,
        "a component a page still uses must NOT be deletable: {}",
        res.text()
    );

    let body = res.text();
    assert!(
        body.contains("/settings"),
        "the refusal must NAME the route that uses it, so the agent knows what to edit: {body}"
    );
    assert!(
        body.contains("unknown-component"),
        "and say what a stranded page costs — the rule name is the agent's handle on it: {body}"
    );
    // The BOUND, both ways. An earlier wording said the page "can never be
    // written again", which is false — only a write that KEEPS the tag is
    // refused (`a_page_holding_a_vanished_component_is_still_writable_without_it`
    // proves it) — and it is false in the harmful direction: it points an agent
    // at deleting and recreating the page when the repair is a rewrite that
    // drops the tag.
    assert!(
        !body.contains("never be written"),
        "the refusal must not claim the page is unrecoverable: {body}"
    );
    let lower = body.to_lowercase();
    assert!(
        lower.contains("removes the tag") && lower.contains("accepted"),
        "and it must say what IS possible — a write that removes the reference is \
         accepted — or the agent's only visible repair is the destructive one: {body}"
    );

    // Both halves of "nothing was stranded": the component is still in the
    // registry, and the page is still writable.
    let read = app
        .get_as_agent(
            key.as_str(),
            &format!("{AGENT_COMPONENT}?project={project}&name=app-header"),
        )
        .await;
    assert_eq!(read.status(), 200, "the component must survive the refusal");

    let rewrite = app
        .put_as_agent(
            key.as_str(),
            AGENT_PAGE,
            json!({
                "project": project,
                "route": "/settings",
                "html": "<app-header title=\"Settings\"></app-header>\n<main>still writable</main>"
            }),
        )
        .await;
    assert_eq!(
        rewrite.status(),
        201,
        "and the page must still accept a write: {}",
        rewrite.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_component_requires_a_real_reason() {
    // Retirement is a registry-level decision, so it carries the same gate the
    // component and token writes do — enforced in the handler, not only in the
    // tool description.
    let (app, project, _user, _agent, key) = setup_app().await;
    seed_registry(&app, project, key.as_str()).await;

    let res = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({ "project": project, "name": "app-header", "reason": "nope" }),
        )
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(
        res.json()["errors"][0]["rule"],
        "missing-reason",
        "{}",
        res.text()
    );

    // Refused BEFORE anything was deleted.
    let read = app
        .get_as_agent(
            key.as_str(),
            &format!("{AGENT_COMPONENT}?project={project}&name=app-header"),
        )
        .await;
    assert_eq!(read.status(), 200, "a refused delete must not delete: {}", read.text());

    let ok = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({
                "project": project,
                "name": "app-header",
                "reason": "the settings page stopped using it"
            }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreferenced_component_deletes_and_leaves_the_manifest() {
    let (app, project, _user, _agent, key) = setup_app().await;
    seed_registry(&app, project, key.as_str()).await;

    // No page references it, so the route has nothing to protect.
    let before = app
        .get_as_agent(key.as_str(), &format!("{AGENT_CONTEXT}?project={project}"))
        .await;
    assert_eq!(manifest_component_names(&before.json()), vec!["app-header"]);

    let res = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({
                "project": project,
                "name": "app-header",
                "reason": "nothing in the registry needs it any more"
            }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["deleted"], "components/app-header.js");

    let after = app
        .get_as_agent(key.as_str(), &format!("{AGENT_CONTEXT}?project={project}"))
        .await;
    assert!(
        manifest_component_names(&after.json()).is_empty(),
        "the manifest is DERIVED from the rows, so the name must be gone: {}",
        after.text()
    );

    // And the source is gone too, not merely unlisted.
    let read = app
        .get_as_agent(
            key.as_str(),
            &format!("{AGENT_COMPONENT}?project={project}&name=app-header"),
        )
        .await;
    assert_eq!(read.status(), 404, "a deleted component reads 404: {}", read.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_component_can_be_registered_again() {
    // The retirement is reversible: the name is not reserved by a tombstone, so
    // the registry can take it back. Not a nicety — "delete it and re-register"
    // is the recovery path an agent will reach for after a mistake.
    let (app, project, _user, _agent, key) = setup_app().await;
    seed_registry(&app, project, key.as_str()).await;
    let res = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({ "project": project, "name": "app-header", "reason": "start over" }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let again = app
        .put_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            json!({
                "project": project,
                "name": "app-header",
                "js": support::sample_header_component(),
                "reason": "the retirement was a mistake"
            }),
        )
        .await;
    assert_eq!(again.status(), 201, "{}", again.text());
    assert_eq!(again.json()["file"]["version"], 1, "a fresh row starts at version 1");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_delete_another_projects_component() {
    let (app, _project, _user, _agent, key) = setup_app().await;
    let (_other_user, other_project) = app.create_member_with_project().await;
    let (_other_agent, other_key) = support::seed_agent(other_project, "Other").await;

    let seeded = app
        .put_as_agent(
            &other_key,
            AGENT_COMPONENT,
            json!({
                "project": other_project,
                "name": "app-header",
                "js": support::sample_header_component(),
                "reason": "the other project needs a header"
            }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());

    // The credential pins ONE project, and naming another one is a refusal —
    // not a routing hint, and not a silent no-op.
    let res = app
        .delete_json_as_agent(
            key.as_str(),
            AGENT_COMPONENT,
            &json!({
                "project": other_project,
                "name": "app-header",
                "reason": "not mine to delete"
            }),
        )
        .await;
    assert_eq!(res.status(), 403, "{}", res.text());

    // The row is still there: a 403 that had already deleted would read the same.
    let read = app
        .get_as_agent(
            &other_key,
            &format!("{AGENT_COMPONENT}?project={other_project}&name=app-header"),
        )
        .await;
    assert_eq!(
        read.status(),
        200,
        "the other project's component must be untouched: {}",
        read.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_asset_write_lands_and_is_served_from_the_sandbox() {
    let (app, project, _user, _agent, key) = setup_app().await;

    // A bare name is the common case and means `assets/<name>`.
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#;
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({ "project": project, "path": "logo.svg", "content": svg }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["file"]["path"], "assets/logo.svg");
    assert_eq!(res.json()["file"]["kind"], "asset");

    // A raster asset travels as text: `data:<mime>;base64,…`, decoded on serve.
    // The payload here decodes to "hello" so the served body is comparable
    // byte for byte through a lossy-UTF-8 test reader.
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({
                "project": project,
                "path": "assets/pixel.png",
                "content": "data:image/png;base64,aGVsbG8="
            }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());

    let token = taskflow_design::sandbox::mint(project);

    let served = app.get_sandbox(&format!("/s/{token}/f/assets/logo.svg")).await;
    assert_eq!(served.status(), 200, "{}", served.text());
    assert_eq!(
        served.header("content-type").as_deref(),
        Some("image/svg+xml"),
        "an asset is served with its own content type"
    );
    assert_eq!(served.text(), svg, "what was written is what is served");

    let raster = app.get_sandbox(&format!("/s/{token}/f/assets/pixel.png")).await;
    assert_eq!(raster.status(), 200, "{}", raster.text());
    assert_eq!(raster.header("content-type").as_deref(), Some("image/png"));
    assert_eq!(
        raster.text(),
        "hello",
        "the data: wrapper is DECODED on serve — the wrapper itself must not reach the browser"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_asset_route_writes_the_resources_document() {
    // `styles/` is written by design_write_tokens for the SCALE and by nothing
    // for the external resource document — the second half of this route's job.
    let (app, project, _user, _agent, key) = setup_app().await;
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_PAGE,
            json!({ "project": project, "route": "/", "html": "<main>home</main>" }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());

    let doc = json!({
        "version": 1,
        "sets": [{
            "id": "fonts",
            "name": "Fonts",
            "enabled": true,
            "links": [{ "rel": "stylesheet", "href": "https://fonts.example/inter.css" }]
        }]
    })
    .to_string();
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({ "project": project, "path": "styles/resources.json", "content": doc }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["file"]["path"], "styles/resources.json");

    // Live, not just stored: the link is in the composed document's head.
    let token = taskflow_design::sandbox::mint(project);
    let page = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(page.status(), 200);
    assert!(
        page.text().contains("https://fonts.example/inter.css"),
        "an enabled set reaches the composed head: {}",
        page.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_asset_write_outside_the_extension_set_or_over_the_cap_is_refused_by_the_shared_validator() {
    let (app, project, _user, _agent, key) = setup_app().await;

    // The extension set is the EXISTING one — `assets/` admits images only —
    // and the rule name is the existing one, so an agent reads this exactly as
    // it reads a rejection from any other design write.
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({ "project": project, "path": "notes.txt", "content": "hi" }),
        )
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(res.json()["errors"][0]["rule"], "extension", "{}", res.text());
    assert_eq!(res.json()["ok"], false);

    // The size cap is the per-file one, by the same rule name the page and
    // component writes use.
    let too_big = "a".repeat(taskflow_design::validation::MAX_FILE_BYTES + 1);
    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({ "project": project, "path": "big.svg", "content": too_big }),
        )
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(res.json()["errors"][0]["rule"], "size-cap", "{}", res.text());

    // Neither write landed.
    let ctx = app
        .get_as_agent(key.as_str(), &format!("{AGENT_CONTEXT}?project={project}"))
        .await;
    assert_eq!(ctx.status(), 200);
    let token = taskflow_design::sandbox::mint(project);
    for path in ["assets/notes.txt", "assets/big.svg"] {
        let served = app.get_sandbox(&format!("/s/{token}/f/{path}")).await;
        assert_eq!(served.status(), 404, "{path} must not exist: {}", served.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_asset_route_cannot_be_used_to_write_the_token_scale() {
    // The shared validator ACCEPTS `styles/tokens.json`, so without this
    // route's own allowlist an agent could rewrite the token scale here and
    // skip design_write_tokens' required `reason` — the gate that exists
    // because tokens touch every route at once.
    let (app, project, _user, _agent, key) = setup_app().await;

    for path in ["styles/tokens.json", "styles/tokens.css", "pages/index.html", "components/x.js"] {
        let res = app
            .put_as_agent(
                key.as_str(),
                AGENT_ASSET,
                json!({ "project": project, "path": path, "content": "{}" }),
            )
            .await;
        assert_eq!(res.status(), 422, "{path} must not be writable here: {}", res.text());
        assert_eq!(
            res.json()["errors"][0]["rule"],
            "unsupported-path",
            "{path}: {}",
            res.text()
        );
    }

    // Nothing was written, so the scale is still absent rather than replaced.
    let ctx = app
        .get_as_agent(key.as_str(), &format!("{AGENT_CONTEXT}?project={project}"))
        .await;
    let categories = &ctx.json()["tokens_json"]["categories"];
    assert!(
        categories.as_object().map(|m| m.is_empty()).unwrap_or(false),
        "the token scale must still be empty: {}",
        ctx.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_write_an_asset_into_another_projects_design() {
    let (app, _project, _user, _agent, key) = setup_app().await;
    let (_other_user, other_project) = app.create_member_with_project().await;
    let (_other_agent, other_key) = support::seed_agent(other_project, "Other").await;

    let original = "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>theirs</title></svg>";
    let seeded = app
        .put_as_agent(
            &other_key,
            AGENT_ASSET,
            json!({ "project": other_project, "path": "assets/keep.svg", "content": original }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());

    let res = app
        .put_as_agent(
            key.as_str(),
            AGENT_ASSET,
            json!({
                "project": other_project,
                "path": "assets/keep.svg",
                "content": "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>mine now</title></svg>"
            }),
        )
        .await;
    assert_eq!(res.status(), 403, "{}", res.text());

    // Untouched, read through the sandbox: the same credential that was
    // refused cannot see it, but the file is still the other project's.
    let token = taskflow_design::sandbox::mint(other_project);
    let served = app.get_sandbox(&format!("/s/{token}/f/assets/keep.svg")).await;
    assert_eq!(served.status(), 200);
    assert_eq!(
        served.text(),
        original,
        "a foreign write must not have replaced it: {}",
        served.text()
    );
}

/// The bound on the damage the refusal exists to prevent — asserted by DOING it
/// rather than by describing it.
///
/// With the component gone from the registry, a page that used it is still
/// writable, as long as the write drops the reference. Only a write that KEEPS
/// the tag is refused. So the page is stuck for edits that keep the reference,
/// not permanently — and the repair is a rewrite, not delete-and-recreate.
///
/// This is the fact the tool's refusal text and the MCP description have to
/// carry, and it is why they say it. The state is reached here by deleting at
/// the STORE level, because the route refuses to produce it — which is the
/// whole point of the route, and precisely the state an operator holding the
/// framework admin can still create.
#[tokio::test(flavor = "multi_thread")]
async fn a_page_holding_a_vanished_component_is_still_writable_without_it() {
    let (app, project, _user, _agent, key) = setup_app().await;
    seed_registry(&app, project, key.as_str()).await;
    write_settings_page_using_the_header(&app, project, key.as_str(), "<main>hi</main>").await;

    assert!(
        taskflow_design::store::delete_file(project, "components/app-header.js").await,
        "precondition: the component row was there"
    );

    // A write that KEEPS the tag is refused — this is the damage.
    let kept = app
        .put_as_agent(
            key.as_str(),
            AGENT_PAGE,
            json!({
                "project": project,
                "route": "/settings",
                "html": "<app-header title=\"Settings\"></app-header>\n<main>hi</main>"
            }),
        )
        .await;
    assert_eq!(kept.status(), 422, "{}", kept.text());
    assert_eq!(
        kept.json()["errors"][0]["rule"],
        "unknown-component",
        "{}",
        kept.text()
    );

    // A write that REMOVES it is ACCEPTED — this is the bound.
    let fixed = app
        .put_as_agent(
            key.as_str(),
            AGENT_PAGE,
            json!({
                "project": project,
                "route": "/settings",
                "html": "<main>no header any more</main>"
            }),
        )
        .await;
    assert_eq!(
        fixed.status(),
        201,
        "the page must still be writable once the reference is gone — otherwise the \
         refusal's own advice (edit the routes, then delete) would be impossible to \
         follow in the other order: {}",
        fixed.text()
    );
}
