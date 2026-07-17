//! The create-project endpoint — the fix for the orphan-project bug.
//!
//! The reported bug: creating a project via auto-REST `POST /api/taskflow_project/`
//! succeeded but the project never appeared in the UI, because auto-REST created
//! NO `TaskflowProjectMember` row and the SP-A scope hides any project the caller
//! isn't an active member of. The new `POST /api/taskflow/projects` endpoint
//! creates the project AND an active owner membership atomically, so the creator
//! can immediately see it.
//!
//! This harness boots BOTH surfaces in one app under real bearer-token auth:
//! the plugin's custom `POST /api/taskflow/projects` (via `RequireAuth`) and the
//! scoped auto-REST `taskflow_project` resource from `backend::rest` (exactly as
//! `main.rs` wires it, minus the create action). A single token authenticates
//! both, so a test can create through one and assert visibility through the other.

use axum::Router;
use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use umbral_auth::{AuthPlugin, AuthUser, BearerAuthentication, token::AuthToken};
use umbral_rest::{IsAuthenticated, RestPlugin};
use umbral_testing::{TestClient, seq};

use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member,
};

static APP: OnceCell<Router> = OnceCell::const_new();

async fn app() -> &'static Router {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        let mut settings = umbral::Settings::from_env().expect("settings from env");
        settings.database_url = "sqlite::memory:".to_string();

        // The REST plugin as main.rs builds it (bearer auth, IsAuthenticated),
        // with the scoped `taskflow_project` resource from `backend::rest` — the
        // one whose `create` action is now stripped. The custom create endpoint
        // comes from the TaskflowProjectsPlugin's own routes.
        let rest = RestPlugin::default()
            .authenticate(BearerAuthentication::default())
            .default_permission(IsAuthenticated)
            .resource(backend::rest::project_resource());

        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .plugin(AuthPlugin::<AuthUser>::default())
            .plugin(TaskflowProjectsPlugin)
            .plugin(rest)
            .build()
            .expect("App::build");

        umbral::migrate::create_tables_for_tests()
            .await
            .expect("create the test schema");

        app.into_router()
    })
    .await
}

/// A seeded user plus the bearer token that authenticates both surfaces.
struct Caller {
    id: i64,
    username: String,
    email: String,
    token: String,
}

async fn make_caller() -> Caller {
    let n = seq();
    let username = format!("creator-{n}");
    let email = format!("creator-{n}@example.test");
    let user = AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.clone(),
            email: email.clone(),
            password_hash: "unused-tests-authenticate-by-token".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser: false,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser");
    let (_, plaintext) = AuthToken::create_for(&user, "test")
        .await
        .expect("mint bearer token");
    Caller {
        id: user.id,
        username,
        email,
        token: plaintext.0,
    }
}

async fn client_for(token: &str) -> TestClient {
    let router = app().await;
    let client = TestClient::new(router.clone());
    client.set_default_header(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    client
}

async fn post_json(token: &str, path: &str, body: Value) -> (u16, Value) {
    let res = client_for(token).await.post_json(path, &body).await;
    (res.status().as_u16(), res.body_json())
}

async fn get(token: &str, path: &str) -> (u16, Value) {
    let res = client_for(token).await.get(path).await;
    (res.status().as_u16(), res.body_json())
}

fn result_ids(body: &Value) -> Vec<i64> {
    body["results"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|r| r["id"].as_i64()).collect())
        .unwrap_or_default()
}

