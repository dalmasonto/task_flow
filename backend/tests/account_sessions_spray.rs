//! #1134 review: the user-agent recorder stays bounded under a spray of fake
//! bearer keys. Its own test binary, so the spray's lookup budget can't starve
//! the other tests' recording.

use axum::Router;
use tokio::sync::OnceCell;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_testing::TestClient;

use backend::account_sessions::AccountSessionsPlugin;

static APP: OnceCell<Router> = OnceCell::const_new();

async fn app() -> &'static Router {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:").await.expect("pool");
        let mut settings = umbral::Settings::from_env().expect("settings");
        settings.database_url = "sqlite::memory:".to_string();
        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .plugin(AuthPlugin::<AuthUser>::default().with_default_routes())
            .plugin(umbral_sessions::SessionsPlugin::default())
            .plugin(AccountSessionsPlugin)
            .build()
            .expect("App::build");
        umbral::migrate::create_tables_for_tests().await.expect("schema");
        app.into_router()
    })
    .await
}

/// #1134 review: a spray of fake bearer keys can't turn into unbounded
/// lookups or cache growth. Entries are only added when a budgeted lookup is
/// spent, so the cache grows at most `LOOKUPS_PER_SEC` a second (and is
/// hard-capped on top of that).
#[tokio::test]
async fn fake_bearer_keys_are_budgeted() {
    let router = app().await.clone();
    let started = std::time::Instant::now();
    for i in 0..2_000 {
        let c = TestClient::new(router.clone());
        c.set_default_header(http::header::AUTHORIZATION, http::HeaderValue::from_str(&format!("Bearer fake-{i}")).unwrap());
        c.set_default_header(http::header::USER_AGENT, http::HeaderValue::from_static("spray"));
        c.get("/api/taskflow/me/sessions").await;
    }
    let secs = started.elapsed().as_secs() as usize + 1;
    let n = backend::account_sessions::recorded_len();
    assert!(n <= 20 * secs, "{n} cache entries (lookups) for {secs}s of spray");
}
