//! Agent-authed handlers — the surface the MCP design tools call.
//!
//! Trust model (mirrors every other `*_as_agent` handler): the caller is an
//! authenticated agent credential whose project is DERVED from the credential,
//! never from the request. A tool that names another project is refused, so a
//! compromised key cannot read or write a sibling workspace's design.
//!
//! The higher-friction writes (§8) are enforced HERE, not only in the tool
//! description: component and token writes REQUIRE a non-empty `reason`, and
//! every success response tells the agent exactly which routes it just touched.

use serde::Deserialize;
use serde_json::json;

use umbral::web::{IntoResponse, Json, Path, Query, Response, StatusCode};
use taskflow_agents::agent_auth::RequireAgent;

use crate::manifest;
use crate::models::{CommentStatus, DesignComment, DesignFileKind, design_comment};
use crate::store::{self, WriteOutcome};
use crate::validation;
use crate::views::{conflict_response, project_locks, rejection_response};

/// The project the agent may act on: its own credential's project. Any other
/// value in the request is a refusal, not a routing hint.
fn authorized_project(agent: &taskflow_agents::agent_auth::AgentIdentity, requested: i64) -> Result<(), StatusCode> {
    if agent.project_id == requested {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

async fn load_files(project_id: i64) -> Vec<crate::models::DesignFile> {
    store::list_files(project_id).await
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentContextQuery {
    /// The tool's `project` argument; must equal the credential's project.
    pub project: i64,
}

/// `GET /api/taskflow/agents/design/context` — everything `design_get_tokens`
/// and `design_list_components` need, in one read: the tokens css + parsed
/// scale, the component registry with usage, and the routes.
pub async fn context(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentContextQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let files = load_files(agent.project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(agent.project_id, &files, revision);
    let tokens_css = files
        .iter()
        .find(|f| f.kind == DesignFileKind::Token)
        .map(|f| f.content.clone())
        .unwrap_or_default();

    Ok(Json(json!({
        "tokens_css": tokens_css,
        "tokens": manifest::to_json(&m)["tokens"],
        "components": manifest::to_json(&m)["components"],
        "routes": manifest::to_json(&m)["routes"],
        "revision": revision,
        "note": "Always call design_get_tokens before your first design write: colour and \
                 spacing MUST come from this scale."
    })))
}

#[derive(Debug, Deserialize)]
pub struct ReadPageQuery {
    pub project: i64,
    /// `/`, `/settings`, …
    pub route: String,
}

/// `GET /api/taskflow/agents/design/page` — the raw fragment + its version.
pub async fn read_page(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<ReadPageQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let Some(path) = manifest::page_path_for_route(&q.route) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    match store::load_file(agent.project_id, &path).await {
        Some(row) => Ok(Json(json!({
            "route": q.route,
            "path": row.path,
            "content": row.content,
            "version": row.version,
            "updated_by": row.updated_by,
        }))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Debug, Deserialize)]
pub struct ReadComponentQuery {
    pub project: i64,
    pub name: String,
}

/// `GET /api/taskflow/agents/design/component` — source + blast radius.
pub async fn read_component(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<ReadComponentQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let path = format!("components/{}.js", q.name.trim());
    // Reject names that would escape the components dir via the validator.
    validation::validate_path(&path).map_err(|_| StatusCode::BAD_REQUEST)?;
    let files = load_files(agent.project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(agent.project_id, &files, revision);
    let entry = m.components.iter().find(|c| c.name == q.name.trim());
    match store::load_file(agent.project_id, &path).await {
        Some(row) => Ok(Json(json!({
            "name": q.name.trim(),
            "path": row.path,
            "content": row.content,
            "version": row.version,
            "used_on": entry.map(|e| e.used_on.clone()).unwrap_or_default(),
            "usage_count": entry.map(|e| e.usage_count).unwrap_or(0),
        }))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentWritePageInput {
    pub project: i64,
    pub route: String,
    pub html: String,
    #[serde(default)]
    pub base_version: Option<i64>,
}

/// `PUT /api/taskflow/agents/design/page`
pub async fn write_page(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentWritePageInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let path = manifest::page_path_for_route(input.route.trim())
        .ok_or(StatusCode::BAD_REQUEST)?;
    agent_write(
        agent.project_id,
        &format!("{} ({})", agent.display_name, agent.agent_id),
        &path,
        &input.html,
        input.base_version,
    )
    .await
}

#[derive(Debug, Deserialize)]
pub struct AgentWriteComponentInput {
    pub project: i64,
    pub name: String,
    pub js: String,
    #[serde(default)]
    pub base_version: Option<i64>,
    pub reason: String,
}

/// `PUT /api/taskflow/agents/design/component` — heavier by design: a required
/// `reason` makes the agent state WHY the registry must change.
pub async fn write_component(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentWriteComponentInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let name = input.name.trim();
    let reason = input.reason.trim();
    if name.is_empty() || reason.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if reason.len() < 8 {
        return Ok((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "ok": false,
                "errors": [{
                    "line": 0,
                    "rule": "missing-reason",
                    "message": "design_write_component requires a real `reason`: what is missing \
                                from the registry that pages cannot express without it?"
                }]
            })),
        )
            .into_response());
    }
    let path = format!("components/{name}.js");
    agent_write(
        agent.project_id,
        &format!("{} ({})", agent.display_name, agent.agent_id),
        &path,
        &input.js,
        input.base_version,
    )
    .await
}

#[derive(Debug, Deserialize)]
pub struct AgentWriteTokensInput {
    pub project: i64,
    pub css: String,
    pub reason: String,
}

/// `PUT /api/taskflow/agents/design/tokens` — touches EVERY route, so it is the
/// highest-friction write: required reason, and the response names all routes.
pub async fn write_tokens(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentWriteTokensInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() < 8 {
        return Ok((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "ok": false,
                "errors": [{
                    "line": 0,
                    "rule": "missing-reason",
                    "message": "design_write_tokens requires a real `reason` — tokens touch \
                                every page and every component at once."
                }]
            })),
        )
            .into_response());
    }
    agent_write(
        agent.project_id,
        &format!("{} ({})", agent.display_name, agent.agent_id),
        "styles/tokens.css",
        &input.css,
        None,
    )
    .await
}

/// Shared write path for agent tools: same lock, validator, caps and conflict
/// semantics as operator writes — plus the human-readable blast-radius line.
async fn agent_write(
    project_id: i64,
    by: &str,
    path: &str,
    content: &str,
    base_version: Option<i64>,
) -> Result<Response, StatusCode> {
    let outcome = project_locks()
        .with_lock(project_id, || async {
            store::write_file(project_id, path, content, base_version, by).await
        })
        .await;

    match outcome {
        WriteOutcome::Saved(row, verdict) => {
            let affected = crate::views::affected_routes_for(&row.path, project_id).await;
            let subject = row.path.split('/').next_back().unwrap_or(&row.path);
            let line = if affected.is_empty() {
                format!("{subject} written.")
            } else {
                format!(
                    "{subject} written; {} route(s) changed: {}",
                    affected.len(),
                    affected.join(", ")
                )
            };
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "ok": true,
                    "file": row,
                    "warnings": verdict.warnings,
                    "affected_routes": affected,
                    "note": line,
                })),
            )
                .into_response())
        }
        WriteOutcome::Rejected(v) => Ok(rejection_response(&v)),
        WriteOutcome::Conflict(row) => Ok(conflict_response(&row)),
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentScreenshotQuery {
    pub project: i64,
    pub route: String,
    #[serde(default = "default_viewport")]
    pub viewport: String,
    #[serde(default)]
    pub state: Option<String>,
}

