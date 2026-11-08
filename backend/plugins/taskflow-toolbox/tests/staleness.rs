//! #1097: toolbox facts show their age.
//!
//! A memory marked `status` goes stale after 14 days without a re-check; a
//! `rule` never does. Re-checking moves `checked_at` only: no new version,
//! content untouched.

mod support;
use chrono::{Duration, Utc};
use serde_json::json;
use support::{TestApp, seed_agent_key, seed_member, seed_project};
use taskflow_toolbox::models::{ToolboxEntry, toolbox_entry};

async fn backdate(project: i64, name: &str, days: i64) {
    let mut e = ToolboxEntry::objects()
        .filter(toolbox_entry::PROJECT.eq(project) & toolbox_entry::NAME.eq(name))
        .first()
        .await
        .unwrap()
        .unwrap();
    e.checked_at = Some(Utc::now() - Duration::days(days));
    ToolboxEntry::objects().save(e).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_status_fact_goes_stale_and_a_recheck_freshens_it_without_a_new_version() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    let base = format!("/api/taskflow/toolbox/{project}");

    for (name, kind) in [("prod-version", "status"), ("never-push-main", "rule")] {
        let res = app
            .post_json_as(user.id, &format!("{base}/entry/{name}"), json!({ "kind": "memory", "title": name, "description": "d", "body_markdown": "b", "fact_kind": kind }))
            .await;
        assert_eq!(res.status(), 200, "{}", res.text());
        let saved = res.json().await;
        let entry = if saved.get("entry").is_some() { saved["entry"].clone() } else { saved.clone() };
        assert_eq!(entry["fact_kind"], kind, "{saved}");
        assert_eq!(entry["stale"], false);
    }
    backdate(project, "prod-version", 20).await;
    backdate(project, "never-push-main", 400).await;

    let list = app.get_as(user.id, &base).await.json().await;
    let rows = list.as_array().cloned().or_else(|| list["entries"].as_array().cloned()).or_else(|| list["results"].as_array().cloned()).expect("a list");
    let find = |n: &str| rows.iter().find(|r| r["name"] == n).cloned().unwrap();
    assert_eq!(find("prod-version")["stale"], true, "a status fact 20 days old is stale");
    assert_eq!(find("never-push-main")["stale"], false, "a rule never goes stale");
    let version_before = find("prod-version")["version"].clone();

    let rechecked = app.post_json_as(user.id, &format!("{base}/entry/prod-version/recheck"), json!({})).await;
    assert_eq!(rechecked.status(), 200, "{}", rechecked.text());
    let r = rechecked.json().await;
    assert_eq!(r["stale"], false);
    assert_eq!(r["version"], version_before, "a re-check is not a new version");
}

#[tokio::test(flavor = "multi_thread")]
async fn fact_kind_is_for_memories_and_agents_need_toolbox_write_to_recheck() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    let base = format!("/api/taskflow/toolbox/{project}");

    let script = app
        .post_json_as(user.id, &format!("{base}/entry/a-script"), json!({ "kind": "script", "title": "s", "description": "d", "body_markdown": "b", "code": "echo hi", "language": "bash", "fact_kind": "status" }))
        .await;
    assert_eq!(script.status(), 400);
    let bad = app
        .post_json_as(user.id, &format!("{base}/entry/a-memory"), json!({ "kind": "memory", "title": "m", "description": "d", "body_markdown": "b", "fact_kind": "maybe" }))
        .await;
    assert_eq!(bad.status(), 400);
    app.post_json_as(user.id, &format!("{base}/entry/ok-memory"), json!({ "kind": "memory", "title": "m", "description": "d", "body_markdown": "b", "fact_kind": "status" })).await;

    let denied = seed_agent_key(project, &["toolbox:write"]).await;
    assert_eq!(app.post_json_as_agent(&denied, "/api/taskflow/agents/toolbox/ok-memory/recheck", json!({})).await.status(), 403);
    let allowed = seed_agent_key(project, &[]).await;
    assert_eq!(app.post_json_as_agent(&allowed, "/api/taskflow/agents/toolbox/ok-memory/recheck", json!({})).await.status(), 200);
}

/// #1097 review: a re-check interleaved with saves must never write an older
/// body or version back. Saves run in order while re-checks hammer the same
/// entry; every save must land, and the entry must end on the last one.
#[tokio::test(flavor = "multi_thread")]
async fn a_recheck_racing_saves_never_reverts_the_content() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;
    let base = format!("/api/taskflow/toolbox/{project}");
    let save = |n: usize, base_version: Option<i64>| {
        let app = &app;
        let path = format!("{base}/entry/live-fact");
        async move {
            app.post_json_as(user.id, &path, json!({ "kind": "memory", "title": "f", "description": "d", "body_markdown": format!("body {n}"), "fact_kind": "status", "base_version": base_version }))
                .await
        }
    };
    assert_eq!(save(0, None).await.status(), 200);
    let first = app.get_as(user.id, &format!("{base}/entry/live-fact")).await.json().await;
    let v0 = first.get("entry").unwrap_or(&first)["version"].as_i64().expect("version");

    const SAVES: usize = 15;
    let done = std::sync::atomic::AtomicBool::new(false);
    let saver = async {
        // Each save names the version it read. A re-check that wrote an older
        // version back would make the next save's base stale (409).
        let mut version = v0;
        for n in 1..=SAVES {
            let res = save(n, Some(version)).await;
            assert_eq!(res.status(), 200, "save {n}: {}", res.text());
            let v = res.json().await;
            version = v.get("entry").unwrap_or(&v)["version"].as_i64().expect("version");
        }
        done.store(true, std::sync::atomic::Ordering::SeqCst);
    };
    let checker = async {
        while !done.load(std::sync::atomic::Ordering::SeqCst) {
            let r = app.post_json_as(user.id, &format!("{base}/entry/live-fact/recheck"), json!({})).await;
            assert_eq!(r.status(), 200);
        }
    };
    tokio::join!(saver, checker);

    let last = app.get_as(user.id, &format!("{base}/entry/live-fact")).await.json().await;
    let e = last.get("entry").unwrap_or(&last);
    assert_eq!(e["version"].as_i64(), Some(v0 + SAVES as i64), "{e}");
    let body = e["body_markdown"].as_str().or_else(|| last["body_markdown"].as_str()).unwrap_or_default();
    assert!(body.contains(&format!("body {SAVES}")), "the last save must stand: {last}");
}
