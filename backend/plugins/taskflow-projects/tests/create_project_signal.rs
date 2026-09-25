//! Creating a project through the API announces the row on the ORM's
//! `post_save:taskflow_project` signal.
//!
//! This is the one write path the ORM does NOT announce for us. `create_project`
//! creates the project through `QuerySetTx::create` inside an explicit
//! `umbral::transaction`, and that terminal emits nothing — no `post_save`, no
//! `bulk_post_save` — so without the `umbral::signals::emit` in the handler, every
//! subscriber on `post_save:taskflow_project` is blind to the only way this app
//! creates a project. The agents plugin subscribes to it to guarantee that a new
//! project has its public and design rooms.
//!
//! The probe reads the row BACK by id, which is also what pins the ordering: the
//! emit must run after the transaction returns, never inside the closure, or a
//! subscriber that writes (the agents plugin's does) would run against a database
//! that cannot see the project yet.

mod support;

use std::sync::Mutex;

use serde_json::{Value, json};
use support::TestApp;
use taskflow_projects::models::{TaskflowProject, taskflow_project};

/// One observed event: the payload's `instance`, its `created` flag, and whether
/// the row the payload names was READABLE when the probe ran.
#[derive(Debug, Clone)]
struct Seen {
    instance: Value,
    created: bool,
    readable_rows: i64,
}

/// The probe's observations, process-wide: `subscribe_async` registers a global
/// handler and cannot be un-registered, so the test filters by slug instead.
fn seen() -> &'static Mutex<Vec<Seen>> {
    static SEEN: std::sync::OnceLock<Mutex<Vec<Seen>>> = std::sync::OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(Vec::new()))
}

fn install_probe() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        umbral::signals::subscribe_async("post_save:taskflow_project", |payload: &Value| {
            let instance = payload["instance"].clone();
            let created = payload["created"].as_bool().unwrap_or(false);
            async move {
                let id = instance["id"].as_i64();
                // The read is the point: an emit fired inside the transaction
                // would find nothing here, because this runs on a pooled
                // connection that cannot see an uncommitted row.
                let readable_rows = match id {
                    Some(id) => TaskflowProject::objects()
                        .filter(taskflow_project::ID.eq(id))
                        .fetch()
                        .await
                        .map(|rows| rows.len() as i64)
                        .unwrap_or(-1),
                    None => -1,
                };
                seen()
                    .lock()
                    .expect("probe log")
                    .push(Seen {
                        instance,
                        created,
                        readable_rows,
                    });
            }
        });
    });
}

/// The events this test's project produced (matched by slug, since the probe is
/// process-wide and other tests create projects too).
fn events_for(slug: &str) -> Vec<Seen> {
    seen()
        .lock()
        .expect("probe log")
        .iter()
        .filter(|s| s.instance["slug"] == json!(slug))
        .cloned()
        .collect()
}

#[tokio::test]
async fn create_project_announces_the_row_after_the_transaction_commits() {
    let app = TestApp::new().await;
    install_probe();
    let user = app.create_user().await;

    let slug = format!("signal-probe-{}", umbral_testing::seq());
    let response = app
        .post_body_as(
            user.id,
            "/api/taskflow/projects",
            json!({ "name": "Signal Probe", "slug": slug }),
        )
        .await;
    assert_eq!(response.status(), 201, "body: {:?}", response.json());
    let project_id = response.json()["id"].as_i64().expect("project id");

    let events = events_for(&slug);
    assert_eq!(
        events.len(),
        1,
        "creating a project must announce it exactly once on post_save:taskflow_project, saw {events:?}"
    );
    let event = &events[0];
    assert!(
        event.created,
        "the announcement carries created = true (this is an INSERT)"
    );
    // The payload IS the row, which is what every other post_save subscriber on
    // this table (and the agents plugin's room invariant) reads.
    assert_eq!(event.instance["id"].as_i64(), Some(project_id));
    assert_eq!(event.instance["name"], json!("Signal Probe"));
    assert_eq!(event.instance["status"], json!("active"));
    // And it was committed when the subscriber ran.
    assert_eq!(
        event.readable_rows, 1,
        "the subscriber must be able to READ the row it was told about: the emit has to run \
         after the transaction returns, never inside the closure"
    );
}
