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
mod media_access;
mod realtime;
mod realtime_auth;
mod seed;
mod views;
mod widgets;

use std::sync::Arc;
use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_github::TaskflowGithubPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_tasks::TaskflowTasksPlugin;
use umbral::prelude::*;
use umbral::web::SlashRedirect;
use umbral_admin::AdminPlugin;
use umbral_auth::{
    AuthPlugin, AuthUser, BearerAuthentication, SessionAuthentication, login_required_html,
};
use umbral_oauth::OAuthPlugin;
use umbral_oauth::providers::GitHubProvider;
use umbral_openapi::OpenApiPlugin;
use umbral_playground::PlaygroundPlugin;
use umbral_rest::{
    ChainAuthentication, IsAuthenticated, PageNumberPagination, ResourceConfig, RestPlugin,
    UserRateThrottle,
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

    let mut builder = App::builder();

    // Cross-origin FE: in production the SPA is served from a different
    // origin (taskflow.supercodehive.com:10003) than this API
    // (api.taskflow.supercodehive.com:10002) — ports exposed directly, no
    // reverse proxy — so browsers preflight API calls. Comma-separated
    // origins; unset (local dev via the Vite proxy) adds no CORS layer at
    // all, which keeps same-origin dev behavior byte-identical.
    if let Ok(origins) = std::env::var("TASKFLOW_CORS_ALLOWED_ORIGINS") {
        let cfg = origins
            .split(',')
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .fold(
                // strict() already allows the methods + Content-Type/
                // Authorization headers the API needs; credentials on because
                // the FE fetches with `credentials: "include"`.
                umbral::cors::CorsConfig::strict().allow_credentials(true),
                |cfg, origin| cfg.allow_origin(origin),
            );
        builder = builder.cors(cfg);
    }

    let app = builder
        .settings(settings)
        .database("default", pool)
        // #41: let the realtime SSE authenticate with the bearer token via
        // `?access_token=` (EventSource cannot send an Authorization header), so
        // a stale session cookie after a restart no longer 403s the live feed.
        .middleware(realtime_auth::RealtimeQueryTokenAuth)
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
        // GitHub OAuth: social login + account-linking. Requires SessionsPlugin
        // (wired above) for the single-use `state` + PKCE. Providers load from
        // env (UMBRAL_OAUTH_GITHUB_CLIENT_ID/SECRET); absent env => no provider
        // registered, and the connect routes 404 until it is configured. Scope
        // is `repo` (issue create + comments), overriding the default identity
        // scopes.
        .plugin({
            // `redirect_base` is the app's public, browser-facing origin: the
            // GitHub callback is `{base}/oauth/github/callback` and it's where
            // relative redirects resolve. In dev that's the Vite origin (:5173,
            // which proxies /oauth to this backend), NOT the backend's own port.
            // Override with UMBRAL_OAUTH_REDIRECT_BASE in staging/prod.
            let base = std::env::var("UMBRAL_OAUTH_REDIRECT_BASE")
                .unwrap_or_else(|_| "http://localhost:5173".to_string());
            let mut oauth = OAuthPlugin::new(base.clone())
                // After a connect, return to settings so the SPA shows "Connected".
                .login_redirect("/account/settings?github=connected")
                // Allow the SPA's own origin as a `?next=` return target (the
                // open-redirect allowlist; a `next` off this origin is rejected).
                .allow_return(base.clone());
            if let Some(gh) = GitHubProvider::from_env() {
                oauth = oauth.provider(gh.scopes("repo"));
            }
            oauth
        })
        // TaskFlow GitHub linking: publish-as-issue + comment-as-actor. Reads
        // linked tokens from the OAuth SocialAccount model above.
        .plugin(TaskflowGithubPlugin::default())
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

            // Every project-scoped resource is restricted to the caller's
            // active-membership rows in `backend::rest` — a bare
            // `ResourceConfig::new` here would let any logged-in user list
            // EVERY project's data by id. `Post` (the demo model) and other
            // non-project resources stay unscoped on purpose.
            let mut rest = RestPlugin::default()
                .authenticate(auth)
                .default_permission(IsAuthenticated)
                .default_throttle(UserRateThrottle::new("600/min"))
                // #56: every list endpoint pages, 25 at a time.
                //
                // The default is NoPagination, which ignores every client
                // parameter and returns up to MAX_LIST_ROWS (1000) rows — so the
                // UI could not ask for less, and opening a board fetched every
                // task, message and activity row in the project.
                //
                // Pagination is configured on the PLUGIN, not per resource, so
                // this necessarily applies to every list. The envelope gains
                // `count` (the true total), which is what lets a caller tell
                // "end of data" apart from "end of page" — without it a short
                // page is indistinguishable from the end, and silent truncation
                // is the failure mode this whole change has to avoid.
                .paginate(PageNumberPagination::new(25))
                .resource(ResourceConfig::new(Post::table_name()))
                .resource(backend::rest::project_resource())
                .resource(backend::rest::user_settings_resource());
            for resource in backend::rest::project_scoped_resources() {
                rest = rest.resource(resource);
            }
            rest
        })
        .plugin(PlaygroundPlugin::new("taskflow"))
        // OpenAPI: Swagger UI at /openapi/ (override with
        // `.at("/api/docs")` if you prefer a different mount).
        .plugin(OpenApiPlugin::new())
        // Realtime: SSE/WS model-change notifications + project-room presence.
        // Frontend clients subscribe to `/realtime/client.js` and groups such
        // as `taskflow:projects`, `project:{id}:messages`, or
        // `project:{id}:presence` — one group per model, because the event name
        // carries the action, not the table. See `realtime.rs`.
        .plugin(realtime::plugin())
        // Static files: serves ./static at /static, which is where the compiled
        // Tailwind bundle lives. Use `{ static('css/app.css') }` in templates
        // rather than a hardcoded path — in production it resolves through the
        // hashed-asset manifest so you get cache-busting for free.
        //
        // The same plugin also gives you uploaded-file storage (local FS or S3)
        // when you add a FileField / ImageField: `.media("/media", "./media")`.
        .plugin(
            StoragePlugin::new()
                .static_files("/static", "./static")
                // Uploaded-file storage for message attachments (FileField):
                // registers the ambient backend, serves files at /media/<key>,
                // and enforces the 25 MiB media cap.
                .media("/media", "./media")
                // Every media GET is authorized before bytes move: channel
                // membership for message attachments, active project
                // membership for task attachments, superuser bypass, orphan
                // keys denied. See src/media_access.rs for the full policy.
                .media_access(|headers: axum::http::HeaderMap, key: String| async move {
                    media_access::media_access_allowed(&headers, &key).await
                }),
        )
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

    // Booting NEVER writes schema. It used to run `makemigrations` + `migrate`
    // here so `cargo run` Just Worked on a fresh database, and that convenience
    // cost more than it saved:
    //
    // Under `cargo-watch`, every source save re-runs this. A model edited
    // half-way through a change therefore had a migration GENERATED from that
    // intermediate state and APPLIED within seconds — before the change was
    // finished. Editing the model further and regenerating the file produced a
    // migration with the same id, which `migrate` skips (it tracks by name), so
    // the database kept a schema that no longer matched any file. It surfaced as
    // a 500 on insert for a column that existed in the migration and not in the
    // table, and no test caught it: throwaway test databases are always fresh, so
    // they only ever saw the final, correct file.
    //
    // Migrations are now explicit — `cargo run -- makemigrations` and
    // `cargo run -- migrate` — so a schema change happens when a human decides it
    // does, not as a side effect of saving a file.
    let argv: Vec<String> = std::env::args().collect();
    let user_invoked_cli = argv.iter().skip(1).any(|a| !a.starts_with('-'));
    if !user_invoked_cli {
        warn_if_migrations_pending().await;
        // First-run data. `seed::all()` is idempotent — see seed/mod.rs.
        // Non-fatal: on a fresh database the tables do not exist yet, and an
        // unmigrated database should say so plainly rather than fail to boot
        // with a raw SQL error.
        if let Err(err) = seed::all().await {
            eprintln!("seed: skipped ({err})");
            eprintln!("      If this database is new, run `cargo run -- migrate` first.");
        }
    }

    umbral_cli::dispatch(app).await
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/// Say loudly that the schema is behind, without changing it.
///
/// Read-only on purpose: the whole point of dropping auto-migrate is that boot
/// does not alter the database. This only tells the human what to run.
async fn warn_if_migrations_pending() {
    match umbral::migrate::check_pending_safety().await {
        Ok(ops) if !ops.is_empty() => {
            eprintln!("migrations: {} pending operation(s) NOT applied.", ops.len());
            eprintln!("            Run `cargo run -- migrate` to apply them.");
        }
        Ok(_) => {}
        // A database with no migration table at all lands here on first run.
        Err(err) => {
            eprintln!("migrations: could not be checked ({err}).");
            eprintln!("            If this database is new, run `cargo run -- migrate`.");
        }
    }
}
