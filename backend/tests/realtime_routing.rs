//! Regression test for the root-cause bug: a message event must not reach a
//! subscriber watching tasks. Before per-table groups, all 13 project-scoped
//! models shared `project:{id}` and every client handler fired on every event.

use serde_json::json;

#[test]
fn message_and_task_route_to_different_groups() {
    let message_group = backend::realtime::group_for("messages", &json!({"project": 7}));
    let task_group = backend::realtime::group_for("tasks", &json!({"project": 7}));

    assert_eq!(message_group, "project:7:messages");
    assert_eq!(task_group, "project:7:tasks");
    assert_ne!(message_group, task_group);
}

#[test]
fn accepts_the_fk_shapes_the_orm_actually_emits() {
    // project arrives as a bare number, a string, or {id: N} depending on
    // serialization — value_to_group_id already handles all three.
    assert_eq!(
        backend::realtime::group_for("messages", &json!({"project": 7})),
        "project:7:messages"
    );
    assert_eq!(
        backend::realtime::group_for("messages", &json!({"project": "7"})),
        "project:7:messages"
    );
    assert_eq!(
        backend::realtime::group_for("messages", &json!({"project": {"id": 7}})),
        "project:7:messages"
    );
}

#[test]
fn falls_back_to_the_projects_group_when_project_is_missing() {
    assert_eq!(
        backend::realtime::group_for("messages", &json!({})),
        "taskflow:projects"
    );
}

#[test]
fn group_policy_accepts_per_table_groups_and_presence() {
    assert!(backend::realtime::can_join_group("project:7:messages"));
    assert!(backend::realtime::can_join_group("project:7:presence"));
    assert!(backend::realtime::can_join_group("taskflow:projects"));
    assert!(!backend::realtime::can_join_group("project:"));
    assert!(!backend::realtime::can_join_group("nonsense"));
    // The global agents group is retired — it was a cross-tenant fanout.
    assert!(!backend::realtime::can_join_group("taskflow:agents"));
}

// --- Tests beyond the brief -------------------------------------------------
//
// The brief's four tests pin the happy path. These pin the two properties a
// reviewer would reverse to check the tests actually discriminate: that the
// suffix set is closed (a bare `project:` prefix check would admit anything),
// and that every model gets a *distinct* group (the whole point of the fix).

#[test]
fn rejects_groups_whose_suffix_is_not_a_known_label() {
    // A policy that merely checked the `project:` prefix would admit all of
    // these. The suffix must come from the contract's list.
    assert!(!backend::realtime::can_join_group("project:7:bogus"));
    assert!(!backend::realtime::can_join_group("project:7"));
    assert!(!backend::realtime::can_join_group("project:7:"));
    assert!(!backend::realtime::can_join_group("project::messages"));
    // Suffixes are short labels, not table names. If someone "helpfully"
    // switched the map to table names, Task 6's builder would silently
    // disagree — so the table-name form must be rejected.
    assert!(!backend::realtime::can_join_group(
        "project:7:taskflow_agent_message"
    ));
    assert!(!backend::realtime::can_join_group("project:7:taskflow_task"));
}

#[test]
fn every_exposed_suffix_yields_its_own_group() {
    // The bug in one assertion: 14 suffixes must produce 14 distinct groups
    // within a single project. If `group_for` ignored `suffix` (as the old
    // `project_group` did), this collapses to 1.
    let suffixes = [
        "messages",
        "channels",
        "channel_members",
        "tasks",
        "task_relations",
        "task_activity",
        "task_sessions",
        "agents",
        "agent_sessions",
        "agent_credentials",
        "terminal_frames",
        "project_members",
        "project_invites",
        "api_endpoints",
    ];

    let groups: std::collections::BTreeSet<String> = suffixes
        .iter()
        .map(|s| backend::realtime::group_for(s, &json!({"project": 7})))
        .collect();

    assert_eq!(groups.len(), suffixes.len(), "groups collided: {groups:?}");
    // And each one is joinable — the policy and the router agree on the map.
    for group in &groups {
        assert!(
            backend::realtime::can_join_group(group),
            "policy rejects a group the router emits: {group}"
        );
    }
}

#[test]
fn different_projects_stay_separate() {
    assert_ne!(
        backend::realtime::group_for("messages", &json!({"project": 7})),
        backend::realtime::group_for("messages", &json!({"project": 8}))
    );
}
