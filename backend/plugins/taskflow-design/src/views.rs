//! HTTP handlers for the `taskflow-design` plugin.
//!
//! Two audiences, hard-split (§6.1):
//!
//! * Chrome-facing `/api/design/{project}/...` — authed users, gated on active
//!   project membership (superusers pass, matching the SP-A scope). Writes run
//!   the same validator agent writes do; there is no looser operator path.
//! * Sandbox-facing `/s/{token}/...` — NO auth cookies. The HMAC token in the
//!   path is the whole grant: read of one project's composed design pages and
//!   files, short-lived. Handlers here must never touch user identity.

use std::collections::HashSet;

use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, REFERRER_POLICY};
use http::HeaderValue;
use serde::Deserialize;
use serde_json::json;
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

use umbral::web::{IntoResponse, Json, Path, Query, Request, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};
use umbral_realtime::Realtime;

use taskflow_projects::scope::can_access_project;

use crate::composer;
use crate::layout_doc;
use crate::manifest;
use crate::models::{
    CommentScope, CommentStatus, DesignComment, DesignFile, DesignFileKind, DesignLayout,
    design_comment, design_layout,
};
use crate::sandbox;
use crate::signals;
use crate::store::{self, ProjectLocks, WriteOutcome};
use crate::tokens::{TokensDoc, tokens_json_to_css};

/// Shared per-project write locks. One instance per process; cheap to clone.
pub fn project_locks() -> ProjectLocks {
    use std::sync::OnceLock;
    static LOCKS: OnceLock<ProjectLocks> = OnceLock::new();
    LOCKS.get_or_init(ProjectLocks::new).clone()
}

/// Membership gate for chrome-facing routes. Fails closed: any error or absent
/// membership is a 403, never a pass-through.
async fn ensure_member(user_id: i64, project_id: i64) -> Result<(), StatusCode> {
    if can_access_project(user_id, project_id).await {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

async fn load_caller(user_id: i64) -> Result<AuthUser, StatusCode> {
    AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)
}

/// `updated_by` attribution from the caller's row. Agents get their display
/// name via the agent-authed endpoints (Phase 3); operators are recorded as
/// `operator:{username}` so multi-operator projects can tell edits apart.
pub fn operator_attribution(caller: &AuthUser) -> String {
    format!("operator:{}", caller.username)
}

// ---------------------------------------------------------------------------
// Manifest + files
// ---------------------------------------------------------------------------

/// `GET /api/design/{project}/sandbox-token` — mint a short-lived read token
/// for composing artboard URLs. Member-gated like every other chrome route;
/// the token itself is read-only and expires in minutes.
pub async fn mint_sandbox_token(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    Ok(Json(json!({ "token": sandbox::mint(project_id) })))
}

#[derive(Debug, Deserialize)]
pub struct FetchAssetQuery {
    pub url: String,
}

/// `GET /api/design/{project}/fetch-asset?url=…` — fetch one of a page's
/// EXTERNAL images server-side and hand its bytes back, for the export to
/// inline (see `remote_fetch.rs` for why the page and the chrome cannot, and
/// for the bounds this fetch runs under).
///
/// Member-gated like every chrome route. The status says WHY a fetch was
/// refused — the export skips the image either way, so this is for the person
/// reading the network tab, not for the code: 400 for a url the policy will
/// never fetch, 415 for a response that is not an image, 413 for one over the
/// cap, and 502 for an upstream that did not answer well.
pub async fn fetch_asset(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(query): Query<FetchAssetQuery>,
) -> Result<Response, StatusCode> {
    use crate::remote_fetch::{Refusal, fetch_image};
    ensure_member(user_id, project_id).await?;
    let fetched = fetch_image(&query.url).await.map_err(|refusal| match refusal {
        Refusal::NotHttps
        | Refusal::NoHost
        | Refusal::LocalName
        | Refusal::IpLiteral
        | Refusal::PrivateAddress
        | Refusal::Unresolvable => StatusCode::BAD_REQUEST,
        Refusal::NotAnImage => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        Refusal::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Refusal::TooManyRedirects
        | Refusal::BadRedirect
        | Refusal::Upstream(_)
        | Refusal::Network => StatusCode::BAD_GATEWAY,
    })?;
    let content_type =
        HeaderValue::from_str(&fetched.content_type).map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut response = fetched.bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, content_type);
    // The bytes are exactly the upstream's, typed as it typed them; never let
    // a browser second-guess that into something scriptable.
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    // An export asks for each image once per page that shows it; a private
    // cache keeps the second page's ask off the wire.
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(response)
}

/// `GET /api/design/{project}/agents` — the project's agent roster, for the
/// dispatch "Send to agent" picker. Read-only projection: id, name, status.
pub async fn list_project_agents(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let rows = taskflow_agents::models::TaskflowAgent::objects()
        .filter(taskflow_agents::models::taskflow_agent::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let agents: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|a| json!({ "id": a.id, "display_name": a.display_name }))
        .collect();
    Ok(Json(json!({ "agents": agents })))
}

#[derive(Debug, Deserialize)]
pub struct CreateScreenshotInput {
    pub route: String,
    /// Device preset id, e.g. `iphone-16-pro` (same table as the canvas).
    pub viewport: String,
    #[serde(default)]
    pub state: Option<String>,
    /// Optional custom size / emulation / capture / dress — see
    /// `screenshots::ScreenshotRequest`.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub dpr: Option<u32>,
    #[serde(default)]
    pub mobile: Option<bool>,
    #[serde(default)]
    pub full_page: bool,
    #[serde(default)]
    pub frame: crate::screenshots::Frame,    /// `light` | `dark` | `both`.
    #[serde(default)]
    pub theme: crate::screenshots::Theme,
    /// #522: unsaved token/CSS overrides.
    #[serde(default)]
    pub overrides: crate::compare::Overrides,
}

