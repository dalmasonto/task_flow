//! #1114: signup validation in front of umbral-auth's register, end to end
//! through the real `POST /api/auth/register` and the real middleware.

use axum::Router;
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::{TestClient, seq};

static APP: OnceCell<Router> = OnceCell::const_new();

async fn app() -> &'static Router {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:").await.expect("pool");
        let mut settings = umbral::Settings::from_env().expect("settings");
        settings.database_url = "sqlite::memory:".to_string();
        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .middleware(backend::signup_validation::SignupValidation)
            // A generous budget: these tests are about validation, not the throttle.
            .plugin(AuthPlugin::<AuthUser>::default().with_default_routes().register_throttle(1000, std::time::Duration::from_secs(3600)))
            .build()
            .expect("App::build");
        umbral::migrate::create_tables_for_tests().await.expect("schema");
        app.into_router()
    })
    .await
}

async fn register(username: &str, email: &str) -> (u16, Value) {
    let res = TestClient::new(app().await.clone())
        .post_json("/api/auth/register", &json!({ "username": username, "email": email, "password": "a-long-enough-pass" }))
        .await;
    (res.status().as_u16(), res.body_json())
}

#[tokio::test]
async fn refuses_a_username_with_spaces_and_a_bad_email() {
    let n = seq();
    let (status, body) = register(&format!("v3 probe{n}"), &format!("ok{n}@example.com")).await;
    assert_eq!((status, body["error"].as_str(), body["field"].as_str()), (400, Some("invalid_username"), Some("username")));

    let (status, body) = register(&format!("probe{n}"), "bad").await;
    assert_eq!((status, body["error"].as_str(), body["field"].as_str()), (400, Some("invalid_email"), Some("email")));
}

#[tokio::test]
async fn names_which_field_is_taken_case_insensitively() {
    let n = seq();
    let (status, _) = register(&format!("Alice{n}"), &format!("alice{n}@example.com")).await;
    assert_eq!(status, 201);

    let (status, body) = register(&format!("alice{n}"), &format!("other{n}@example.com")).await;
    assert_eq!((status, body["error"].as_str()), (409, Some("username_taken")));

    let (status, body) = register(&format!("bob{n}"), &format!("ALICE{n}@example.com")).await;
    assert_eq!((status, body["error"].as_str()), (409, Some("email_taken")));
}

#[tokio::test]
async fn leaves_everything_else_to_umbral_auth() {
    let n = seq();
    // A valid new account still goes through.
    let (status, body) = register(&format!("carol{n}"), &format!("carol{n}@example.com")).await;
    assert_eq!(status, 201, "{body}");
    // Missing fields are still umbral-auth's invalid_input.
    let res = TestClient::new(app().await.clone()).post_json("/api/auth/register", &json!({ "username": "", "email": "", "password": "" })).await;
    assert_eq!((res.status().as_u16(), res.body_json::<Value>()["error"].as_str()), (400, Some("invalid_input")));
}