fn default_viewport() -> String {
    "laptop".to_string()
}

/// `GET /api/taskflow/agents/design/screenshot` — render one route and return
/// `{png_base64}`. The MCP tool surfaces it as image content so the agent can
/// actually look at its own work. 503 when the renderer is not configured.
pub async fn screenshot(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentScreenshotQuery>,
) -> Result<Response, StatusCode> {
    use base64::Engine as _;
    authorized_project(&agent, q.project)?;
    let png = match crate::screenshots::render_screenshot(
        &q.route,
        &q.viewport,
        q.state.as_deref(),
        || crate::sandbox::mint(agent.project_id),
    )
    .await
    {
        Ok(png) => png,
        Err(crate::screenshots::RenderError::Unconfigured(what)) => {
            // Tell the agent exactly what to ask the operator for.
            return Ok((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "detail": format!(
                        "Screenshot renderer not configured on this backend ({what}). Ask your human to set it up."
                    ),
                })),
            )
                .into_response());
        }
        Err(crate::screenshots::RenderError::UnknownViewport(id)) => {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({ "detail": format!("Unknown viewport '{id}'.") })),
            )
                .into_response());
        }
        Err(other) => {
            eprintln!("design agent screenshot: {other}");
            return Ok((
                StatusCode::BAD_GATEWAY,
                Json(json!({ "detail": other.to_string() })),
            )
                .into_response());
        }
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(Json(json!({
        "route": q.route,
        "viewport": q.viewport,
        "mime": "image/png",
        "png_base64": b64,
    }))
    .into_response())
}

