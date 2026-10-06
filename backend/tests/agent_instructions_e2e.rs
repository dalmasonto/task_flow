//! #615/#616 end to end: the project PUT lives in `taskflow-projects` and the
//! agent `whoami`/instructions PUT in `taskflow-agents`, so no single plugin
//! harness can see both. Here both plugins are booted in one app.

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot};

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus, taskflow_project,
};

async fn make_user(username: &str) -> (i64, String) {
    let user = AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.to_string(),
            email: format!("{username}@example.test"),
            password_hash: "x".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser: false,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser");
    let (_, plaintext) = AuthToken::create_for(&user, "test").await.expect("mint token");
    (user.id, plaintext.0)
}

async fn make_project(slug: &str) -> i64 {
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: slug.to_string(),
            slug: slug.to_string(),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            github_auto_mirror: false,
            agent_instructions_markdown: None,
            agent_instructions_updated_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_member(project: i64, user: i64, role: TaskflowProjectRole) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

fn hdr(v: String) -> HeaderValue {
    HeaderValue::from_str(&v).expect("header")
}

async fn stored(project: i64) -> TaskflowProject {
    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .expect("load")
        .expect("exists")
}

/// Both plugins booted once; the tests below share the process-wide app.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_key_cannot_write_project_instructions_and_whoami_shows_both_blocks() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(TaskflowProjectsPlugin)
            .plugin(taskflow_tasks::TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            .plugin(backend::realtime::plugin())
    })
    .await;

    let (owner, owner_token) = make_user("e2e-owner").await;
    let (dev, dev_token) = make_user("e2e-dev").await;
    let project = make_project("e2e-instructions").await;
    make_member(project, owner, TaskflowProjectRole::Owner).await;
    make_member(project, dev, TaskflowProjectRole::Developer).await;

    let client = TestClient::new(
        taskflow_agents::urls::router().merge(taskflow_projects::urls::router()),
    );
    let project_path = format!("/api/taskflow/projects/{project}/agent-instructions");

    // A developer links an agent (and is its linker).
    client.set_default_header(AUTHORIZATION, hdr(format!("Bearer {dev_token}")));
    let link = client
        .post_json(
            "/api/taskflow/agents/link",
            &json!({ "project": project, "display_name": "claude", "profile": "main" }),
        )
        .await;
    assert_eq!(link.status(), 200, "link failed");
    let linked: Value = link.body_json();
    let key = linked["key"].as_str().expect("key").to_string();
    let agent = linked["agent_id"].as_i64().expect("agent_id");

    // (a) an agent key is not a human identity: the project PUT is 401.
    client.set_default_header(AUTHORIZATION, hdr(format!("Agent {key}")));
    let denied = client.put_json(&project_path, &json!({ "markdown": "agent was here" })).await;
    assert_eq!(denied.status(), 401);
    assert_eq!(stored(project).await.agent_instructions_markdown, None);

    // (b) the owner sets the project block; the linker sets the agent's block.
    client.set_default_header(AUTHORIZATION, hdr(format!("Bearer {owner_token}")));
    let set = client.put_json(&project_path, &json!({ "markdown": "## House rules\nUse pnpm." })).await;
    assert_eq!(set.status(), 200);

    client.set_default_header(AUTHORIZATION, hdr(format!("Bearer {dev_token}")));
    let role = client
        .put_json(
            &format!("/api/taskflow/agents/{agent}/instructions"),
            &json!({ "markdown": "You are the reviewer." }),
        )
        .await;
    assert_eq!(role.status(), 200);

    client.set_default_header(AUTHORIZATION, hdr(format!("Agent {key}")));
    let me = client.get("/api/taskflow/agents/whoami").await;
    assert_eq!(me.status(), 200);
    let me: Value = me.body_json();
    assert_eq!(me["project_instructions"]["markdown"], json!("## House rules\nUse pnpm."));
    assert!(me["project_instructions"]["updated_at"].is_string());
    assert_eq!(me["instructions"]["markdown"], json!("You are the reviewer."));
    assert!(me["instructions"]["updated_at"].is_string());
}
