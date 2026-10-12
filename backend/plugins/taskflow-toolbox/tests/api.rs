//! #617: the Toolbox's HTTP surface — the acceptance list from the task, as
//! tests.
//!
//! The two things that matter most here are negative: a listing NEVER carries
//! code (acceptance 6), and a save carrying a secret is REFUSED (acceptance
//! 3). Around them: save/version/rollback (acceptance 4), the version gate
//! (two agents cannot silently overwrite each other), redaction with its
//! report on every save, `dry_run` writing nothing, and the human-only
//! approval.

mod support;
use serde_json::json;
use support::{TestApp, seed_member, seed_project};

const SCRIPT: &str = "#!/usr/bin/env bash\nset -euo pipefail\necho \"$SERVER_HOST\"\n";

#[tokio::test(flavor = "multi_thread")]
async fn a_script_is_saved_listed_without_its_code_and_read_back() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;

    let saved = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/prod-report"),
            json!({
                "kind": "script",
                "title": "Production report",
                "description": "Use when asked for a production health report.",
                "body_markdown": "Reads df and the last boot errors. Run from the repo root.",
                "code": SCRIPT,
                "language": "bash",
                "entrypoint": "report.sh",
                "requires_env": ["SERVER_HOST", "USER_AT_HOST"],
                "tags": ["ops", "report"],
                "params": [{ "name": "since", "description": "journalctl window", "required": false }],
            }),
        )
        .await;
    assert_eq!(saved.status(), 200, "{}", saved.text());
    let body = saved.json().await;
    assert_eq!(body["entry"]["version"], 1);
    assert_eq!(body["entry"]["status"], "draft", "a script starts unapproved");
    assert_eq!(body["redactions"], json!([]), "nothing to redact in a clean script");

    // The listing: everything an index needs, and NOT the code or the body.
    let listed = app.get_as(user.id, &format!("/api/taskflow/toolbox/{project}")).await;
    assert_eq!(listed.status(), 200, "{}", listed.text());
    let listed = listed.json().await;
    let entry = &listed["entries"][0];
    assert_eq!(entry["name"], "prod-report");
    assert_eq!(entry["requires_env"], json!(["SERVER_HOST", "USER_AT_HOST"]));
    assert_eq!(entry["tags"], json!(["ops", "report"]));
    assert!(entry.get("code").is_none(), "a listing must never carry code: {entry}");
    assert!(entry.get("body_markdown").is_none(), "{entry}");

    // The full read is a separate, deliberate call.
    let full = app
        .get_as(user.id, &format!("/api/taskflow/toolbox/{project}/entry/prod-report"))
        .await
        .json().await;
    assert_eq!(full["code"], SCRIPT);
    assert_eq!(full["entrypoint"], "report.sh");
    assert_eq!(full["params"][0]["name"], "since");

    // Filtering, for the page's tabs and search box.
    let scripts = app
        .get_as(user.id, &format!("/api/taskflow/toolbox/{project}?kind=script&tag=ops&query=report"))
        .await
        .json().await;
    assert_eq!(scripts["entries"].as_array().unwrap().len(), 1, "{scripts}");
    let none = app
        .get_as(user.id, &format!("/api/taskflow/toolbox/{project}?kind=memory&tag=ops"))
        .await
        .json().await;
    assert_eq!(none["entries"].as_array().unwrap().len(), 0, "{none}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_save_with_a_secret_is_refused_and_stores_nothing() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;

    let with_token = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/leaky"),
            json!({
                "kind": "script",
                "title": "Leaky",
                "description": "sends a report",
                "code": "curl -H \"Authorization: token ghp_abcdefghijklmnopqrstuvwxyz01\" https://api.github.com\n",
                "requires_env": [],
            }),
        )
        .await;
    assert_eq!(with_token.status(), 400, "{}", with_token.text());
    let refusal = with_token.json().await;
    assert_eq!(refusal["error"], "secret_detected");
    assert_eq!(refusal["findings"][0]["rule"], "github_token");
    assert!(
        !with_token.text().contains("ghp_abcdefghijklmnopqrstuvwxyz01"),
        "the value itself must not be echoed back"
    );

    let with_key = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/leaky"),
            json!({
                "kind": "script",
                "title": "Leaky",
                "description": "d",
                "code": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
                "requires_env": [],
            }),
        )
        .await;
    assert_eq!(with_key.status(), 400, "{}", with_key.text());

    // Nothing was stored by either refusal.
    let listed = app.get_as(user.id, &format!("/api/taskflow/toolbox/{project}")).await.json().await;
    assert_eq!(listed["entries"].as_array().unwrap().len(), 0, "{listed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn identifiers_are_redacted_with_a_report_and_dry_run_writes_nothing() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;

    let source = "#!/usr/bin/env bash\nssh ops@mycorp.io \"df -h\" # host 203.0.114.9\n";
    let dry = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/report"),
            json!({ "kind": "script", "title": "Report", "description": "d", "code": source, "dry_run": true }),
        )
        .await;
    assert_eq!(dry.status(), 200, "{}", dry.text());
    let dry = dry.json().await;
    assert_eq!(dry["dry_run"], true);
    assert_eq!(dry["redactions"].as_array().unwrap().len(), 2, "{dry}");
    let kinds: Vec<&str> = dry["redactions"].as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["email", "ipv4"], "{dry}");
    assert!(dry["entry"]["code"].as_str().unwrap().contains("user@example.com"), "{dry}");
    let listed = app.get_as(user.id, &format!("/api/taskflow/toolbox/{project}")).await.json().await;
    assert_eq!(listed["entries"].as_array().unwrap().len(), 0, "dry_run stored an entry: {listed}");

    // The real save redacts the same way and reports what it replaced.
    let saved = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/report"),
            json!({ "kind": "script", "title": "Report", "description": "d", "code": source, "requires_env": ["SERVER_HOST"] }),
        )
        .await;
    assert_eq!(saved.status(), 200, "{}", saved.text());
    let saved = saved.json().await;
    assert_eq!(saved["entry"]["version"], 1);
    assert!(saved["entry"]["code"].as_str().unwrap().contains("user@example.com"), "{saved}");
    assert!(saved["entry"]["code"].as_str().unwrap().contains("xxx.xxx.xx.xx"), "{saved}");
    assert!(!saved["entry"]["code"].as_str().unwrap().contains("mycorp.io"), "{saved}");
}

