//! A deleted design file must not land on `taskflow:projects`.
//!
//! `backend/src/realtime.rs` routes `DesignFile` to `project:{id}:design_files`
//! with a group derived from the row's `project` COLUMN, and the ORM's delete
//! signal cannot supply it: `QuerySet::delete` emits its per-row `post_delete`
//! with the primary key alone — `{ "instance": { "id": N } }`, deliberately,
//! because the row is gone and a pre-image SELECT per delete was not worth it.
//! `group_for` therefore finds no `project` and takes its `PROJECTS_GROUP`
//! fallback, so the event was delivered to `taskflow:projects` and to nobody
//! else.
//!
//! That group is not inert. The frontend maps it to `taskflowTables.projects`,
//! whose handler is `setWorkspaceProjects(current => current.filter(p => p.id
//! !== String(rowId)))` and, when the id matches, `setLiveWorkspace(null)`.
//! `design_file.id` and `taskflow_project.id` are independent sequences over the
//! same small integers, so this was a coin-toss at removing an unrelated project
//! from the sidebar and blanking the open workspace — and `taskflow:projects` is
//! joinable by any authenticated user.
//!
//! The fix has two halves and this test covers the one that lives in the
//! backend: the `DesignFile` registration drops `ModelAction::Deleted`, so the
//! misrouted event is never sent. The other half — the deleting handler sending
//! the CORRECT event on the files group — is asserted in the design plugin's own
//! suite, `tests/realtime_bulk_bridge.rs`, because it needs the agent route.
//!
//! Both halves are load-bearing, which is why the positive control below is not
//! decoration: dropping the action would also "pass" if the registration had
//! been deleted outright, so a CREATE is asserted to still arrive.

use std::collections::HashSet;
use std::time::Duration;

use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_realtime::{Event, Realtime};
use umbral_testing::boot;

use taskflow_design::models::{DesignFile, DesignFileKind};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

/// The project-level group every authenticated user may join.
const PROJECTS_GROUP: &str = "taskflow:projects";

async fn make_user(username: &str) -> i64 {
    AuthUser::objects()
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
        .expect("create AuthUser")
        .id
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
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_member(project: i64, user: i64) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

async fn seed_component(project: i64, name: &str) -> DesignFile {
    DesignFile::objects()
        .create(DesignFile {
            id: 0,
            project: ForeignKey::new(project),
            kind: DesignFileKind::Component,
            path: format!("components/{name}.js"),
            content: format!(
                "customElements.define('{name}', class extends HTMLElement {{}});"
            ),
            version: 1,
            updated_by: "test".to_string(),
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("seed design file")
}

fn drain(rx: &mut tokio::sync::mpsc::Receiver<Event>) -> Vec<(String, String, serde_json::Value)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push((ev.channel, ev.event, ev.data));
    }
    out
}

/// Boot with the PRODUCTION realtime spec — `backend::realtime::plugin()`, which
/// is what carries the `Expose` registrations under test. The design plugin's
/// own harness cannot do this (it does not depend on the backend binary), so the
/// routing bug is only visible from here.
async fn boot_app() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            // The agents plugin's attachment model declares a FileField, so the
            // app will not build without a storage backend.
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(TaskflowProjectsPlugin)
            .plugin(taskflow_tasks::TaskflowTasksPlugin)
            .plugin(taskflow_agents::TaskflowAgentsPlugin)
            .plugin(taskflow_design::TaskflowDesignPlugin::default())
            .plugin(backend::realtime::plugin())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_design_file_reaches_its_project_and_not_the_projects_group() {
    boot_app().await;

    let user = make_user("design-delete-routing").await;
    let project = make_project("design-delete-routing").await;
    make_member(project, user).await;

    let files_group = format!("project:{project}:design_files");
    let mut files_rx = Realtime::registry()
        .register(
            Some(user.to_string()),
            HashSet::from([files_group.clone()]),
            32,
        )
        .await
        .expect("register the project's design_files watcher")
        .1;
    let mut projects_rx = Realtime::registry()
        .register(
            Some(user.to_string()),
            HashSet::from([PROJECTS_GROUP.to_string()]),
            32,
        )
        .await
        .expect("register the projects watcher")
        .1;

    // POSITIVE CONTROL — a create still routes by the row's project. Without
    // this, dropping the whole `DesignFile` registration would satisfy every
    // "nothing on taskflow:projects" assertion below.
    let kept = seed_component(project, "app-nav").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let created = drain(&mut files_rx);
    assert_eq!(
        created,
        vec![(
            files_group.clone(),
            "created".to_string(),
            serde_json::json!({ "id": kept.id })
        )],
        "a create must still arrive on the project's own group"
    );
    assert!(
        drain(&mut projects_rx).is_empty(),
        "and it must not also reach the projects group"
    );

    // THE ASSERTION. `store::delete_file` is the real delete under the agent
    // route; `Queryset::delete`'s bare payload is what used to send this to
    // `taskflow:projects`.
    let doomed = seed_component(project, "app-header").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Clear the create's own event, so the drains below see the delete alone
    // rather than a `created` left over from the seed.
    assert_eq!(
        drain(&mut files_rx).len(),
        1,
        "precondition: the second seed broadcast its create"
    );

    assert!(
        taskflow_design::store::delete_file(project, &doomed.path).await,
        "precondition: the row was there to delete"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        drain(&mut projects_rx).is_empty(),
        "a deleted design file must NOT reach {PROJECTS_GROUP}: that group's frontend handler \
         filters the sidebar by id, and a design_file id is not a project id"
    );
    // And the design group is empty too, which is the OTHER half: `Expose` no
    // longer speaks for deletes at all, so the handler owns the event. Asserted
    // here so a future re-add of the action cannot pass silently by double
    // delivery — `realtime_bulk_bridge.rs` asserts the handler's own emission.
    assert!(
        drain(&mut files_rx).is_empty(),
        "the backend's Expose registration must send nothing for a delete; the deleting \
         handler is what emits, on this same group"
    );
}