/// `POST /api/design/{project}/screenshots` — render a route at a viewport and
/// return the PNG. 503 (not 500) when the renderer service is not configured:
/// that is an environment state the operator can fix, not a bug.
pub async fn create_screenshot(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<CreateScreenshotInput>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let req = crate::screenshots::ScreenshotRequest {
        viewport: input.viewport.clone(),
        width: input.width,
        height: input.height,
        dpr: input.dpr,
        mobile: input.mobile,
        full_page: input.full_page,
        frame: input.frame,
        theme: input.theme,
        overrides: input.overrides.clone(),
    };
    let shot = crate::screenshots::render_screenshot(
        &input.route,
        &req,
        input.state.as_deref(),
        || sandbox::mint(project_id),
    )
    .await
    .map_err(|err| match err {
        crate::screenshots::RenderError::Unconfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
        crate::screenshots::RenderError::UnknownViewport(_)
        | crate::screenshots::RenderError::BadSize(_)
        | crate::screenshots::RenderError::BadOverrides(_) => StatusCode::BAD_REQUEST,
        other => {
            eprintln!("design screenshot: {other}");
            StatusCode::BAD_GATEWAY
        }
    })?;
    let mut response = shot.png.into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("image/png"),
    );
    // What did not load into the picture, for a caller that wants to say so.
    if let Ok(value) = serde_json::to_string(&shot.warnings)
        .map(|w| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, w))
        .unwrap_or_default()
        .parse()
    {
        response.headers_mut().insert("x-render-warnings", value);
    }
    Ok(response)
}

