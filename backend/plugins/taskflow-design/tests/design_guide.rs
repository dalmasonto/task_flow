mod support;
use support::TestApp;

async fn agent(app: &TestApp) -> (i64, String) {
    let (_user, project) = app.create_member_with_project().await;
    let (_id, key) = support::seed_agent(project, "Designer").await;
    (project, key)
}

#[tokio::test(flavor = "multi_thread")]
async fn index_lists_every_topic() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    let r = app.get_as_agent(&key, "/api/taskflow/agents/design/guide").await;
    assert_eq!(r.status(), 200);
    let text = r.json()["text"].as_str().unwrap().to_string();
    for t in ["tokens", "fonts", "flow", "primitives", "pages"] {
        assert!(text.contains(t), "index lacks {t}");
    }
    assert!(text.len() < 1200, "index must stay short: {}", text.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn each_topic_answers_with_its_essentials() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    for (topic, must) in [
        ("tokens", "bg-primary"), ("tokens", "muted-foreground"), ("tokens", "custom.radius"), ("tokens", "bg-blue-500"), ("fonts", "typography.font-sans"),
        ("fonts", "styles/resources.json"), ("flow", "design_arrange"),
        ("primitives", "ui-accordion"), ("pages", "history.back()"),
    ] {
        let r = app.get_as_agent(&key, &format!("/api/taskflow/agents/design/guide?topic={topic}")).await;
        assert_eq!(r.status(), 200, "{topic}");
        assert!(r.json()["text"].as_str().unwrap().contains(must), "{topic} lacks {must}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_topic_is_400_listing_topics() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    let r = app.get_as_agent(&key, "/api/taskflow/agents/design/guide?topic=colours").await;
    assert_eq!(r.status(), 400);
    assert_eq!(r.json()["topics"].as_array().unwrap().len(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn context_is_lean_and_points_at_the_guide() {
    let app = TestApp::new().await;
    let (project, key) = agent(&app).await;
    let ctx = app.get_as_agent(&key, &format!("/api/taskflow/agents/design/context?project={project}")).await.json();
    assert!(ctx.get("guide").is_none() && ctx.get("primitives").is_none());
    assert!(ctx["note"].as_str().unwrap().contains("design_guide"));
    assert!(ctx["defaults"].as_array().unwrap().iter().any(|n| n == "--primary"));
    assert!(ctx["tokens_css"].as_str().unwrap().contains("--color-primary: var(--primary);"));
}

#[tokio::test(flavor = "multi_thread")]
async fn operator_defaults_list_is_member_only() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let r = app.get_as(user.id, &format!("/api/design/{project}/tokens/defaults")).await;
    assert_eq!(r.status(), 200);
    assert!(r.json()["missing"]["categories"]["colors"]["background"]["light"].is_string());
    let (other, _) = app.create_member_with_project().await;
    assert_eq!(app.get_as(other.id, &format!("/api/design/{project}/tokens/defaults")).await.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn guide_requires_an_agent_key() {
    let app = TestApp::new().await;
    let r = app.get_sandbox("/api/taskflow/agents/design/guide").await;
    assert_eq!(r.status(), 401);
}