#[tokio::test(flavor = "multi_thread")]
async fn versions_keep_the_history_and_a_rollback_is_a_new_version() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    let url = format!("/api/taskflow/toolbox/{project}/entry/report");

    let save = |code: &str, base: serde_json::Value, note: &str| {
        let app = &app;
        let url = url.clone();
        let code = code.to_string();
        let note = note.to_string();
        async move {
            app.post_json_as(
                user.id,
                &url,
                json!({ "kind": "script", "title": "Report", "description": "d", "code": code, "base_version": base, "note": note }),
            )
            .await
        }
    };

    assert_eq!(save("echo one\n", json!(null), "first").await.status(), 200);
    let v2 = save("echo two\n", json!(1), "the fix").await;
    assert_eq!(v2.status(), 200, "{}", v2.text());
    assert_eq!(v2.json().await["entry"]["version"], 2);

    // A stale base_version is a 409 that names the current one, so a second
    // writer cannot silently clobber the first.
    let stale = save("echo third\n", json!(1), "racing").await;
    assert_eq!(stale.status(), 409, "{}", stale.text());
    assert_eq!(stale.json().await["current_version"], 2);
    // And an update with no base_version at all is refused: editing blind is
    // how two agents lose each other's work.
    let blind = save("echo blind\n", json!(null), "blind").await;
    assert_eq!(blind.status(), 400, "{}", blind.text());

    // The history holds version 1 with its code.
    let versions = app.get_as(user.id, &format!("{url}/versions")).await.json().await;
    assert_eq!(versions["current_version"], 2);
    assert_eq!(versions["versions"][0]["version"], 1);
    assert_eq!(versions["versions"][0]["note"], "the fix", "the note describes what REPLACED this version");
    let v1 = app.get_as(user.id, &format!("{url}/versions/1")).await.json().await;
    assert_eq!(v1["code"], "echo one\n");
    assert_eq!(v1["current"], false);

    // The CURRENT version answers too, from the entry row — the update flow is
    // `diff(installed, current)`, and a 404 on "current" would break it.
    let current = app.get_as(user.id, &format!("{url}/versions/2")).await;
    assert_eq!(current.status(), 200, "{}", current.text());
    let current = current.json().await;
    assert_eq!(current["code"], "echo two\n");
    assert_eq!(current["current"], true);

    // Restoring is a new version, so the history stays append-only.
    let restored = app
        .post_json_as(user.id, &format!("{url}/versions/restore"), json!({ "version": 1 }))
        .await;
    assert_eq!(restored.status(), 200, "{}", restored.text());
    let restored = restored.json().await;
    assert_eq!(restored["entry"]["version"], 3);
    assert_eq!(restored["entry"]["code"], "echo one\n");
    assert_eq!(restored["entry"]["status"], "draft", "a rollback re-opens the human gate");
}