/// `GET /api/design/{project}/manifest` — routes, components (with usedOn +
/// usage counts), tokens, revision stamp. The registry every consumer reads.
pub async fn get_manifest(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let files = store::list_files(project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    Ok(Json(manifest::to_json(&manifest::build(
        project_id, &files, revision,
    ))))
}

/// The project's manifest, built from the same files `get_manifest` reads, so
/// nothing derived here can disagree with what that route serves.
async fn manifest_for(project_id: i64) -> manifest::DesignManifest {
    let files = store::list_files(project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    manifest::build(project_id, &files, revision)
}

/// The manifest's route paths — the set a layout document is allowed to name.
pub(crate) async fn known_routes(project_id: i64) -> Vec<String> {
    manifest_for(project_id)
        .await
        .routes
        .iter()
        .map(|r| r.path.clone())
        .collect()
}

/// The project's arrangement, the manifest it was read against, and the layout
/// ROW's own version: the ONE loader behind the operator read (`get_layout`)
/// and the agent read (`agent_views::read_layout`), so a document can never be
/// filtered against one set of pages and reported against another.
///
/// The version is the row's own, `0` when there is no row yet — the base a
/// project's first arrangement is written from. It rides along because the row
/// is read HERE anyway: a second query for the same number could only disagree
/// with this one. It is NOT the manifest's `revision`, which is
/// `max(design_file.version)` — the fragment revision the canvas reloads on,
/// a different number answering a different question, so never swap the two.
///
/// Forgiving, like every read of this document (`layout_doc.rs`'s asymmetry).
/// A project that has never been arranged reads `default_doc()`; a stored
/// document that will not parse (hand-edited, or written by a build with a
/// different shape) degrades to the default rather than failing the read — the
/// alternative is a canvas that cannot load and no way for the operator to
/// repair it from the UI; and a document naming pages this project no longer
/// has is served with those routes filtered out, never refused.
pub(crate) async fn load_layout(
    project_id: i64,
) -> Result<(layout_doc::LayoutDoc, manifest::DesignManifest, i64), StatusCode> {
    let m = manifest_for(project_id).await;
    let known: Vec<String> = m.routes.iter().map(|r| r.path.clone()).collect();

    let stored = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // The row's own version, taken from the row read above rather than fetched
    // again. `0` for a project nobody has arranged: the number its first
    // arrangement is written from, so a reader can hand this straight back as a
    // `base_version` whether or not anything has been arranged.
    let version = stored.as_ref().map(|row| row.version).unwrap_or(0);

    // `layout_json` is the source of truth for `view` too; the same-named
    // column is a denormalised copy for admin filtering, never read back here.
    let doc = stored
        .and_then(|row| layout_doc::parse(&row.layout_json).ok())
        .unwrap_or_else(layout_doc::default_doc);

    Ok((layout_doc::filter_to_known(doc, &known), m, version))
}

/// `GET /api/design/{project}/layout` — the shared arrangement.
///
/// Always 200: a project that has never been arranged reads the default
/// document, so the client has one code path. A stored document that will not
/// parse (hand-edited, or written by a build with a different shape) degrades
/// to the default rather than failing the read — the alternative is a canvas
/// that cannot load and no way for the operator to repair it from the UI.
pub async fn get_layout(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let (doc, _manifest, _version) = load_layout(project_id).await?;
    Ok(Json(layout_doc::to_value(&doc)))
}

/// `PUT /api/design/{project}/layout` — replace the arrangement.
///
/// Last-write-wins: this is a settings document, not versioned content, so
/// there is no `base_version` 409 here (contrast `DesignFile`, where a stale
/// write would destroy an agent's work).
pub async fn put_layout(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<layout_doc::LayoutDoc>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let caller = load_caller(user_id).await?;
    let known = known_routes(project_id).await;

    let doc = layout_doc::validate(input, &known).map_err(|_| StatusCode::BAD_REQUEST)?;
    let json = layout_doc::to_json_string(&doc);
    let by = operator_attribution(&caller);

    // Read-or-create under the project's write lock, the same one `put_file`
    // takes: two racing first writes would otherwise both see no row, both
    // insert, and the loser's unique-violation 500 would discard the
    // operator's very first save.
    project_locks()
        .with_lock(project_id, || async {
            let existing = DesignLayout::objects()
                .filter(design_layout::PROJECT.eq(project_id))
                .first()
                .await
                .map_err(|err| {
                    eprintln!("design layout read: {err}");
                    StatusCode::INTERNAL_SERVER_ERROR
                })?;

            match existing {
                Some(row) => {
                    DesignLayout::objects()
                        .filter(design_layout::ID.eq(row.id))
                        .update_values(
                            json!({
                                "view": doc.view,
                                "layout_json": json,
                                "updated_by": by,
                                "updated_at": chrono::Utc::now(),
                                // No predicate on this write: the operator is
                                // looking at the board and their save wins. The
                                // number still moves so an agent holding an
                                // older one is told rather than clobbering.
                                "version": row.version + 1,
                            })
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                        )
                        .await
                        .map_err(|err| {
                            eprintln!("design layout update: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                }
                None => {
                    DesignLayout::objects()
                        .create(DesignLayout {
                            id: 0,
                            project: umbral::orm::ForeignKey::new(project_id),
                            view: doc.view,
                            layout_json: json,
                            version: 1,
                            updated_by: by,
                            created_at: None,
                            updated_at: None,
                        })
                        .await
                        .map_err(|err| {
                            eprintln!("design layout create: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                }
            }

            Ok::<(), StatusCode>(())
        })
        .await?;

    Ok(Json(layout_doc::to_value(&doc)))
}

#[derive(Debug, serde::Serialize)]
pub struct FileSummary {
    pub path: String,
    pub kind: DesignFileKind,
    pub version: i64,
    pub updated_by: String,
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
    pub bytes: usize,
}

/// `GET /api/design/{project}/files` — list with versions, no content.
pub async fn list_files(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<Vec<FileSummary>>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let rows = store::list_files(project_id).await;
    Ok(Json(
        rows.into_iter()
            .map(|f| FileSummary {
                bytes: f.content.len(),
                path: f.path,
                kind: f.kind,
                version: f.version,
                updated_by: f.updated_by,
                updated_at: f.updated_at.or(f.created_at),
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
pub struct GetFileQuery {
    pub path: String,
}

/// `GET /api/design/{project}/file?path=components/app-header.js`
pub async fn get_file(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(params): Query<GetFileQuery>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    match store::load_file(project_id, &params.path).await {
        Some(row) => Ok(Json(row).into_response()),
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// Body of `PUT /api/design/{project}/file`. `base_version` enables optimistic
/// concurrency: a stale base gets 409 + the current row back.
#[derive(Debug, Deserialize)]
pub struct WriteFileInput {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub base_version: Option<i64>,
}

pub(crate) fn rejection_response(verdict: &crate::validation::Validation) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "ok": false, "errors": verdict.errors, "warnings": verdict.warnings })),
    )
        .into_response()
}

pub(crate) fn conflict_response(row: &crate::models::DesignFile) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "ok": false,
            "error": "version_conflict",
            "message": "Another writer changed this file after your read. Re-read, merge and retry.",
            "current_version": row.version,
            "current_content": row.content,
            "updated_by": row.updated_by,
        })),
    )
        .into_response()
}

/// The layout's 409: the same shape `conflict_response` uses for a file.
pub(crate) fn conflict_response_values(current_version: i64, doc: serde_json::Value) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "ok": false,
            "error": "version_conflict",
            "message": "Someone else rearranged this board after your read. Re-read, merge and retry.",
            "current_version": current_version,
            "current_document": doc,
        })),
    )
        .into_response()
}

/// `PUT /api/design/{project}/file` — the operator's edit path. Same validator,
/// same caps, same lock as every agent write; the only difference is who is
/// standing behind it.
pub async fn put_file(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<WriteFileInput>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let caller = load_caller(user_id).await?;
    let by = operator_attribution(&caller);

    let outcome = project_locks()
        .with_lock(project_id, || async {
            store::write_file(project_id, &input.path, &input.content, input.base_version, &by)
                .await
        })
        .await;

    match outcome {
        WriteOutcome::Saved(row, verdict) => {
            // The blast radius, computed post-write: which routes changed under
            // the writer's feet because of THIS write. Warnings ride along so
            // the agent sees "this file is getting big" without a rejection.
            let affected = affected_routes_for(&row.path, project_id).await;
            let warnings = serde_json::to_value(&verdict.warnings).unwrap_or(json!([]));
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "ok": true,
                    "file": row,
                    "warnings": warnings,
                    "affected_routes": affected,
                })),
            )
                .into_response())
        }
        WriteOutcome::Rejected(v) => Ok(rejection_response(&v)),
        WriteOutcome::Conflict(row) => Ok(conflict_response(&row)),
    }
}

// ---------------------------------------------------------------------------
// #501: the page trash. Operator routes here; the agent's DELETE is
// `agent_views::trash_page`. Both go through `trash_page_by_route`.
// ---------------------------------------------------------------------------

/// Trash the page serving `route`, under the project lock, and announce it.
/// `Err(NOT_FOUND)` for a route with no live page, `Err(BAD_REQUEST)` for a
/// route no page file could serve.
pub(crate) async fn trash_page_by_route(
    project_id: i64,
    route: &str,
) -> Result<(String, i64), StatusCode> {
    let path = manifest::page_path_for_route(route).ok_or(StatusCode::BAD_REQUEST)?;
    let lock_path = path.clone();
    let id = project_locks()
        .with_lock(project_id, || async move { store::trash_file(project_id, &lock_path).await })
        .await
        .ok_or(StatusCode::NOT_FOUND)?;
    // Sent by the writer, after the lock: the ORM's delete payload has no
    // `project` to route by (backend/src/realtime.rs, DESIGN_FILES). Id-only;
    // the chrome refetches the manifest, which no longer lists the page.
    Realtime::to_group(signals::files_group(project_id))
        .send("deleted", &json!({ "id": id }))
        .await;
    Ok((path, id))
}

