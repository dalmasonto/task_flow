//! #1124: a form-encoded "taken" answer spends one register-throttle unit,
//! exactly like the JSON one. Its own test binary (its own process), because
//! the throttle budget is process-wide.

use axum::Router;
use serde_json::Value;
use tokio::sync::OnceCell;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::TestClient;

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
            // Budget of 2: one real signup, one "taken" answer, then nothing.
            .plugin(AuthPlugin::<AuthUser>::default().with_default_routes().register_throttle(2, std::time::Duration::from_secs(3600)))
            .build()
            .expect("App::build");
        umbral::migrate::create_tables_for_tests().await.expect("schema");
        app.into_router()
    })
    .await
}

async fn form(username: &str, email: &str) -> (u16, Value) {
    let client = TestClient::new(app().await.clone());
    client.set_default_header(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let body = format!("username={username}&email={email}&password=a-long-enough-pass");
    let res = client.send(http::Method::POST, "/api/auth/register", axum::body::Body::from(body)).await;
    (res.status().as_u16(), res.body_json())
}

#[tokio::test]
async fn a_form_encoded_taken_answer_spends_a_throttle_unit() {
    assert_eq!(form("erin", "erin%40example.com").await.0, 201, "unit 1: the real signup");
    let (status, body) = form("erin", "other%40example.com").await;
    assert_eq!((status, body["error"].as_str()), (409, Some("username_taken")), "unit 2: the taken answer");
    let (status, body) = form("erin", "third%40example.com").await;
    assert_eq!(status, 429, "the budget is spent, so taken can no longer be probed: {body}");
}
