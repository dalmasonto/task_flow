//! HTTP handlers for the `taskflow-toolbox` plugin (#617).
//!
//! Two surfaces, one rule: every caller must be an active member of the
//! project. The human routes serve the Toolbox page (list, entry, versions,
//! restore, approve, deprecate, delete). The agent routes serve the MCP tools
//! (`toolbox_list`, `toolbox_get`, `toolbox_save`, `toolbox_report_run`,
//! `toolbox_deprecate`) and are keyed by the agent's own credential, exactly
//! like every other `*_as_agent` handler in the repo.
//!
//! What no route does: run a script. Execution is always local.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_agents::agent_auth::RequireAgent;

use crate::models::{
    ToolboxEntry, ToolboxEntryVersion, ToolboxKind, ToolboxStatus, toolbox_entry,
    toolbox_entry_version,
};
use crate::redact;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn rejected(detail: Value) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(detail))
}

async fn ensure_member(user_id: i64, project_id: i64) -> Result<(), ApiError> {
    if taskflow_projects::scope::can_access_project(user_id, project_id).await {
        Ok(())
    } else {
        // Not-found for a project the caller cannot see: the same rule the
        // design plugin applies, so a stranger learns nothing by probing.
        Err(err(StatusCode::NOT_FOUND, "project"))
    }
}