#[derive(Debug, Deserialize)]
pub struct PageRouteQuery {
    pub route: String,
}

/// `DELETE /api/design/{project}/page?route=/x` — the operator trashes a page.
/// Restorable from `GET .../trash` + `POST .../trash/restore`.
pub async fn trash_page(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(query): Query<PageRouteQuery>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let (path, _) = trash_page_by_route(project_id, &query.route).await?;
    Ok((StatusCode::OK, Json(json!({ "ok": true, "trashed": path, "route": query.route }))).into_response())
}

/// `GET /api/design/{project}/trash` — trashed files, most recent first. The
/// content is left out: the list is for choosing what to restore.
pub async fn list_trash(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let rows: Vec<serde_json::Value> = store::list_trashed(project_id)
        .await
        .into_iter()
        .map(|row| {
            json!({
                "path": row.path,
                "route": manifest::route_for_page(&row.path),
                "kind": row.kind,
                "updated_by": row.updated_by,
                "deleted_at": row.deleted_at,
                "bytes": row.content.len(),
            })
        })
        .collect();
    Ok((StatusCode::OK, Json(json!({ "files": rows }))).into_response())
}

#[derive(Debug, Deserialize)]
pub struct RestoreInput {
    pub path: String,
}

/// `POST /api/design/{project}/trash/restore` `{path}` — bring a trashed file
/// back. 404 when it is not in the trash; the caps' own 400 when restoring
/// would breach one.
pub async fn restore_trashed(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<RestoreInput>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let path = input.path.clone();
    let outcome = project_locks()
        .with_lock(project_id, || async move { store::restore_file(project_id, &path).await })
        .await;
    match outcome {
        Ok(id) => {
            Realtime::to_group(signals::files_group(project_id))
                .send("updated", &json!({ "id": id }))
                .await;
            Ok((StatusCode::OK, Json(json!({ "ok": true, "restored": input.path }))).into_response())
        }
        Err(store::RestoreError::NotInTrash) => Err(StatusCode::NOT_FOUND),
        Err(store::RestoreError::Rejected(v)) => Ok(rejection_response(&v)),
    }
}

