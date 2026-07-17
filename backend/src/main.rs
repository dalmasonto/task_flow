//! backend — application entrypoint.
//!
//! This `main.rs` reads like a table of contents: the App builder lists
//! every model, plugin, and route, and the per-concern submodules below
//! own the detail. As the project grows you slot new handlers into
//! `views/`, new seed steps into `seed/`, and new dashboard widgets into
//! `widgets/` — `main.rs` stays a thin wiring layer.
//!
//!   src/
//!     main.rs      — App builder + route table + boot helpers (this file)
//!     views/       — HTTP handlers, one file per resource grouping
//!     seed/        — first-run data, `seed::all()` pins dependency order
//!     widgets/     — admin dashboard widgets, one file per kind
//!     ../plugins/  — local app plugins (`umbral startapp <name>`)
//!
//! Run with:
//!   cargo run -- migrate   # apply pending migrations (run once after checkout)
//!   cargo run -- serve     # boot the HTTP server
//!
//! Other management commands:
//!   cargo run -- makemigrations
//!   cargo run -- showmigrations
//!   cargo run -- createsuperuser

// --- Per-concern modules (the table of contents) ---------------------------
mod realtime;
mod seed;
mod views;
mod widgets;

use std::sync::Arc;
use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_tasks::TaskflowTasksPlugin;
use umbral::migrate::MigrateError;
use umbral::prelude::*;
use umbral::web::SlashRedirect;
use umbral_admin::AdminPlugin;
use umbral_auth::{
    AuthPlugin, AuthUser, BearerAuthentication, SessionAuthentication, login_required_html,
};
use umbral_openapi::OpenApiPlugin;
use umbral_playground::PlaygroundPlugin;
use umbral_rest::{
    ChainAuthentication, IsAuthenticated, ResourceConfig, RestPlugin, UserRateThrottle,
};
use umbral_security::{SecurityConfig, SecurityPlugin};
use umbral_sessions::SessionsPlugin;
use umbral_storage::StoragePlugin;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/// A blog post. `author` is a FK to the built-in `AuthUser` model — the
/// migration engine emits `REFERENCES "auth_user"("id")` automatically.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow, Model)]
pub struct Post {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub published: bool,
    pub author: ForeignKey<AuthUser>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Observability: structured logging + (under the `otel` feature on
    // `umbral-logs`) OpenTelemetry OTLP trace export. Reads RUST_LOG,
    // UMBRAL_LOG_FORMAT=json, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME.
    // Keep the guard alive for the whole program: it flushes the OTLP
    // exporter on drop so trailing spans aren't lost at exit.
    let _obs = umbral_logs::observability::init(umbral_logs::ObservabilityConfig::from_env());

    let settings = Settings::from_env()?;
    let pool = umbral::db::connect(&settings.database_url).await?;

    let app = App::builder()
        .settings(settings)
        .database("default", pool)
        // --- Models ----------------------------------------------------------
        // AuthUser and Session are contributed by their plugins below.
        // List your own models here.
        .model::<Post>()
        // --- Plugins ---------------------------------------------------------
        // Auth: user table, password hashing, createsuperuser command.
        .plugin(AuthPlugin::<AuthUser>::default().with_default_routes())
        // Sessions: session table + cookie middleware.
        .plugin(SessionsPlugin::default())
        // TaskFlow domain plugins: project workspaces, project-based tasks, and
        // agent collaboration primitives. Each crate owns its models/routes.
        .plugin(TaskflowProjectsPlugin::default())
        .plugin(TaskflowTasksPlugin::default())
        .plugin(TaskflowAgentsPlugin::default())
        // Admin: auto CRUD UI at /admin/ for every registered model.
        // The dashboard mounts one builtin widget from `widgets/` so a
        // fresh admin isn't empty — add your own with `.dashboard_section`.
        .plugin(AdminPlugin::default().dashboard_section(widgets::cards::overview_section()))
        // REST: JSON CRUD + filtering at /api/<table>/.
        // The Post resource has query-string filtering enabled so
        // GET /api/post/?published=true works out of the box.
        .plugin({
            let auth = ChainAuthentication::new(vec![
                Arc::new(SessionAuthentication::default()),
                Arc::new(BearerAuthentication::default()),
            ]);

            RestPlugin::default()
                .authenticate(auth)
                .default_permission(IsAuthenticated)
                .default_throttle(UserRateThrottle::new("600/min"))
                .resource(ResourceConfig::new(Post::table_name()))
                .resource(ResourceConfig::new("taskflow_project"))
                .resource(ResourceConfig::new("taskflow_project_member"))
                .resource(ResourceConfig::new("taskflow_project_invite"))
                .resource(ResourceConfig::new("taskflow_project_api_endpoint"))
                .resource(ResourceConfig::new("taskflow_task"))
                .resource(ResourceConfig::new("taskflow_task_relation"))
                .resource(ResourceConfig::new("taskflow_task_activity"))
                .resource(ResourceConfig::new("taskflow_task_session"))
                .resource(ResourceConfig::new("taskflow_agent"))
                .resource(ResourceConfig::new("taskflow_agent_credential"))
                .resource(ResourceConfig::new("taskflow_agent_session"))
                .resource(ResourceConfig::new("taskflow_agent_channel"))
                .resource(ResourceConfig::new("taskflow_agent_channel_member"))
                .resource(ResourceConfig::new("taskflow_agent_message"))
                .resource(ResourceConfig::new("taskflow_agent_terminal_frame"))
        })
        .plugin(PlaygroundPlugin::new("taskflow"))
        // OpenAPI: Swagger UI at /openapi/ (override with
        // `.at("/api/docs")` if you prefer a different mount).
        .plugin(OpenApiPlugin::new())
        // Realtime: SSE/WS model-change notifications + project-room presence.
        // Frontend clients subscribe to `/realtime/client.js` and groups such
        // as `taskflow:projects` or `project:{id}`.
        .plugin(realtime::plugin())
        // Static files: serves ./static at /static, which is where the compiled
        // Tailwind bundle lives. Use `{ static('css/app.css') }` in templates
        // rather than a hardcoded path — in production it resolves through the
        // hashed-asset manifest so you get cache-busting for free.
        //
        // The same plugin also gives you uploaded-file storage (local FS or S3)
        // when you add a FileField / ImageField: `.media("/media", "./media")`.
        .plugin(StoragePlugin::new().static_files("/static", "./static"))
        // Security (on by default): CSRF + clickjacking/HSTS hardening
        // headers across the app. `/api` is exempt so token-authenticated
        // JSON clients can POST without a browser form CSRF cookie.
        .plugin(SecurityPlugin::with_config(SecurityConfig {
            csrf_exempt_paths: vec!["/api".to_string()],
            ..Default::default()
        }))
        // --- Templates -------------------------------------------------------
        .templates_dir("templates")
        .not_found_template("404.html")
        .server_error_template("500.html")
        // Redirect /foo → /foo/  (append trailing slash).
        .slash_redirect(SlashRedirect::Append)
        // --- Routes ----------------------------------------------------------
        // The Routes builder records each (method, path) pair as you
        // declare it, so the dev-mode 404 panel surfaces them without
        // a parallel declaration list. Handlers live in `views/`; this
        // table is the URL conf — open `views/mod.rs` to see them all.
        // Per-route middleware (here, login_required_html on /dashboard)
        // goes through the explicit `.layered(method, path, mr)` form so
        // the layer attaches just to that handler — not all routes.
        .routes(
            Routes::new()
                // Public home page.
                .get("/", views::public::home)
                // API: list posts as JSON (no auth required — demo).
                .get("/api/posts", views::public::api_list_posts)
                // Dashboard: only reachable when logged in. The
                // login_required_html("/login") layer issues a 302 to
                // /login?next=/dashboard/ for anonymous visitors.
                .layered(
                    "GET",
                    "/dashboard",
                    get(views::public::dashboard).layer(login_required_html("/login")),
                ),
        )
        // `build_deferred`, not `build`: it wires everything (pools, model
        // registry, router, system checks) but leaves each plugin's `on_ready`
        // hook unfired. Those hooks seed content and backfill rows, so they must
        // not run during `migrate` — the command whose whole job is to create the
        // tables they write to. `dispatch` fires them once it has read argv.
        .build_deferred()?;

    // Auto-migrate + seed on boot so `cargo run -- serve` Just Works
    // against a fresh database — but only when we're actually starting
    // the server. Running `cargo run -- makemigrations` or `migrate`
    // from the CLI used to silently trigger `auto_migrate()` first and
    // then report "no changes detected" (IMP-1 in bugs/tests/testBugs.md).
    // The guard reads `std::env::args` before dispatch picks them apart
    // so it matches whatever subcommand the user actually typed.
    let argv: Vec<String> = std::env::args().collect();
    let user_invoked_cli = argv.iter().skip(1).any(|a| !a.starts_with('-'));
    if !user_invoked_cli {
        auto_migrate().await?;
        // First-run data. `seed::all()` is idempotent — see seed/mod.rs.
        seed::all().await?;
    }

    umbral_cli::dispatch(app).await
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/// Run `makemigrations` + `migrate` on boot. Demo-only convenience.
async fn auto_migrate() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match umbral::migrate::make().await {
        Ok(paths) => {
            for path in paths {
                eprintln!("auto-migrate: wrote {}", path.display());
            }
        }
        Err(MigrateError::NoChanges) => {}
        Err(err) => return Err(Box::new(err)),
    }
    let n = umbral::migrate::run().await?;
    if n > 0 {
        eprintln!("auto-migrate: applied {n} migration(s)");
    }
    Ok(())
}
