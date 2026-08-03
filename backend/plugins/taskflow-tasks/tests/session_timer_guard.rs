//! Guardrails for the system-driven task session timer.
//!
//! The timer reconciler is allowed to create/close focused-work sessions. Direct
//! session writes from REST/UI/agents must not be able to create a second open
//! session for the same task, even if they race with a status update.

mod support;

use support::{init, seed_project, seed_task, set_status};

use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowSessionState, TaskflowTaskSession, TaskflowTaskStatus,
    taskflow_task_session,
};
use umbral::orm::ForeignKey;

async fn sessions_for(task_id: i64) -> Vec<TaskflowTaskSession> {
    let mut rows = TaskflowTaskSession::objects()
        .filter(taskflow_task_session::TASK.eq(task_id))
        .fetch()
        .await
        .expect("fetch sessions");
    rows.sort_by_key(|s| s.id);
    rows
}

async fn active_sessions(task_id: i64) -> Vec<TaskflowTaskSession> {
    sessions_for(task_id)
        .await
        .into_iter()
        .filter(|s| s.ended_at.is_none())
        .collect()
}

fn manual_running_session(project: i64, task: i64) -> TaskflowTaskSession {
    TaskflowTaskSession {
        id: 0,
        project: ForeignKey::new(project),
        task: ForeignKey::new(task),
        state: TaskflowSessionState::Running,
        actor_kind: TaskflowActorKind::User,
        actor_user: None,
        actor_agent_id: None,
        actor_label: "Manual test".to_string(),
        started_at: chrono::Utc::now(),
        ended_at: None,
        duration_seconds: None,
        summary_markdown: Some("Manual duplicate start.".to_string()),
        created_at: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_in_progress_writes_open_only_one_session() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    let mut handles = Vec::new();
    for _ in 0..8 {
        handles.push(tokio::spawn(async move {
            set_status(task, TaskflowTaskStatus::InProgress).await;
        }));
    }
    for handle in handles {
        handle.await.expect("status write task joined");
    }

    let active = active_sessions(task).await;
    assert_eq!(
        active.len(),
        1,
        "concurrent reconciles must converge to one open session"
    );
    assert_eq!(
        sessions_for(task).await.len(),
        1,
        "no duplicate history row"
    );
}

#[tokio::test]
async fn direct_second_open_session_is_rejected() {
    init().await;
    let project = seed_project().await;
    let task = seed_task(project).await;

    set_status(task, TaskflowTaskStatus::InProgress).await;
    assert_eq!(
        active_sessions(task).await.len(),
        1,
        "system session opened"
    );

    let duplicate = TaskflowTaskSession::objects()
        .create(manual_running_session(project, task))
        .await;

    assert!(
        duplicate.is_err(),
        "manual/direct writes must not create a second open session"
    );
    assert_eq!(
        active_sessions(task).await.len(),
        1,
        "failed duplicate create leaves exactly one active session"
    );
    assert_eq!(
        sessions_for(task).await.len(),
        1,
        "failed duplicate create leaves no duplicate session row"
    );
}