/// Routes whose rendered output depends on `path`: the file's own route for a
/// page, EVERY route for tokens, or the routes using a component. Powers the
/// "`app-header updated; N routes changed`" response line and the chrome's
/// reload decision.
pub async fn affected_routes_for(path: &str, project_id: i64) -> Vec<String> {
    let files = store::list_files(project_id).await;
    let m = manifest::build(project_id, &files, 0);
    match DesignFileKind::for_path(path) {
        Some(DesignFileKind::Page) => manifest::route_for_page(path).into_iter().collect(),
        Some(DesignFileKind::Token) => m.routes.iter().map(|r| r.path.clone()).collect(),
        Some(DesignFileKind::Component) => {
            let name = path
                .strip_prefix("components/")
                .and_then(|p| p.strip_suffix(".js"));
            name.map(|n| {
                m.components
                    .iter()
                    .find(|c| c.name == n)
                    .map(|c| c.used_on.clone())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ListCommentsQuery {
    #[serde(default)]
    pub status: Option<String>,
    /// Filter to one route when given (`/settings`).
    #[serde(default)]
    pub page_path: Option<String>,
}

/// `GET /api/design/{project}/comments?status=open&page_path=/settings`
pub async fn list_comments(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(params): Query<ListCommentsQuery>,
) -> Result<Json<Vec<DesignComment>>, StatusCode> {
    ensure_member(user_id, project_id).await?;
    let mut query = DesignComment::objects().filter(design_comment::PROJECT.eq(project_id));
    if let Some(status) = params
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        query = query.filter(design_comment::STATUS.eq(status));
    }
    if let Some(page) = params
        .page_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        query = query.filter(design_comment::PAGE_PATH.eq(page));
    }
    let rows = query
        .order_by(design_comment::ID.desc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows))
}

/// What a client may say when creating a comment. Everything anchoring-related
/// comes from the picker capture; there is deliberately no `author`, `status`
/// or `project` field to forge.
#[derive(Debug, Deserialize)]
pub struct CreateCommentInput {
    pub page_path: String,
    #[serde(default)]
    pub component_name: Option<String>,
    pub element_path: String,
    #[serde(default)]
    pub src_ref: Option<String>,
    #[serde(default)]
    pub viewport: Option<String>,
    /// `{x,y,w,h}` at capture time.
    pub rect: serde_json::Value,
    #[serde(default)]
    pub snippet: Option<String>,
    pub body: String,
    /// Defaults to `instance` — the reversible choice (§9.5).
    #[serde(default)]
    pub scope: Option<CommentScope>,
}

const MAX_SNIPPET_CHARS: usize = 600;
const MAX_BODY_CHARS: usize = 4000;

/// `POST /api/design/{project}/comments`
pub async fn create_comment(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<CreateCommentInput>,
) -> Result<(StatusCode, Json<DesignComment>), StatusCode> {
    ensure_member(user_id, project_id).await?;
    let caller = load_caller(user_id).await?;

    let body = input.body.trim().to_string();
    if body.is_empty() || input.element_path.trim().is_empty() || input.page_path.trim().is_empty()
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let comment = DesignComment::objects()
        .create(DesignComment {
            id: 0,
            project: umbral::orm::ForeignKey::new(project_id),
            page_path: input.page_path.trim().to_string(),
            component_name: input.component_name.clone(),
            element_path: input.element_path.trim().chars().take(500).collect(),
            src_ref: input.src_ref.clone(),
            viewport: input.viewport.clone().unwrap_or_else(|| "laptop".into()),
            rect: input.rect.to_string(),
            snippet: input
                .snippet
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(MAX_SNIPPET_CHARS)
                .collect::<String>(),
            body: body.chars().take(MAX_BODY_CHARS).collect(),
            scope: input.scope.unwrap_or(CommentScope::Instance),
            status: CommentStatus::Open,
            thread_id: None,
            author: operator_attribution(&caller),
            resolution_note: None,
            orphaned: false,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::CREATED, Json(comment)))
}

/// PATCH body: status and/or body text, plus the agent's note when marking
/// addressed. Marking addressed without a note records a placeholder rather
/// than letting an empty resolution reach the review toast.
#[derive(Debug, Default, Deserialize)]
pub struct UpdateCommentInput {
    #[serde(default)]
    pub status: Option<CommentStatus>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub scope: Option<CommentScope>,
    #[serde(default)]
    pub resolution_note: Option<String>,
    #[serde(default)]
    pub orphaned: Option<bool>,
}

/// `PATCH /api/design/{project}/comments/{id}` — status / body transitions.
pub async fn update_comment(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, comment_id)): Path<(i64, i64)>,
    Json(input): Json<UpdateCommentInput>,
) -> Result<Json<DesignComment>, StatusCode> {
    ensure_member(user_id, project_id).await?;

    let mut row = DesignComment::objects()
        .filter(
            design_comment::PROJECT.eq(project_id) & design_comment::ID.eq(comment_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    if let Some(status) = input.status {
        row.status = status;
        if status == CommentStatus::Addressed && row.resolution_note.is_none() {
            row.resolution_note = Some("Addressed.".into());
        }
    }
    if let Some(scope) = input.scope {
        row.scope = scope;
    }
    if let Some(body) = input
        .body
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
    {
        row.body = body.chars().take(MAX_BODY_CHARS).collect();
    }
    if let Some(note) = input
        .resolution_note
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
    {
        row.resolution_note = Some(note.chars().take(2000).collect());
    }
    if let Some(orphaned) = input.orphaned {
        row.orphaned = orphaned;
    }

    let saved = DesignComment::objects()
        .save(row)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(saved))
}

// ---------------------------------------------------------------------------
// SSE — design events for one project
// ---------------------------------------------------------------------------

/// Per-connection event buffer, same sizing rationale as the agent stream:
/// bursty but small; a slow client that fills it is dropped by the hub.
const DESIGN_STREAM_BUFFER: usize = 64;

/// Removes the connection from the realtime hub when the stream drops.
/// `deregister` is async and Drop is not, so it spawns — the server runtime is
/// always present when a response body drops. Same guard as the agent stream.
struct StreamGuard {
    registry: std::sync::Arc<umbral_realtime::Registry>,
    conn_id: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let registry = self.registry.clone();
        let id = self.conn_id;
        tokio::spawn(async move {
            registry.deregister(id).await;
        });
    }
}

/// `GET /api/design/{project}/events` — SSE: file changed, manifest changed,
/// comment updated.
///
/// Registers directly with the realtime hub (same shape as the agent event
/// stream): the groups here are derived server-side from the authenticated
/// caller's membership, so the caller can never ask for another project's
/// stream and no group-policy widening is required.
///
/// Events ride the `design_files` / `design_comments` / `design_layout` model
/// groups (the app's realtime wiring exposes those models); each frame ships
/// under the single `u` envelope type with `{"c","e","d"}` data, matching every
/// other client in this app.
pub async fn design_events(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Response, StatusCode> {
    use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};

    if !Realtime::is_installed() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    ensure_member(user_id, project_id).await?;

    let mut groups = HashSet::new();
    groups.insert(signals::files_group(project_id));
    groups.insert(format!("project:{project_id}:design_comments"));
    groups.insert(signals::layout_group(project_id));

    let registry = Realtime::registry();
    let (conn_id, rx) = registry
        .register(None, groups, DESIGN_STREAM_BUFFER)
        .await
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let guard = StreamGuard { registry, conn_id };

    let stream = ReceiverStream::new(rx).map(move |event| {
        let _guard = &guard;
        Ok::<_, std::convert::Infallible>(SseEvent::default().event("u").data(
            json!({ "c": event.channel, "e": event.event, "d": event.data }).to_string(),
        ))
    });

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

// ---------------------------------------------------------------------------
// Sandbox-facing handlers — token-granted, origin-isolated, no cookies
// ---------------------------------------------------------------------------

/// The headers every token-granted sandbox response that SERVES something
/// carries, whatever its body: it must not be kept (`no-store` — tokens outlive
/// nothing), must not be indexed (`x-robots-tag: noindex`), and must not hand
/// its own URL to another origin (`referrer-policy: no-referrer`).
///
/// "That serves something" is not a hedge. A request that verifies its token and
/// then misses — an unknown path prefix, or a row that does not exist — returns
/// a bare 404 with none of the three (`serve_file`'s two early returns), and one
/// of those misses is past the point where the headers could have been applied.
/// Nothing is lost by that: a 404 has no body to pull a subresource in, so there
/// is no URL for a `Referer` to carry and nothing to cache or index. The claim
/// this comment used to make — EVERY response, whatever its body — was broader
/// than the code, which is the class this phase has corrected more than any
/// other.
///
/// `no-referrer` is not polish, and it does not fix a leak that fires today: the
/// sandbox URL IS the credential (`/s/{token}/…`), but under the current browser
/// default `strict-origin-when-cross-origin` a cross-origin subresource request
/// gets the ORIGIN only — no path, so no token. A token-bearing cross-origin
/// `Referer` needs an engine whose default is `no-referrer-when-downgrade`, or a
/// future `unsafe-url`. The header is here because the URL is a secret and the
/// secrecy of a secret should not rest on a browser default; it is what makes
/// the intent `no-store` and `noindex` already express true for whatever origin
/// the response's own content pulls in — an external image or media source, or
/// a `url(https://…)` inside a served stylesheet, which is fetched under the
/// STYLESHEET's response headers and not the page's.
fn apply_token_response_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
}

