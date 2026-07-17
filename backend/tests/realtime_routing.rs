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

// --- Cross-language contract: FE suffix map vs. BE ALL_SUFFIXES ------------
//
// `backend/src/realtime.rs` and `v2_fe/src/lib/taskflow-api.ts` each hardcode
// the same list of group suffixes. A typo on the frontend side (e.g.
// "task_sessions" -> "task_sessons") compiles cleanly — TypeScript's
// `satisfies` guard only catches a *missing* key, never a wrong string value
// — and then fails silently at runtime: the SSE subscription opens and the
// group simply never fires, because `can_join_group` rejects the mistyped
// group before it ever reaches the handler. `can_join_group` was extracted
// specifically to be testable without a running server (see its doc comment
// in realtime.rs), so we drive it directly with every suffix the frontend
// actually emits.

/// Number of project-scoped suffixes in the contract (excludes `presence`,
/// which is not part of the frontend's `realtimeGroupSuffixes` map — it is
/// built by `taskflowGroups.presence` instead).
const EXPECTED_PROJECT_SUFFIX_COUNT: usize = 14;

/// Pull the string literal values out of the `realtimeGroupSuffixes` map in
/// `v2_fe/src/lib/taskflow-api.ts`. Deliberately not a TypeScript parser:
/// every entry in that map is a single line shaped like
/// `[taskflowTables.xxx]: "suffix",`, so a line-oriented scan for the value
/// after the first `:` is simple, robust to reordering, and doesn't need a
/// TS toolchain in the test binary.
fn extract_frontend_group_suffixes(ts_source: &str) -> Vec<String> {
    const START_MARKER: &str = "const realtimeGroupSuffixes = {";

    let start = ts_source.find(START_MARKER).unwrap_or_else(|| {
        panic!(
            "could not find `{START_MARKER}` in v2_fe/src/lib/taskflow-api.ts. \
             The frontend renamed or restructured the realtime group suffix map. \
             This test enforces a cross-language contract between \
             backend/src/realtime.rs (ALL_SUFFIXES / the suffix constants) and \
             v2_fe/src/lib/taskflow-api.ts (realtimeGroupSuffixes) — group names \
             are never checked by the compiler on either side, so if the map \
             moved or was renamed, update START_MARKER in this test \
             (backend/tests/realtime_routing.rs) to match."
        )
    }) + START_MARKER.len();

    let body = &ts_source[start..];
    let end = body.find('}').unwrap_or_else(|| {
        panic!("could not find the closing `}}` of realtimeGroupSuffixes in taskflow-api.ts")
    });

    body[..end]
        .lines()
        .filter_map(|line| {
            let (_key, value) = line.trim().split_once(':')?;
            let after_open_quote = &value[value.find('"')? + 1..];
            let close_quote = after_open_quote.find('"')?;
            Some(after_open_quote[..close_quote].to_string())
        })
        .collect()
}

#[test]
fn frontend_group_suffixes_match_backend_contract() {
    let ts_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("v2_fe/src/lib/taskflow-api.ts");

    let ts_source = std::fs::read_to_string(&ts_path).unwrap_or_else(|err| {
        panic!(
            "could not read {} ({err}). This test asserts a cross-language contract \
             between backend/src/realtime.rs (ALL_SUFFIXES) and \
             v2_fe/src/lib/taskflow-api.ts (realtimeGroupSuffixes) — it must be able \
             to read the frontend file to verify the frontend's suffix strings are \
             all members of the backend's closed suffix set. If the frontend file \
             moved, update the path in backend/tests/realtime_routing.rs; do not \
             delete this test, since a missing file must fail loudly, not pass \
             vacuously.",
            ts_path.display()
        )
    });

    let suffixes = extract_frontend_group_suffixes(&ts_source);

    for suffix in &suffixes {
        let group = format!("project:1:{suffix}");
        assert!(
            backend::realtime::can_join_group(&group),
            "frontend suffix {suffix:?} (from v2_fe/src/lib/taskflow-api.ts's \
             realtimeGroupSuffixes map) is not accepted by \
             backend::realtime::can_join_group — it does not appear in \
             backend/src/realtime.rs's ALL_SUFFIXES. The suffix string is a \
             cross-language contract between the two files: it must be typed \
             identically on both sides (a typo compiles fine on the frontend \
             but the resulting group never joins, so the SSE subscription \
             opens and silently never fires). Fix the typo/drift in whichever \
             of backend/src/realtime.rs or v2_fe/src/lib/taskflow-api.ts is wrong."
        );
    }

    assert_eq!(
        suffixes.len(),
        EXPECTED_PROJECT_SUFFIX_COUNT,
        "expected {EXPECTED_PROJECT_SUFFIX_COUNT} project-scoped suffixes in \
         v2_fe/src/lib/taskflow-api.ts's realtimeGroupSuffixes map but found {}. \
         An entry was silently added or dropped on the frontend relative to \
         backend/src/realtime.rs's ALL_SUFFIXES. Update whichever of the two \
         files is out of sync, and if the contract's suffix count genuinely \
         changed, update EXPECTED_PROJECT_SUFFIX_COUNT in \
         backend/tests/realtime_routing.rs to match.",
        suffixes.len()
    );
}