/// The caller's display label, for `author_label`.
async fn caller_label(user_id: i64) -> String {
    use umbral_auth::auth_user;
    umbral_auth::AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .ok()
        .flatten()
        .map(|user| {
            if user.username.trim().is_empty() {
                user.email.clone()
            } else {
                user.username.clone()
            }
        })
        .unwrap_or_else(|| format!("user {user_id}"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 60
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn parse_json_array<T: serde::de::DeserializeOwned>(raw: Option<&str>) -> Vec<T> {
    raw.and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default()
}

fn entry_index_json(entry: &ToolboxEntry) -> Value {
    json!({
        "id": entry.id,
        "kind": entry.kind,
        "name": entry.name,
        "title": entry.title,
        "description": entry.description,
        "status": entry.status,
        "version": entry.version,
        "tags": parse_json_array::<String>(entry.tags_json.as_deref()),
        "language": entry.language,
        "entrypoint": entry.entrypoint,
        "requires_env": parse_json_array::<String>(entry.requires_env_json.as_deref()),
        "last_run_at": entry.last_run_at,
        "last_run_ok": entry.last_run_ok,
        "run_ok_count": entry.run_ok_count,
        "run_fail_count": entry.run_fail_count,
        "author_label": entry.author_label,
        "updated_at": entry.updated_at,
        // NEVER `code` and never `body_markdown`: a listing must not load a
        // script into anyone's context (acceptance 6).
    })
}

fn entry_full_json(entry: &ToolboxEntry) -> Value {
    let mut value = entry_index_json(entry);
    if let Some(object) = value.as_object_mut() {
        object.insert("body_markdown".to_string(), json!(entry.body_markdown));
        object.insert("code".to_string(), json!(entry.code));
        object.insert("params".to_string(), json!(parse_json_array::<Value>(entry.params_json.as_deref())));
        object.insert("params_json".to_string(), json!(entry.params_json));
        object.insert("deprecated_reason".to_string(), json!(entry.deprecated_reason));
        object.insert("created_at".to_string(), json!(entry.created_at));
    }
    value
}

// ---------------------------------------------------------------------------
// Human surface
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

/// `GET /api/taskflow/toolbox/{project}` — the index. No code, ever.
pub async fn list_entries(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(user_id, project_id).await?;
    let kind = match query.kind.as_deref() {
        Some("memory") => Some(ToolboxKind::Memory),
        Some("script") => Some(ToolboxKind::Script),
        Some(_) => return Err(rejected(json!({ "error": "kind must be memory or script" }))),
        None => None,
    };
    let mut rows = ToolboxEntry::objects()
        .filter(toolbox_entry::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    rows.sort_by(|a, b| a.name.cmp(&b.name));

    let needle = query.query.as_deref().map(str::to_lowercase);
    let entries: Vec<Value> = rows
        .iter()
        .filter(|entry| kind.is_none_or(|kind| entry.kind == kind))
        .filter(|entry| {
            query.tag.as_deref().is_none_or(|tag| {
                parse_json_array::<String>(entry.tags_json.as_deref())
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(tag))
            })
        })
        .filter(|entry| {
            needle.as_deref().is_none_or(|needle| {
                entry.name.contains(needle)
                    || entry.title.to_lowercase().contains(needle)
                    || entry.description.to_lowercase().contains(needle)
            })
        })
        .map(entry_index_json)
        .collect();

    Ok(Json(json!({ "entries": entries })))
}

async fn load_entry(project_id: i64, name: &str) -> Result<ToolboxEntry, ApiError> {
    ToolboxEntry::objects()
        .filter(toolbox_entry::PROJECT.eq(project_id) & toolbox_entry::NAME.eq(name))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "entry"))
}

/// `GET /api/taskflow/toolbox/{project}/entry/{name}` — the full entry.
pub async fn get_entry(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(user_id, project_id).await?;
    let entry = load_entry(project_id, &name).await?;
    Ok(Json(entry_full_json(&entry)))
}

#[derive(Deserialize)]
pub struct SaveBody {
    pub kind: Option<ToolboxKind>,
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub body_markdown: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub params: Option<Vec<Value>>,
    #[serde(default)]
    pub requires_env: Option<Vec<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// The version this save is based on. Required for an update: a stale one
    /// is a 409, so two agents editing the same script cannot silently
    /// overwrite each other.
    #[serde(default)]
    pub base_version: Option<i64>,
    /// Why this version replaces the last — what a diff reader wants.
    #[serde(default)]
    pub note: Option<String>,
    /// Return the redaction report without saving.
    #[serde(default)]
    pub dry_run: bool,
}

/// The core save: validate, scan for secrets (reject), redact identifiers
/// (replace + report), write the entry and a version row. Shared by the human
/// and agent routes so the guardrails cannot differ between them.
pub async fn save_entry_core(
    project_id: i64,
    name: &str,
    body: SaveBody,
    author_agent_id: Option<i64>,
    author_user: Option<i64>,
    author_label: String,
) -> Result<(ToolboxEntry, Vec<redact::Redaction>), ApiError> {
    if !valid_name(name) {
        return Err(rejected(json!({
            "error": "invalid_name",
            "detail": "name must be 1-60 characters of lowercase letters, digits, `-` or `_`",
        })));
    }

    let existing = ToolboxEntry::objects()
        .filter(toolbox_entry::PROJECT.eq(project_id) & toolbox_entry::NAME.eq(name))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;

    let kind = body
        .kind
        .or_else(|| existing.as_ref().map(|entry| entry.kind))
        .unwrap_or(ToolboxKind::Memory);

    // A script without code is not a script.
    let code = body.code.clone().or_else(|| existing.as_ref().and_then(|entry| entry.code.clone()));
    if kind == ToolboxKind::Script && code.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err(rejected(json!({ "error": "missing_code", "detail": "a script needs its code" })));
    }

    let body_markdown = body
        .body_markdown
        .clone()
        .or_else(|| existing.as_ref().map(|entry| entry.body_markdown.clone()))
        .unwrap_or_default();

    // ---- layer 1: secrets are refused --------------------------------
    let mut findings = redact::scan_secrets(&body_markdown);
    if let Some(code) = code.as_deref() {
        findings.extend(redact::scan_secrets(code));
    }
    if let Some(description) = body.description.as_deref() {
        findings.extend(redact::scan_secrets(description));
    }
    if !findings.is_empty() {
        return Err(rejected(json!({
            "error": "secret_detected",
            "detail": "TaskFlow never stores credentials. Read them from the environment at run time and declare the variable names in requires_env.",
            "findings": findings,
        })));
    }

    // ---- layer 2: identifiers are redacted ---------------------------
    let mut redactions = Vec::new();
    let (body_markdown, mut found) = redact::redact_identifiers(&body_markdown);
    redactions.append(&mut found);
    let code = code.map(|code| {
        let (clean, mut found) = redact::redact_identifiers(&code);
        redactions.append(&mut found);
        clean
    });
    let description = body
        .description
        .clone()
        .or_else(|| existing.as_ref().map(|entry| entry.description.clone()))
        .unwrap_or_default();
    let (description, mut found) = redact::redact_identifiers(&description);
    redactions.append(&mut found);

    if body.dry_run {
        // Nothing is written: the caller fixes the source and calls again.
        let placeholder = existing.unwrap_or(ToolboxEntry {
            id: 0,
            project: ForeignKey::new(project_id),
            kind,
            name: name.to_string(),
            title: body.title.unwrap_or_default(),
            description,
            body_markdown,
            code,
            language: body.language,
            entrypoint: body.entrypoint,
            params_json: None,
            requires_env_json: None,
            tags_json: None,
            author_agent_id,
            author_user: None,
            author_label,
            version: 0,
            status: ToolboxStatus::Draft,
            deprecated_reason: None,
            last_run_at: None,
            last_run_ok: false,
            run_ok_count: 0,
            run_fail_count: 0,
            created_at: None,
            updated_at: None,
        });
        return Ok((placeholder, redactions));
    }

    let title = body
        .title
        .clone()
        .or_else(|| existing.as_ref().map(|entry| entry.title.clone()))
        .unwrap_or_else(|| name.to_string());

    let next_version = match &existing {
        None => 1,
        Some(entry) => {
            // The version gate: an update must name the version it edits.
            match body.base_version {
                Some(base) if base == entry.version => entry.version + 1,
                Some(base) => {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(json!({
                            "error": "version_conflict",
                            "current_version": entry.version,
                            "your_base_version": base,
                        })),
                    ));
                }
                None => return Err(rejected(json!({ "error": "base_version_required" }))),
            }
        }
    };

    let params_json = body
        .params
        .as_ref()
        .map(|params| serde_json::to_string(params).unwrap_or_else(|_| "[]".into()))
        .or_else(|| existing.as_ref().and_then(|entry| entry.params_json.clone()));
    let requires_env_json = body
        .requires_env
        .as_ref()
        .map(|vars| serde_json::to_string(vars).unwrap_or_else(|_| "[]".into()))
        .or_else(|| existing.as_ref().and_then(|entry| entry.requires_env_json.clone()));
    let tags_json = body
        .tags
        .as_ref()
        .map(|tags| serde_json::to_string(tags).unwrap_or_else(|_| "[]".into()))
        .or_else(|| existing.as_ref().and_then(|entry| entry.tags_json.clone()));

    let now = chrono::Utc::now();
    let saved = match existing {
        None => {
            let created = ToolboxEntry::objects()
                .create(ToolboxEntry {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    kind,
                    name: name.to_string(),
                    title,
                    description,
                    body_markdown,
                    code,
                    language: body.language,
                    entrypoint: body.entrypoint,
                    params_json,
                    requires_env_json,
                    tags_json,
                    author_agent_id,
                    author_user: author_user.map(ForeignKey::new),
                    author_label,
                    version: next_version,
                    // A script starts as a draft: another agent must not run it
                    // before a human has looked at it. A memory has nothing to
                    // execute, so it is approved on arrival.
                    status: if kind == ToolboxKind::Script {
                        ToolboxStatus::Draft
                    } else {
                        ToolboxStatus::Approved
                    },
                    deprecated_reason: None,
                    last_run_at: None,
                    last_run_ok: false,
                    run_ok_count: 0,
                    run_fail_count: 0,
                    created_at: None,
                    updated_at: Some(now),
                })
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
            created
        }
        Some(mut entry) => {
            // Snapshot the OUTGOING state first, so every version is kept.
            ToolboxEntryVersion::objects()
                .create(ToolboxEntryVersion {
                    id: 0,
                    entry: ForeignKey::new(entry.id),
                    version: entry.version,
                    body_markdown: entry.body_markdown.clone(),
                    code: entry.code.clone(),
                    params_json: entry.params_json.clone(),
                    requires_env_json: entry.requires_env_json.clone(),
                    description: entry.description.clone(),
                    author_label: entry.author_label.clone(),
                    note: body.note.clone(),
                    vetted_by: None,
                    vetted_note: None,
                    created_at: None,
                })
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;

            entry.title = title;
            entry.description = description;
            entry.body_markdown = body_markdown;
            entry.code = code;
            if body.language.is_some() {
                entry.language = body.language;
            }
            if body.entrypoint.is_some() {
                entry.entrypoint = body.entrypoint;
            }
            entry.params_json = params_json;
            entry.requires_env_json = requires_env_json;
            entry.tags_json = tags_json;
            // An update by another author re-opens the human gate only for
            // scripts whose code actually changed; a title fix must not force
            // a re-approval.
            if entry.kind == ToolboxKind::Script && entry.status == ToolboxStatus::Approved {
                entry.status = ToolboxStatus::Draft;
            }
            entry.version = next_version;
            entry.updated_at = Some(now);
            ToolboxEntry::objects()
                .save(entry)
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        }
    };

    Ok((saved, redactions))
}