/// Apply the sandbox HTML response headers: the shared token-hygiene headers
/// above, the HTML content type, and the tight CSP (connect-src self + Tailwind
/// CDN only — without it agent-authored JS could fetch the operator's
/// localhost; `script-src`/`style-src`/`font-src`/`img-src`/`media-src`
/// additionally allow any `https:` origin for the project's external resources
/// — see [`composer::sandbox_csp`]).
///
/// Both HTML sandbox routes go through here — the composed page and the
/// component preview — so a header added here is a header added to both. The
/// third sandbox read, `GET /s/{token}/f/{*path}`, does NOT: it is served by
/// [`serve_file`], which calls [`apply_token_response_headers`] itself in both
/// of its branches.
fn apply_sandbox_headers(response: &mut Response, token: &str) {
    apply_token_response_headers(response);
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    if let Ok(csp) = composer::sandbox_csp(token).parse() {
        headers.insert("content-security-policy", csp);
    }
}

/// Pull `state=` out of a raw query string. Values we mint percent-encode ':'
/// (`dialog%3Aconfirm-delete`); decode just enough for that shape without
/// pulling a URL crate in.
fn extract_state_param(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == "state" {
            let raw = kv.next().unwrap_or("");
            let decoded = raw
                .replace("%3A", ":")
                .replace("%3a", ":")
                .replace("%2F", "/")
                .replace("%2f", "/");
            return Some(decoded);
        }
    }
    None
}

/// `GET /s/{token}/preview/{name}` — one component rendered in isolation
/// against the project's tokens. Powers the registry's live previews in the
/// chrome's left panel: same shell, same picker-free runtime (the preview is
/// display-only), no page required.
pub async fn serve_component_preview(
    Path((token, name)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    let Some(project_id) = sandbox::verify(&token) else {
        return Err(StatusCode::NOT_FOUND);
    };
    // Custom-element names: lowercase + hyphens. Anything else is not a
    // registered component and has nothing to preview.
    if !crate::validation::is_valid_component_name(&name) {
        return Err(StatusCode::NOT_FOUND);
    }
    let files = store::list_files(project_id).await;
    let Some(component_row) = files.iter().find(|f| f.path == format!("components/{name}.js")) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let _ = component_row;

    let mut m = manifest::build(
        project_id,
        &files
            .iter()
            .filter(|f| f.kind == DesignFileKind::Component || f.kind == DesignFileKind::Token)
            .cloned()
            .collect::<Vec<_>>(),
        0,
    );
    // Only the requested element is instantiated.
    m.components.retain(|c| c.name == name);

    let html = composer::compose_document(
        &token,
        &m,
        "/",
        "preview",
        &format!("<div class=\"p-2\"><{name} title=\"Preview\"></{name}></div>"),
        &file_versions(&files),
        "light",
        None,
    );
    let mut response = html.into_response();
    apply_sandbox_headers(&mut response, &token);
    Ok(response)
}

/// Content type per served extension.
fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

/// `GET /s/{token}/{route}` (plus the bare `/s/{token}` root) — the composed
/// document for one route. The full HTML shell is generated here, per request:
/// identical head, tokens, components and picker on every page, forever.
///
/// `?state=` reaches screenshot review: `state=dialog:confirm-delete` makes the
/// composer open that overlay on load, so UI that only exists after a click is
/// still reviewable by an agent that cannot click.
pub async fn serve_page(
    Path((token, route)): Path<(String, String)>,
    req: Request,
) -> Result<Response, StatusCode> {
    serve_sandbox_page(&token, &route, req.uri().query()).await
}

/// The bare root: `/s/{token}` and its SlashRedirect target `/s/{token}/` carry
/// only ONE path parameter, so they get their own extractor shape.
pub async fn serve_page_root(Path(token): Path<String>, req: Request) -> Result<Response, StatusCode> {
    serve_sandbox_page(&token, "", req.uri().query()).await
}

async fn serve_sandbox_page(
    token: &str,
    route: &str,
    query: Option<&str>,
) -> Result<Response, StatusCode> {
    let Some(project_id) = sandbox::verify(token) else {
        return Err(StatusCode::NOT_FOUND);
    };
    // #522: the comparison grid. A page route can never contain a dot, so this
    // cannot shadow a real page.
    if route == crate::compare::GRID_ROUTE {
        let spec = query
            .and_then(|q| query_param(q, "spec"))
            .ok_or(StatusCode::BAD_REQUEST)
            .and_then(|raw| crate::compare::decode_spec(raw).map_err(|_| StatusCode::BAD_REQUEST))?;
        let mut response = crate::compare::grid_html(token, &spec).into_response();
        apply_sandbox_headers(&mut response, token);
        return Ok(response);
    }
    let state = query.and_then(extract_state_param);
    // #522: unsaved token/CSS overrides, re-validated on the way in.
    let overrides = match query.and_then(|q| query_param(q, "ov")) {
        Some(raw) => crate::compare::decode(raw).map_err(|_| StatusCode::BAD_REQUEST)?,
        None => crate::compare::Overrides::default(),
    };
    // `?theme=dark` renders the page dark from the first byte, the same
    // `data-theme` the canvas sets with `design:theme` after load — so a
    // screenshot has no light first paint to catch. Anything else is light.
    let theme = match query.and_then(|q| query_param(q, "theme")) {
        Some("dark") => "dark",
        _ => "light",
    };

    let files = store::list_files(project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(project_id, &files, revision);

    let normalized = if route.is_empty() || route == "/" {
        "/".to_string()
    } else {
        format!("/{route}")
    };
    let Some(page_path) = manifest::page_path_for_route(&normalized) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let Some(fragment) = files.iter().find(|f| f.path == page_path) else {
        return Err(StatusCode::NOT_FOUND);
    };

    let html = composer::compose_document(
        token,
        &m,
        &normalized,
        &page_path,
        &fragment.content,
        &file_versions(&files),
        theme,
        state.as_deref(),
    );
    let html = crate::compare::inject(html, &overrides);

    let mut response = html.into_response();
    apply_sandbox_headers(&mut response, token);
    Ok(response)
}

/// The raw value of `name` in a query string, if present.
fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then_some(value)
    })
}