// ---------------------------------------------------------------------------
// Comments as structured targets
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentListCommentsQuery {
    pub project: i64,
    #[serde(default)]
    pub status: Option<String>,
}

/// `GET /api/taskflow/agents/design/comments` — open comments as STRUCTURED
/// TARGETS: file + element path + blast radius per comment (§9.5 payload).
pub async fn list_comments_as_targets(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentListCommentsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let status = q.status.unwrap_or_else(|| "open".to_string());
    let rows = DesignComment::objects()
        .filter(
            design_comment::PROJECT.eq(agent.project_id) & design_comment::STATUS.eq(status.as_str()),
        )
        .order_by(design_comment::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let files = load_files(agent.project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(agent.project_id, &files, revision);

    let targets: Vec<serde_json::Value> = rows
        .iter()
        .map(|c| {
            let used_on: Vec<String> = c
                .component_name
                .as_deref()
                .and_then(|name| m.components.iter().find(|comp| comp.name == name))
                .map(|entry| entry.used_on.clone())
                .unwrap_or_default();
            json!({
                "commentId": format!("cm_{:04x}", c.id),
                "target": {
                    "route": c.page_path,
                    "kind": c.scope,
                    "file": c.component_name.as_deref()
                        .map(|n| format!("components/{n}.js"))
                        .unwrap_or_else(|| manifest::page_path_for_route(&c.page_path)
                            .unwrap_or(c.page_path.clone())),
                    "component": c.component_name,
                    "elementPath": c.element_path,
                    "src": c.src_ref,
                    "usedOn": used_on,
                    "scope": c.scope,
                    "viewport": c.viewport,
                },
                "snippet": c.snippet,
                "instruction": c.body,
                "status": c.status,
                "author": c.author,
                "created_at": c.created_at,
                "resolution_note": c.resolution_note,
            })
        })
        .collect();

    Ok(Json(json!({ "comments": targets })))
}

#[derive(Debug, Deserialize)]
pub struct ResolveCommentInput {
    pub project: i64,
    pub note: String,
}

/// `POST /api/taskflow/agents/design/comments/{id}/resolve` — mark addressed
/// with the note the chrome shows on the review toast.
pub async fn resolve_comment(
    RequireAgent(agent): RequireAgent,
    Path(comment_row_id): Path<i64>,
    Json(input): Json<ResolveCommentInput>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, input.project)?;
    let note = input.note.trim();
    if note.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut row = DesignComment::objects()
        .filter(
            design_comment::PROJECT.eq(agent.project_id)
                & design_comment::ID.eq(comment_row_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    row.status = CommentStatus::Addressed;
    row.resolution_note = Some(note.chars().take(2000).collect());

    let saved = DesignComment::objects()
        .save(row)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "ok": true, "comment": saved })))
}