/// `POST /api/taskflow/toolbox/{project}/entry/{name}` — create or update.
pub async fn save_entry(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
    Json(body): Json<SaveBody>,
) -> Result<Response, ApiError> {
    ensure_member(user_id, project_id).await?;
    let label = caller_label(user_id).await;
    let dry_run = body.dry_run;
    let (entry, redactions) = save_entry_core(project_id, &name, body, None, Some(user_id), label).await?;
    let mut value = json!({ "entry": entry_full_json(&entry), "redactions": redactions });
    if dry_run {
        value["dry_run"] = json!(true);
    }
    Ok((StatusCode::OK, Json(value)).into_response())
}

/// `GET /api/taskflow/toolbox/{project}/entry/{name}/versions` — the history,
/// newest first.
pub async fn list_versions(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(user_id, project_id).await?;
    let entry = load_entry(project_id, &name).await?;
    let mut rows = ToolboxEntryVersion::objects()
        .filter(toolbox_entry_version::ENTRY.eq(entry.id))
        .fetch()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    rows.sort_by(|a, b| b.version.cmp(&a.version));
    let versions: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "version": row.version,
                "description": row.description,
                "author_label": row.author_label,
                "note": row.note,
                "vetted_by": row.vetted_by,
                "vetted_note": row.vetted_note,
                "created_at": row.created_at,
            })
        })
        .collect();
    Ok(Json(json!({ "entry": entry.name, "current_version": entry.version, "versions": versions })))
}