/// THE bug. An authenticated user creates a project → 201, is immediately an
/// ACTIVE OWNER member, and the project now shows up in their own scoped list.
#[tokio::test]
async fn create_project_makes_caller_active_owner_and_project_is_visible() {
    app().await;
    let caller = make_caller().await;
    let n = seq();

    let (status, body) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": format!("Visible Project {n}") }),
    )
    .await;

    assert_eq!(status, 201, "create must return 201; got {body}");
    let project_id = body["id"].as_i64().expect("created project id");
    assert_eq!(body["owner"], json!(caller.id), "owner is the caller");
    assert_eq!(body["status"], json!("active"), "status forced active");
    assert!(
        body["slug"].as_str().unwrap().starts_with("visible-project-"),
        "slug derived from name; got {body}",
    );

    // The caller is an ACTIVE OWNER member of the new project.
    let member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(caller.id),
        )
        .first()
        .await
        .expect("load member")
        .expect("an owner membership must exist for the creator");
    assert_eq!(member.role, TaskflowProjectRole::Owner);
    assert_eq!(member.member_key, format!("user:{}", caller.id));
    assert_eq!(
        serde_json::to_value(member.status).unwrap(),
        json!("active"),
        "membership must be active",
    );

    // ...and the project is now visible in the caller's OWN scoped list — the
    // exact thing the orphan bug broke.
    let (list_status, list_body) = get(&caller.token, "/api/taskflow_project/").await;
    assert_eq!(list_status, 200);
    assert!(
        result_ids(&list_body).contains(&project_id),
        "the creator must see their just-created project; got {list_body}",
    );
}

/// A duplicate slug returns 409 with a `slug` field error the FE can render inline.
#[tokio::test]
async fn duplicate_slug_is_409_with_slug_field_error() {
    app().await;
    let caller = make_caller().await;
    let slug = format!("dup-slug-{}", seq());

    let (first_status, _) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": "First", "slug": slug }),
    )
    .await;
    assert_eq!(first_status, 201);

    let (second_status, body) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": "Second", "slug": slug }),
    )
    .await;

    assert_eq!(second_status, 409, "duplicate slug must 409; got {body}");
    assert_eq!(
        body["code"],
        json!("unique_constraint"),
        "code must match the framework's unique-constraint shape; got {body}",
    );
    let slug_errors = body["slug"].as_array().expect("slug field error array");
    assert!(
        !slug_errors.is_empty() && slug_errors[0].is_string(),
        "the body must carry a `slug` field error; got {body}",
    );
}

/// A client-supplied slug is honoured (normalized), and an omitted slug is
/// derived from the name.
#[tokio::test]
async fn self_provided_slug_respected_and_derived_slug_works() {
    app().await;
    let caller = make_caller().await;
    let n = seq();

    // Self-provided slug (with punctuation/case) is normalized and used verbatim.
    let (status, body) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": "Whatever Name", "slug": format!("My Custom Slug {n}!") }),
    )
    .await;
    assert_eq!(status, 201, "got {body}");
    assert_eq!(
        body["slug"],
        json!(format!("my-custom-slug-{n}")),
        "a self-provided slug is respected (normalized); got {body}",
    );

    // Omitted slug is derived from the name.
    let (status2, body2) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": format!("Derived From Name {n}") }),
    )
    .await;
    assert_eq!(status2, 201, "got {body2}");
    assert_eq!(
        body2["slug"],
        json!(format!("derived-from-name-{n}")),
        "an omitted slug is derived from the name; got {body2}",
    );
}

/// Regression: auto-REST create on `taskflow_project` is gone. A client that
/// still POSTs to the collection gets 405, not a 201 orphan project.
#[tokio::test]
async fn auto_rest_create_is_405() {
    app().await;
    let caller = make_caller().await;

    let (status, body) = post_json(
        &caller.token,
        "/api/taskflow_project/",
        json!({
            "name": "Orphan",
            "slug": format!("orphan-{}", seq()),
            "description_markdown": "x",
        }),
    )
    .await;

    assert_eq!(
        status, 405,
        "auto-REST create must be removed so it can't mint orphan projects; got {status}: {body}",
    );
}

/// The default field values land: an empty description gets a placeholder and the
/// default api base url is `/api`.
#[tokio::test]
async fn defaults_are_applied_for_empty_optional_fields() {
    app().await;
    let caller = make_caller().await;

    let (status, body) = post_json(
        &caller.token,
        "/api/taskflow/projects",
        json!({ "name": format!("Defaults {}", seq()) }),
    )
    .await;

    assert_eq!(status, 201, "got {body}");
    assert!(
        body["description_markdown"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "an empty description defaults to a placeholder; got {body}",
    );
    assert_eq!(
        body["default_api_base_url"],
        json!("/api"),
        "default_api_base_url defaults to /api; got {body}",
    );
    // Silence unused-field warnings for a caller whose email/username this test
    // does not assert on.
    let _ = (&caller.username, &caller.email);
}
