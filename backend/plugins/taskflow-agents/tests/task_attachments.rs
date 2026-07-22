//! Task attachments (#31): a human attaches files to a task via multipart, and
//! the agent's task read surfaces them (with resolved /media urls) so it can
//! pull them with download_attachment. Drives the real `parse_multipart` path.

mod support;
use serde_json::{Value, json};
use support::{
    MultipartPart, TestApp, encode_multipart, make_active_project_member, seed_project,
};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};

const IMAGE_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 9, 8, 7];

fn file(name: &str, filename: &str, content_type: &str, bytes: &[u8]) -> MultipartPart {
    MultipartPart {
        field_name: name.to_string(),
        filename: Some(filename.to_string()),
        content_type: Some(content_type.to_string()),
        bytes: bytes.to_vec(),
    }
}

/// Seed a task in `project`, returning its id.
async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: umbral::orm::ForeignKey::new(project),
            title: "Attachment task".to_string(),
            description_markdown: "look at the image".to_string(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            operator_user: None,
            operator_agent_id: None,
            created_by_agent_id: None,
            assignee_label: None,
            due_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// Mint an agent key for `(project, user)`.
async fn mint_agent(app: &TestApp, user: i64, project: i64) -> String {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["key"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn upload_creates_a_task_attachment_and_returns_a_url() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let task = seed_task(project).await;

    let (content_type, body) = encode_multipart(&[file("files", "diagram.png", "image/png", IMAGE_BYTES)]);
    let response = app
        .post_multipart_as(user, &format!("/api/taskflow/tasks/{task}/attachments"), &content_type, body)
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let attachments = response.json().await["attachments"].as_array().cloned().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    let att = &attachments[0];
    assert_eq!(att["name"], json!("diagram.png"));
    assert_eq!(att["content_type"], json!("image/png"));
    assert_eq!(att["size_bytes"], json!(IMAGE_BYTES.len()));
    assert_eq!(att["task"], json!(task));
    assert_eq!(att["project"], json!(project));
    assert!(att["url"].as_str().expect("url").starts_with("/media/"));
}

#[tokio::test]
async fn a_non_member_cannot_attach_to_a_task() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let outsider = app.create_user().await; // never made a member
    let task = seed_task(project).await;

    let (content_type, body) = encode_multipart(&[file("files", "x.png", "image/png", IMAGE_BYTES)]);
    let response = app
        .post_multipart_as(outsider, &format!("/api/taskflow/tasks/{task}/attachments"), &content_type, body)
        .await;

    assert_eq!(response.status(), 403, "a non-member must be forbidden");
}

#[tokio::test]
async fn the_agent_task_read_surfaces_the_attachment() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let task = seed_task(project).await;
    let key = mint_agent(&app, user, project).await;

    let (content_type, body) = encode_multipart(&[file("files", "shot.png", "image/png", IMAGE_BYTES)]);
    app.post_multipart_as(user, &format!("/api/taskflow/tasks/{task}/attachments"), &content_type, body)
        .await;

    let response = app.get_as_agent(&key, "/api/taskflow/agents/tasks").await;
    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let tasks: Vec<Value> = response.json().await.as_array().cloned().expect("tasks array");
    let row = tasks.iter().find(|t| t["id"] == json!(task)).expect("the task");
    let attachments = row["attachments"].as_array().expect("attachments array on the task");
    assert_eq!(attachments.len(), 1, "the agent sees the task's attachment");
    assert_eq!(attachments[0]["name"], json!("shot.png"));
    assert!(attachments[0]["url"].as_str().expect("url").starts_with("/media/"));
}