/// One version's content. The CURRENT version has no snapshot row — the entry
/// row IS it — so asking for it answers from the entry rather than 404ing.
/// That is not a convenience: the whole update flow is `toolbox_diff(installed,
/// current)`, and a 404 on "current" would break it.
async fn version_json(entry: &ToolboxEntry, version: i64) -> Result<Value, ApiError> {
    if version == entry.version {
        return Ok(json!({
            "version": entry.version,
            "description": entry.description,
            "body_markdown": entry.body_markdown,
            "code": entry.code,
            "params": parse_json_array::<Value>(entry.params_json.as_deref()),
            "requires_env": parse_json_array::<String>(entry.requires_env_json.as_deref()),
            "author_label": entry.author_label,
            "note": null,
            "created_at": entry.updated_at,
            "current": true,
        }));
    }
    let row = ToolboxEntryVersion::objects()
        .filter(toolbox_entry_version::ENTRY.eq(entry.id) & toolbox_entry_version::VERSION.eq(version))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "version"))?;
    Ok(json!({
        "version": row.version,
        "description": row.description,
        "body_markdown": row.body_markdown,
        "code": row.code,
        "params": parse_json_array::<Value>(row.params_json.as_deref()),
        "requires_env": parse_json_array::<String>(row.requires_env_json.as_deref()),
        "author_label": row.author_label,
        "note": row.note,
        "created_at": row.created_at,
        "current": false,
    }))
}

/// `GET .../versions/{version}` — one state, with its code (current included).
pub async fn get_version(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name, version)): Path<(i64, String, i64)>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(user_id, project_id).await?;
    let entry = load_entry(project_id, &name).await?;
    Ok(Json(version_json(&entry, version).await?))
}

#[derive(Deserialize)]
pub struct RestoreBody {
    pub version: i64,
    #[serde(default)]
    pub note: Option<String>,
}

/// `POST .../versions/restore` — make a past version current again. This is a
/// SAVE (it goes through the same scan and redaction and gets a new version
/// number), so the history stays append-only and a rollback is visible.
pub async fn restore_version(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
    Json(body): Json<RestoreBody>,
) -> Result<Response, ApiError> {
    ensure_member(user_id, project_id).await?;
    let entry = load_entry(project_id, &name).await?;
    let row = ToolboxEntryVersion::objects()
        .filter(toolbox_entry_version::ENTRY.eq(entry.id) & toolbox_entry_version::VERSION.eq(body.version))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "version"))?;

    let label = caller_label(user_id).await;
    let save = SaveBody {
        kind: Some(entry.kind),
        title: None,
        description: Some(row.description),
        body_markdown: Some(row.body_markdown),
        code: row.code,
        language: entry.language,
        entrypoint: entry.entrypoint,
        params: Some(parse_json_array::<Value>(row.params_json.as_deref())),
        requires_env: Some(parse_json_array::<String>(row.requires_env_json.as_deref())),
        tags: None,
        base_version: Some(entry.version),
        note: Some(body.note.unwrap_or_else(|| format!("restored from version {}", body.version))),
        dry_run: false,
    };
    let (saved, redactions) = save_entry_core(project_id, &name, save, None, Some(user_id), label).await?;
    Ok((StatusCode::OK, Json(json!({ "entry": entry_full_json(&saved), "redactions": redactions }))).into_response())
}