/// `?v=` out of a raw query string — the revision a sandbox subresource URL
/// names. `None` when absent or not a number, which is the case that keeps a
/// response uncacheable: a URL with no revision pins no content, so there is
/// nothing a cache entry could be trusted to mean later.
fn version_param(query: Option<&str>) -> Option<i64> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("v="))
        .and_then(|raw| raw.parse().ok())
}

/// The project's `(path, version)` pairs, the projection
/// [`composer::compose_document`] stamps subresource URLs from. Built once per
/// compose from the same `files` snapshot the manifest came from, so a URL can
/// never name a revision the document was not composed against.
fn file_versions(files: &[DesignFile]) -> Vec<(String, i64)> {
    files.iter().map(|f| (f.path.clone(), f.version)).collect()
}

/// Token-hygiene headers for a served subresource, plus a bounded cache
/// lifetime when the URL is revision-pinned.
///
/// `?v=` is what makes a sandbox subresource cacheable at all. The composer
/// stamps every component and `tokens.css` URL with the revision it serves, so
/// the URL→bytes mapping is immutable for as long as it is asked for and a
/// changed file arrives under a changed URL. That buys the reuse the design
/// canvas needs: one frame holds an iframe per artboard, every artboard pulls
/// the same component files, and without this each of them re-downloaded all
/// of them from scratch.
///
/// `no-store` stays the rule for everything else — the composed documents and
/// the component preview, and any subresource request that arrives WITHOUT
/// `?v=`. Bounding `max-age` by [`sandbox::remaining_secs`] keeps the original
/// promise exactly as it was: no cache entry outlives the grant that fetched
/// it. `private` keeps a token-bearing URL out of any shared cache; the token
/// is the credential, and only the browser that was granted it may hold it.
fn apply_subresource_headers(response: &mut Response, token: &str, versioned: bool) {
    apply_token_response_headers(response);
    if !versioned {
        return;
    }
    if let Some(secs) = sandbox::remaining_secs(token) {
        if let Ok(value) = HeaderValue::from_str(&format!("private, max-age={secs}")) {
            response.headers_mut().insert(CACHE_CONTROL, value);
        }
    }
}

/// `GET /s/{token}/f/{path}` — serve tokens.css / components/*.js / assets.
/// Read-only, token-granted; pages are never served raw (they compose).
///
/// Carries the same token-hygiene headers as the HTML routes, via
/// `apply_token_response_headers` — applied in BOTH branches below, because a
/// stylesheet's own subresources (`url(https://…)`) are fetched under this
/// response's policy, not the page's, and this response names the token too.
///
/// A request carrying `?v={revision}` — which is every URL the composer emits
/// for these paths — additionally gets a bounded cache lifetime; see
/// [`apply_subresource_headers`]. A request without it is served `no-store`,
/// exactly as before.
pub async fn serve_file(
    Path((token, path)): Path<(String, String)>,
    req: Request,
) -> Result<Response, StatusCode> {
    let Some(project_id) = sandbox::verify(&token) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let versioned = version_param(req.uri().query()).is_some();

    if !path.starts_with("styles/")
        && !path.starts_with("components/")
        && !path.starts_with("assets/")
    {
        return Err(StatusCode::NOT_FOUND);
    }

    // `styles/tokens.css` is GENERATED from the `styles/tokens.json` source
    // when that row exists; only a project that has never migrated off
    // hand-authored CSS falls through to serving the legacy row verbatim.
    if path == "styles/tokens.css" {
        if let Some(css) = generated_tokens_css(project_id).await {
            let mut response = css.into_response();
            apply_subresource_headers(&mut response, &token, versioned);
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("text/css; charset=utf-8"));
            return Ok(response);
        }
    }

    let row = store::load_file(project_id, &path)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut response = if path.starts_with("assets/") {
        // Raster assets may be stored base64-wrapped (`data:<mime>;base64,…`)
        // because the storage column is TEXT; decode on serve. SVG ships as
        // plain text like any other file.
        decoded_asset_bytes(&row.content)
            .unwrap_or_else(|| row.content.clone().into_bytes())
            .into_response()
    } else {
        row.content.into_response()
    };

    apply_subresource_headers(&mut response, &token, versioned);
    if let Ok(ct) = content_type_for(&path).parse() {
        response.headers_mut().insert(CONTENT_TYPE, ct);
    }
    Ok(response)
}