#[tokio::test(flavor = "multi_thread")]
async fn approval_is_a_human_action_and_memories_arrive_approved() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    let script_url = format!("/api/taskflow/toolbox/{project}/entry/report");
    let memory_url = format!("/api/taskflow/toolbox/{project}/entry/gotcha");

    let script = app
        .post_json_as(user.id, &script_url, json!({ "kind": "script", "title": "R", "description": "d", "code": "echo hi\n" }))
        .await
        .json().await;
    assert_eq!(script["entry"]["status"], "draft");

    let memory = app
        .post_json_as(
            user.id,
            &memory_url,
            json!({ "kind": "memory", "title": "Deploy gotcha", "description": "Read before deploying.", "body_markdown": "The box is shared; never restart Caddy." }),
        )
        .await;
    assert_eq!(memory.status(), 200, "{}", memory.text());
    assert_eq!(memory.json().await["entry"]["status"], "approved", "a memory has nothing to execute");

    // Approve the script.
    let approved = app
        .post_json_as(user.id, &format!("{script_url}/status"), json!({ "status": "approved" }))
        .await;
    assert_eq!(approved.status(), 200, "{}", approved.text());
    assert_eq!(approved.json().await["entry"]["status"], "approved");

    // Editing the code re-opens the gate: what was vetted is not what runs now.
    let edited = app
        .post_json_as(user.id, &script_url, json!({ "kind": "script", "title": "R", "description": "d", "code": "echo changed\n", "base_version": 1 }))
        .await
        .json().await;
    assert_eq!(edited["entry"]["status"], "draft", "an update to approved code needs a fresh look");

    // Deprecating needs a reason.
    let no_reason = app
        .post_json_as(user.id, &format!("{script_url}/status"), json!({ "status": "deprecated" }))
        .await;
    assert_eq!(no_reason.status(), 400, "{}", no_reason.text());
    let deprecated = app
        .post_json_as(user.id, &format!("{script_url}/status"), json!({ "status": "deprecated", "reason": "superseded by prod-report" }))
        .await;
    assert_eq!(deprecated.status(), 200, "{}", deprecated.text());
    assert_eq!(deprecated.json().await["entry"]["status"], "deprecated");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outsider_sees_nothing() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    app.post_json_as(user.id, &format!("/api/taskflow/toolbox/{project}/entry/x"), json!({ "kind": "memory", "title": "X", "description": "d", "body_markdown": "b" }))
        .await;

    let stranger = app.create_user().await;
    let listed = app.get_as(stranger, &format!("/api/taskflow/toolbox/{project}")).await;
    assert_eq!(listed.status(), 404, "a project the caller cannot see does not exist");
    let read = app.get_as(stranger, &format!("/api/taskflow/toolbox/{project}/entry/x")).await;
    assert_eq!(read.status(), 404);
    let write = app
        .post_json_as(stranger, &format!("/api/taskflow/toolbox/{project}/entry/x"), json!({ "kind": "memory", "title": "X", "description": "d", "body_markdown": "b" }))
        .await;
    assert_eq!(write.status(), 404);
}