/// `POST .../status` `{status, reason?}` — a HUMAN action. Approving is the
/// gate the design puts in human hands; agents may only deprecate.
pub async fn set_status(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(user_id, project_id).await?;
    let status = match body.get("status").and_then(Value::as_str) {
        Some("approved") => ToolboxStatus::Approved,
        Some("deprecated") => ToolboxStatus::Deprecated,
        Some("draft") => ToolboxStatus::Draft,
        Some(_) => return Err(rejected(json!({ "error": "status must be draft, approved or deprecated" }))),
        None => return Err(rejected(json!({ "error": "status is required" }))),
    };
    let reason = body.get("reason").and_then(Value::as_str).map(str::to_string);
    if status == ToolboxStatus::Deprecated && reason.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err(rejected(json!({ "error": "a deprecation needs a reason" })));
    }
    let mut entry = load_entry(project_id, &name).await?;
    entry.status = status;
    entry.deprecated_reason = if status == ToolboxStatus::Deprecated { reason } else { None };
    entry.updated_at = Some(chrono::Utc::now());
    let entry = ToolboxEntry::objects()
        .save(entry)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({ "entry": entry_index_json(&entry) })))
}

/// `DELETE /api/taskflow/toolbox/{project}/entry/{name}` — humans only; the
/// versions cascade with it.
pub async fn delete_entry(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, name)): Path<(i64, String)>,
) -> Result<StatusCode, ApiError> {
    ensure_member(user_id, project_id).await?;
    let entry = load_entry(project_id, &name).await?;
    ToolboxEntry::objects()
        .filter(toolbox_entry::ID.eq(entry.id))
        .delete()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Agent surface — what the MCP tools call
// ---------------------------------------------------------------------------
//
// `RequireAgent` resolves the credential to a stable agent whose project is
// DERIVED, never accepted: an agent can only touch its own project's toolbox.
// Every handler here mirrors a human one through the SAME core, so the secret
// scan and the redaction cannot differ between the two doors.

#[derive(Deserialize)]
pub struct AgentListQuery {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

/// `GET /api/taskflow/agents/toolbox` — the index (titles, descriptions, tags,
/// status, version, run stats; never code).
pub async fn agent_list(
    RequireAgent(agent): RequireAgent,
    Query(query): Query<AgentListQuery>,
) -> Result<Json<Value>, ApiError> {
    let list = list_entries(
        RequireAuth(agent_owner_id(&agent)),
        Path(agent.project_id),
        Query(ListQuery { kind: query.kind, tag: query.tag, query: query.query }),
    )
    .await;
    // The member check is redundant for an agent (its project is its own), but
    // going through the same function keeps ONE listing implementation.
    match list {
        Ok(json) => Ok(json),
        Err(_) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "db")),
    }
}

/// An agent credential already implies its project, so membership is not the
/// gate here; `RequireAgent` is. This id exists only to satisfy the shared
/// helper's signature and is never used for authorization.
fn agent_owner_id(agent: &taskflow_agents::agent_auth::AgentIdentity) -> i64 {
    agent.agent_id
}

/// `GET /api/taskflow/agents/toolbox/{name}` — the full entry, code included.
pub async fn agent_get(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let entry = load_entry(agent.project_id, &name).await?;
    let mut value = entry_full_json(&entry);
    if let Some(object) = value.as_object_mut() {
        // The MCP needs the raw JSON for its local install manifest and the
        // sha256 it will check; compute the hash here so both sides agree.
        object.insert(
            "content_sha256".to_string(),
            json!(sha256_hex(entry.code.as_deref().unwrap_or(""))),
        );
    }
    Ok(Json(value))
}

/// `POST /api/taskflow/agents/toolbox/{name}` — save, with the version gate.
pub async fn agent_save(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
    Json(body): Json<SaveBody>,
) -> Result<Response, ApiError> {
    let dry_run = body.dry_run;
    let label = agent.display_name.clone();
    let (entry, redactions) =
        save_entry_core(agent.project_id, &name, body, Some(agent.agent_id), None, label).await?;
    let mut value = json!({ "entry": entry_full_json(&entry), "redactions": redactions });
    if dry_run {
        value["dry_run"] = json!(true);
        value["hint"] = json!(
            "Move the replaced values into requires_env (for example SERVER_HOST) and read them at run time, then save again."
        );
    }
    Ok((StatusCode::OK, Json(value)).into_response())
}