/// Build the generated `tokens.css` from the `styles/tokens.json` source row,
/// if one exists. Returns `None` (never a hard error) when there is no json
/// row, so callers fall back to serving the legacy hand-authored
/// `styles/tokens.css` row unchanged. A json row that fails to parse is
/// treated the same as absent — Task 2's write-time validation is what keeps
/// stored rows well-formed; a serve-time failure here should degrade to the
/// legacy fallback rather than 500.
async fn generated_tokens_css(project_id: i64) -> Option<String> {
    let row = store::load_file(project_id, "styles/tokens.json").await?;
    let doc: TokensDoc = serde_json::from_str(&row.content).ok()?;
    Some(tokens_json_to_css(&doc))
}

/// `GET /api/design/{project}/tokens.css` — chrome-facing download of the
/// generated tokens stylesheet (same source as the sandbox serve path: the
/// `styles/tokens.json` row when present, else the legacy `styles/tokens.css`
/// row). Same membership gate as the other `/api/design/{project}/...` reads.
pub async fn export_tokens_css(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;

    let css = match generated_tokens_css(project_id).await {
        Some(css) => css,
        None => store::load_file(project_id, "styles/tokens.css")
            .await
            .map(|row| row.content)
            .ok_or(StatusCode::NOT_FOUND)?,
    };

    let mut response = css.into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/css; charset=utf-8"));
    headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"tokens.css\""),
    );
    Ok(response)
}

#[derive(Debug, Deserialize)]
pub struct ExportPageHtmlQuery {
    pub route: String,
    #[serde(default)]
    pub fragment: Option<String>,
}

/// `GET /api/design/{project}/page.html?route=<route>&fragment=<0|1>` —
/// chrome-facing, SELF-CONTAINED copy/download of one route's composed HTML.
/// Unlike the sandbox document ([`composer::compose_document`], which only
/// works behind the `/s/{token}/f/...` file server), this export inlines the
/// generated tokens CSS and every component's JS
/// ([`composer::compose_export_document`]) and drops the picker runtime and
/// `data-src` annotations entirely, so the download renders correctly opened
/// straight off disk with no server behind it. `<ui-*>` primitives are still
/// expanded to real markup ([`composer::compose_export_body`]).
/// Same membership gate as the other `/api/design/{project}/...` reads.
///
/// `fragment=1` returns ONLY the expanded body markup (`text/html`, inline,
/// no `data-src`) — meant for pasting elsewhere, never wrapped in the
/// document shell. The default returns the full standalone document as a
/// download (`Content-Disposition: attachment`).
pub async fn export_page_html(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(params): Query<ExportPageHtmlQuery>,
) -> Result<Response, StatusCode> {
    ensure_member(user_id, project_id).await?;

    let normalized = if params.route.is_empty() || params.route == "/" {
        "/".to_string()
    } else if let Some(stripped) = params.route.strip_prefix('/') {
        format!("/{stripped}")
    } else {
        format!("/{}", params.route)
    };
    let Some(page_path) = manifest::page_path_for_route(&normalized) else {
        return Err(StatusCode::NOT_FOUND);
    };

    let files = store::list_files(project_id).await;
    let Some(page_file) = files.iter().find(|f| f.path == page_path) else {
        return Err(StatusCode::NOT_FOUND);
    };

    let is_fragment = matches!(params.fragment.as_deref(), Some("1") | Some("true"));

    if is_fragment {
        let body = composer::compose_export_body(&page_file.content);
        let mut response = body.into_response();
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        return Ok(response);
    }

    // Same generator the `/api/design/{project}/tokens.css` export uses
    // (`styles/tokens.json` row when present, else the legacy hand-authored
    // `styles/tokens.css` row) — never a raw file read, and never a hard
    // 404 here: a page with no tokens configured yet still exports.
    let tokens_css = match generated_tokens_css(project_id).await {
        Some(css) => css,
        None => store::load_file(project_id, "styles/tokens.css")
            .await
            .map(|row| row.content)
            .unwrap_or_default(),
    };

    let components: Vec<(String, String)> = files
        .iter()
        .filter(|f| f.kind == DesignFileKind::Component)
        .filter_map(|f| {
            f.path
                .strip_prefix("components/")
                .and_then(|p| p.strip_suffix(".js"))
                .map(|name| (name.to_string(), f.content.clone()))
        })
        .collect();

    // The project's external resources (web fonts and their companion links),
    // derived the SAME way the sandbox document derives them — the one
    // `manifest::resources_from`, which `manifest::build` calls for its own
    // `resources` field — so the download cannot drift from the artboard: a font
    // that renders in the preview ships in page.html. Called directly rather
    // than through `build`, which would scan every page fragment once per
    // registered component for a `usedOn` this response does not read.
    let resources = manifest::resources_from(&files);

    let html = composer::compose_export_document(
        &page_path,
        &page_file.content,
        "light",
        &tokens_css,
        &components,
        &resources,
    );

    let filename = safe_filename_for_route(&normalized);
    let mut response = html.into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}.html\""))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    Ok(response)
}

/// Sanitize a route to a filesystem-safe download filename stem: `/` →
/// `index`, `/pricing` → `pricing`. [`manifest::page_path_for_route`] already
/// rejects routes with nested slashes, so a plain leaf name is all this needs
/// to produce.
fn safe_filename_for_route(route: &str) -> String {
    let trimmed = route.trim_matches('/');
    if trimmed.is_empty() {
        "index".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Decode `data:<mime>;base64,<payload>` into bytes; plain content passes
/// through unchanged.
fn decoded_asset_bytes(content: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let rest = content.strip_prefix("data:")?;
    let (_mime, b64) = rest.split_once(";base64,")?;
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()
}