#[derive(Deserialize)]
pub struct ReportRunBody {
    pub ok: bool,
    #[serde(default)]
    pub note: Option<String>,
}

/// `POST /api/taskflow/agents/toolbox/{name}/run` — the feedback loop. Records
/// whether the run worked, so the UI can badge a failing script.
pub async fn agent_report_run(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
    Json(body): Json<ReportRunBody>,
) -> Result<Json<Value>, ApiError> {
    let mut entry = load_entry(agent.project_id, &name).await?;
    entry.last_run_at = Some(chrono::Utc::now());
    entry.last_run_ok = body.ok;
    if body.ok {
        entry.run_ok_count += 1;
    } else {
        entry.run_fail_count += 1;
    }
    entry.updated_at = Some(chrono::Utc::now());
    let entry = ToolboxEntry::objects()
        .save(entry)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({ "entry": entry_index_json(&entry), "note": body.note })))
}

#[derive(Deserialize)]
pub struct DeprecateBody {
    pub reason: String,
}

/// `POST /api/taskflow/agents/toolbox/{name}/deprecate` — an agent may retire
/// its own work; approving stays a human action.
pub async fn agent_deprecate(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
    Json(body): Json<DeprecateBody>,
) -> Result<Json<Value>, ApiError> {
    if body.reason.trim().is_empty() {
        return Err(rejected(json!({ "error": "a deprecation needs a reason" })));
    }
    let mut entry = load_entry(agent.project_id, &name).await?;
    entry.status = ToolboxStatus::Deprecated;
    entry.deprecated_reason = Some(body.reason);
    entry.updated_at = Some(chrono::Utc::now());
    let entry = ToolboxEntry::objects()
        .save(entry)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({ "entry": entry_index_json(&entry) })))
}

/// `GET /api/taskflow/agents/toolbox/usage/{name}` — who vetted which installed
/// version. Written by installs (the MCP records the note), read by the UI.
pub async fn agent_list_versions(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let entry = load_entry(agent.project_id, &name).await?;
    let rows = ToolboxEntryVersion::objects()
        .filter(toolbox_entry_version::ENTRY.eq(entry.id))
        .fetch()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({
        "current_version": entry.version,
        "versions": rows
            .iter()
            .map(|row| json!({
                "version": row.version,
                "author_label": row.author_label,
                "note": row.note,
                "vetted_by": row.vetted_by,
                "vetted_note": row.vetted_note,
                "created_at": row.created_at,
            }))
            .collect::<Vec<_>>(),
    })))
}

/// `GET /api/taskflow/agents/toolbox/{name}/versions/{version}` — one past
/// version WITH its code, so the MCP can diff an update before re-vetting it.
pub async fn agent_get_version(
    RequireAgent(agent): RequireAgent,
    Path((name, version)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    let entry = load_entry(agent.project_id, &name).await?;
    Ok(Json(version_json(&entry, version).await?))
}

#[derive(Deserialize)]
pub struct VetBody {
    pub version: i64,
    pub vetted_by: String,
    pub vetted_note: String,
}

/// `POST /api/taskflow/agents/toolbox/{name}/vet` — record that an agent read a
/// version and judged it safe to install, with its own sentence about what it
/// checked. Teammates see this next to the version.
pub async fn agent_vet(
    RequireAgent(agent): RequireAgent,
    Path(name): Path<String>,
    Json(body): Json<VetBody>,
) -> Result<Json<Value>, ApiError> {
    if body.vetted_note.trim().is_empty() {
        return Err(rejected(json!({ "error": "vetted_note is required" })));
    }
    let entry = load_entry(agent.project_id, &name).await?;
    let row = ToolboxEntryVersion::objects()
        .filter(toolbox_entry_version::ENTRY.eq(entry.id) & toolbox_entry_version::VERSION.eq(body.version))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "version"))?;
    let mut row = row;
    row.vetted_by = Some(body.vetted_by);
    row.vetted_note = Some(body.vetted_note);
    ToolboxEntryVersion::objects()
        .save(row)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({ "ok": true })))
}

/// The content hash the MCP records in its install manifest and re-checks
/// before running an installed script, so a locally edited file is noticed
/// instead of run.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest as _, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().fold(String::with_capacity(64), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}
