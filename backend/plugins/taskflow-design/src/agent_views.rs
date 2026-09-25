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
use umbral_realtime::Realtime;
use taskflow_agents::agent_auth::RequireAgent;

use crate::layout_doc;
use crate::manifest;
use crate::models::{CommentStatus, DesignComment, DesignFileKind, design_comment};
use crate::store::{self, WriteOutcome};
use crate::tokens::{TokensDoc, css_to_tokens_json, tokens_json_to_css};
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

/// Resolve the project's tokens as a [`TokensDoc`], preferring the
/// `styles/tokens.json` source of truth and falling back to deriving one
/// from a legacy `styles/tokens.css` row (via [`css_to_tokens_json`]) when no
/// json row exists yet. This is the READ side of the json migration: a
/// project that has only ever been written as CSS still answers
/// `design_get_tokens`/`context` with a proper json map, no write required.
fn resolve_tokens_doc(files: &[crate::models::DesignFile]) -> TokensDoc {
    files
        .iter()
        .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.json")
        .and_then(|f| serde_json::from_str::<TokensDoc>(&f.content).ok())
        .or_else(|| {
            files
                .iter()
                .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.css")
                .map(|f| css_to_tokens_json(&f.content))
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentContextQuery {
    /// The tool's `project` argument; must equal the credential's project.
    pub project: i64,
}

/// The authoring guidance that is true of the sandbox but is not derivable
/// from the manifest: how a page links to another page, how a back control is
/// written, and what a page may load from outside the sandbox.
///
/// It is served from HERE because this response is what the agent receives:
/// `design_get_tokens` and `design_list_components` both return it, and the
/// first is the read an agent is told to always make before its first design
/// write. The MCP tool descriptions are the other place this could live, and
/// to a reader they are the more obvious one — but the MCP an agent actually
/// runs is a global COPY of the package, not this repo
/// (`$(npm root -g)/@dalmasonto/taskflow-mcp`: real files, no symlink into the
/// repo), so text written into `mcp/src` reaches an agent only after a build
/// AND a reinstall — a build refreshes this repo's `dist/`, and only a
/// reinstall replaces the installed copy. At the time of writing that copy was
/// already behind this repo's `src/` and `dist/`: its `dist/server.js` carried
/// no occurrence of `primitives`, which both of them do. This response has no
/// such step.
const AUTHORING_GUIDE: &str = r#"Links between pages
  Use a plain <a href="/route"> for any route in the manifest — e.g.
  <a href="/app">. The composer rewrites it to the sandbox URL, so the click
  navigates the preview frame and the browser's back/forward work.

  A back control is just:
      <button onclick="history.back()">Back</button>
  The frame keeps its own history, so this works with no extra wiring — but
  only once the frame HAS history: opened directly at one route it has a
  single entry, and Back there does nothing. A link to a known route always
  works, so do not let Back be the only way off a page.

  Do NOT hand-write sandbox URLs, and do not use target="_blank" for
  in-project links — a new tab leaves the frame and loses its history.

Images, video and motion
  External https images and media work:
      <img src="https://cdn.example/hero.png" alt="…">
      <video src="https://cdn.example/clip.mp4" controls></video>
  That covers sprite sheets and CSS background-image from an https origin.
  Plain http is refused, and inline data:/blob: URIs still work for small
  assets. Motion no longer has to be CSS/SVG/inline — a video is a real
  option — though CSS and SVG animation are still the default for interface
  motion.

  A Lottie animation works, but NOT by putting <script src> in a page: page
  fragments may not contain one, and the server refuses that markup. Write a
  COMPONENT instead — in the sandbox a component is a same-origin script, and
  the player it appends from a CDN is allowed by script-src.

  Pass the animation data INLINE in that component (lottie's animationData),
  because there is nowhere to store it as a file: assets/ accepts image
  extensions only, and styles/ accepts only tokens.css, tokens.json and
  resources.json. That data counts against the 128 KB per-file cap on the
  component itself, so keep the animation small: a larger one is refused
  outright (rule `size-cap`), and there is nowhere else to put it.
"#;

/// `GET /api/taskflow/agents/design/context` — everything `design_get_tokens`
/// and `design_list_components` need, in one read: the tokens css + parsed
/// scale, the component registry with usage, the routes, and the authoring
/// guide (links, back navigation, external media).
pub async fn context(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentContextQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let files = load_files(agent.project_id).await;
    let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
    let m = manifest::build(agent.project_id, &files, revision);
    let tokens_doc = resolve_tokens_doc(&files);
    let tokens_css = tokens_json_to_css(&tokens_doc);
    let tokens_json = serde_json::to_value(&tokens_doc).unwrap_or_else(|_| json!({}));

    Ok(Json(json!({
        "tokens_css": tokens_css,
        "tokens_json": tokens_json,
        "tokens": manifest::to_json(&m)["tokens"],
        "components": manifest::to_json(&m)["components"],
        "routes": manifest::to_json(&m)["routes"],
        "revision": revision,
        "primitives": crate::primitives::catalog(),
        "guide": AUTHORING_GUIDE,
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

#[derive(Debug, Deserialize)]
pub struct AgentLayoutQuery {
    /// The tool's `project` argument; must equal the credential's project.
    pub project: i64,
}

/// `GET /api/taskflow/agents/design/layout` — how the project's pages are
/// ARRANGED: the named groups with their pages, the flow, and the name each page
/// is listed under.
///
/// This is the one thing `design_list_components` cannot answer. That tool
/// returns the registry as a flat `{file, path, title}` array in the manifest's
/// own sequence, so an agent could see WHICH pages exist and had no way to see
/// how they are grouped or in what order they flow — the arrangement is not
/// derivable from the registry, at any price.
///
/// READ ONLY, deliberately. The operator's `PUT /api/design/{project}/layout`
/// stays the only way the arrangement changes: arranging someone's board is a
/// curatorial act, and the write has a contract change to make first (it is
/// last-write-wins, with no `base_version` to hand back).
///
/// The document comes from `views::load_layout` — the SAME loader the operator
/// read uses, so the forgiving rules are one implementation rather than two, and
/// a document naming a page that has since been deleted is served with that
/// route filtered out rather than refused.
pub async fn read_layout(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentLayoutQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let (doc, m) = crate::views::load_layout(agent.project_id).await?;
    let paths: Vec<String> = m.routes.iter().map(|r| r.path.clone()).collect();
    let flow = layout_doc::resolve_route_order(&doc, &paths);
    let (groups, ungrouped) = layout_doc::panel_sections(&doc, &paths);

    // Every page in flow order, named the way the panel names it: a page's
    // label if it has one, else the manifest's own title. The route is the key
    // everything else here uses, so it is carried on the entry rather than left
    // to the reader to match up by position.
    let pages: Vec<serde_json::Value> = flow
        .iter()
        .map(|route| {
            let entry = m.routes.iter().find(|r| &r.path == route);
            let title = entry.map(|r| r.title.clone()).unwrap_or_else(|| route.clone());
            json!({
                "route": route,
                "name": doc.page_labels.get(route).cloned().unwrap_or_else(|| title.clone()),
                "title": title,
                "path": entry.map(|r| r.file.clone()).unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(json!({
        "project": agent.project_id,
        "view": doc.view,
        "flow": flow,
        "groups": groups,
        "ungrouped": ungrouped,
        "page_labels": doc.page_labels,
        "pages": pages,
        "revision": m.revision,
        // Written for an agent that arrived here from `design_list_components`
        // and has no idea what a "view" or a "flow" is: say what each field
        // answers, and which part of this is the answer to the question it came
        // with.
        "note": "The arrangement as the Pages panel lists it. `groups` are the \
                 named groups, each with its pages in `flow` order — that order \
                 is the project's presentation order, and the canvas draws in it \
                 too. `ungrouped` is every page no group claims: every page \
                 appears exactly once, in a group or there. `pages` names each \
                 page the way the panel does (its label if it has one, else the \
                 manifest title). `view` is the canvas arrangement \
                 (rows/bands/groups) and the grouping reads the same in all \
                 three. Read-only: arranging pages is the operator's."
    })))
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
pub struct AgentDeleteComponentInput {
    pub project: i64,
    pub name: String,
    pub reason: String,
}

/// What one attempted component retirement resolved to, decided ENTIRELY
/// inside the project lock. Returned rather than responded to from inside the
/// closure so the response is built after the lock is released.
enum DeleteOutcome {
    /// The row was there and is gone; carries its primary key, which is what
    /// the realtime event names (the row itself no longer exists to re-read).
    Deleted(i64),
    /// No such component in this project.
    NotFound,
    /// Referenced by at least one page fragment; carries the routes and the
    /// total tag count so the refusal can say exactly where.
    InUse(Vec<String>, usize),
}

/// `DELETE /api/taskflow/agents/design/component` — retire one custom element
/// from the registry.
///
/// REFUSED while any page fragment still references it, and the refusal NAMES
/// those routes. That check is the whole safety property of this tool, and it
/// is not visible from the outside: `composer::compose_document` emits the
/// `<script src>` for a component only while it is in the manifest, so a page
/// left holding the tag renders without its definition — and it cannot be
/// edited again until that reference is gone, because `store::write_file`
/// re-validates the fragment against the registry on every write and
/// `validate_page_fragment` rejects an unregistered tag with rule
/// `unknown-component`. Note the bound exactly: a write that REMOVES the tag is
/// accepted (the rule fires on the tag, not on the page), so the page is stuck
/// only for edits that keep the reference. It is still a broken page — it
/// renders without the definition — which is what the refusal is for, and the
/// route list is what makes it actionable.
///
/// `used_on`/`usage_count` are already computed per read (`manifest::build`
/// scans each fragment once per registered component), so this is a lookup, not
/// new machinery.
///
/// Requires a `reason`, like `write_component`: retiring a shared part is a
/// registry-level decision. There is no `base_version` — a delete is not an
/// overwrite, so there is nothing to lose a race against.
///
/// ## The realtime event is emitted HERE, not by the ORM
///
/// `backend/src/realtime.rs` exposes `DesignFile` to `project:{id}:design_files`
/// through a group derived from the row's `project` column, and the ORM's delete
/// signal cannot supply it: `QuerySet::delete` emits its per-row `post_delete`
/// with the primary key alone, so `group_for` finds no `project` and falls back
/// to `taskflow:projects` — the group whose frontend handler removes a project
/// from the sidebar. The `Deleted` action is therefore excluded from that
/// registration, and this handler sends the event itself, from inside the same
/// call that holds the project id and the row. Id-only, matching what `Expose`
/// projects for this table: the chrome refetches over REST.
pub async fn delete_component(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentDeleteComponentInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let name = input.name.trim();
    let reason = input.reason.trim();
    if name.is_empty() || reason.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if reason.len() < 8 {
        return Ok(tokens_validation_error(
            "missing-reason",
            "design_delete_component requires a real `reason`: why should this component no \
             longer exist?"
                .to_string(),
        ));
    }
    // Reject a name that would escape `components/` before it is ever used to
    // build a path — same guard `read_component` makes.
    let path = format!("components/{name}.js");
    validation::validate_path(&path).map_err(|_| StatusCode::BAD_REQUEST)?;

    let outcome = project_locks()
        .with_lock(agent.project_id, || async {
            let files = store::list_files(agent.project_id).await;
            if !files.iter().any(|f| f.path == path) {
                return DeleteOutcome::NotFound;
            }
            // The registry as the SERVE path sees it. `registered_components`
            // for the validator is read fresh on every WRITE, so the blast
            // radius has to be read the same way here — from the rows, not from
            // a cached manifest.
            let revision = files.iter().map(|f| f.version).max().unwrap_or(0);
            let m = manifest::build(agent.project_id, &files, revision);
            let entry = m.components.iter().find(|c| c.name == name);
            let used_on = entry.map(|c| c.used_on.clone()).unwrap_or_default();
            if !used_on.is_empty() {
                return DeleteOutcome::InUse(
                    used_on,
                    entry.map(|c| c.usage_count).unwrap_or(0),
                );
            }
            let row_id = files
                .iter()
                .find(|f| f.path == path)
                .map(|f| f.id)
                .unwrap_or(0);
            if !store::delete_file(agent.project_id, &path).await {
                return DeleteOutcome::NotFound;
            }
            DeleteOutcome::Deleted(row_id)
        })
        .await;

    match outcome {
        DeleteOutcome::Deleted(row_id) => {
            // The realtime event, from the one place that still knows the
            // project. Not from the ORM: see the handler's doc comment — its
            // delete payload carries no `project`, so `Expose` would route this
            // to `taskflow:projects` and a viewer of THIS project would hear
            // nothing but a random sidebar entry might disappear.
            //
            // Sent AFTER the lock is released and after the row is gone, so a
            // subscriber that reacts by refetching cannot read the row back and
            // resurrect it. Id-only, like every other event on this group: the
            // chrome refetches content and recomputes the manifest over REST.
            Realtime::to_group(crate::signals::files_group(agent.project_id))
                .send("deleted", &json!({ "id": row_id }))
                .await;
            Ok((
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "deleted": path,
                    "name": name,
                    "note": format!(
                        "{name} deleted; no route used it, so nothing rendered changed."
                    ),
                })),
            )
                .into_response())
        }
        DeleteOutcome::NotFound => Err(StatusCode::NOT_FOUND),
        DeleteOutcome::InUse(used_on, usage_count) => Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                // `error` is the machine-readable half (the MCP client prefers
                // `detail` when both are present, so the sentence below is what
                // an agent reads and this is what a caller can branch on).
                "error": "component_in_use",
                "detail": format!(
                    "Refused: <{name}> is still used {usage_count} time(s) on {} route(s): {}. \
                     A page that references a component the registry no longer has renders \
                     without its definition, and cannot be edited until the reference is gone — \
                     every write re-validates the fragment against the registry, and an \
                     unregistered tag is refused with rule `unknown-component`. (The bound \
                     matters: a write that REMOVES the tag is accepted, so the repair is to \
                     rewrite those pages without it — not to delete and recreate them.) \
                     design_read_page shows a fragment and design_write_page replaces it, so \
                     remove <{name}> from the routes above and call this again.",
                    used_on.len(),
                    used_on.join(", ")
                ),
                "used_on": used_on,
                "usage_count": usage_count,
            })),
        )
            .into_response()),
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentWriteAssetInput {
    pub project: i64,
    /// `assets/<name>`, or a bare `<name>` meaning `assets/<name>`. The one
    /// path outside `assets/` this accepts is `styles/resources.json`.
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub base_version: Option<i64>,
}

/// The refusal for a path this tool will not write, in the same envelope the
/// validator uses so an agent reads it the same way as any other rejection.
fn asset_path_refusal(message: String) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({
            "ok": false,
            "errors": [{
                "line": 0,
                "rule": "unsupported-path",
                "message": message,
            }]
        })),
    )
        .into_response()
}

/// `PUT /api/taskflow/agents/design/asset` — write one image under `assets/`,
/// or the external-resources document at `styles/resources.json`.
///
/// Both were previously unwritable by an agent at all: `design_write_page`,
/// `design_write_component` and `design_write_tokens` each hard-code the path
/// they write, and the only other writer is the operator's
/// `PUT /api/design/{project}/file`, which needs a staff session.
///
/// NO validation is relaxed for this route. The same `store::write_file` runs,
/// so the path regex, `MAX_FILE_BYTES` (rule `size-cap`), the image-extension
/// set, and the 200-file / 4 MiB caps on new rows all apply unchanged. Content
/// is TEXT like every other design write — there is no multipart in this
/// plugin — so raster bytes go in as `data:<mime>;base64,<payload>`, which is
/// the shape `views::serve_file` already decodes on the way out.
///
/// The one thing added here is a path ALLOWLIST, and it closes a hole rather
/// than opening one: the shared validator accepts `styles/tokens.json`, so
/// without this check the asset route would be a way to rewrite the token scale
/// while skipping `design_write_tokens`' required `reason`. A bare name is
/// prefixed with `assets/`; anything else that is neither under `assets/` nor
/// the resources document is refused rather than silently rewritten into
/// something the caller did not ask for.
pub async fn write_asset(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentWriteAssetInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let raw = input.path.trim();
    if raw.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = if raw.contains('/') {
        raw.to_string()
    } else {
        format!("assets/{raw}")
    };
    if path != crate::resources::RESOURCES_PATH && !path.starts_with("assets/") {
        return Ok(asset_path_refusal(format!(
            "design_write_asset writes `assets/<name>` (an image: .svg, .png, .jpg, .jpeg, \
             .webp, .gif, .ico) or `{}`. `{raw}` is neither. A page goes through \
             design_write_page, a component through design_write_component, and the token scale \
             through design_write_tokens — each of those owns its path.",
            crate::resources::RESOURCES_PATH
        )));
    }

    agent_write(
        agent.project_id,
        &format!("{} ({})", agent.display_name, agent.agent_id),
        &path,
        &input.content,
        input.base_version,
    )
    .await
}

#[derive(Debug, Deserialize)]
pub struct AgentWriteTokensInput {
    pub project: i64,
    /// Preferred shape: a `TokensDoc`-shaped JSON object.
    #[serde(default)]
    pub tokens: Option<serde_json::Value>,
    /// Legacy shape: raw `styles/tokens.css` content, parsed via
    /// `css_to_tokens_json` before storage. Exactly one of `tokens`/`css`.
    #[serde(default)]
    pub css: Option<String>,
    pub reason: String,
}

fn tokens_validation_error(rule: &'static str, message: String) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({
            "ok": false,
            "errors": [{
                "line": 0,
                "rule": rule,
                "message": message,
            }]
        })),
    )
        .into_response()
}

/// `PUT /api/taskflow/agents/design/tokens` — touches EVERY route, so it is the
/// highest-friction write: required reason, and the response names all routes.
///
/// Accepts EXACTLY ONE of `tokens` (a `TokensDoc`-shaped JSON object, the
/// preferred shape) or `css` (legacy `styles/tokens.css` text, parsed via
/// `css_to_tokens_json`). Either way the write lands at `styles/tokens.json`
/// — a project whose only row so far was a legacy `styles/tokens.css` is
/// migrated to json by this write, same as any other write to that path.
pub async fn write_tokens(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentWriteTokensInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() < 8 {
        return Ok(tokens_validation_error(
            "missing-reason",
            "design_write_tokens requires a real `reason` — tokens touch \
             every page and every component at once."
                .to_string(),
        ));
    }

    let doc = match (input.tokens, input.css) {
        (Some(_), Some(_)) => {
            return Ok(tokens_validation_error(
                "tokens-or-css",
                "design_write_tokens takes exactly ONE of `tokens` or `css`, not both."
                    .to_string(),
            ));
        }
        (None, None) => {
            return Ok(tokens_validation_error(
                "tokens-or-css",
                "design_write_tokens requires exactly ONE of `tokens` (a JSON token map, \
                 preferred) or `css` (legacy tokens.css text)."
                    .to_string(),
            ));
        }
        (Some(tokens), None) => match serde_json::from_value::<TokensDoc>(tokens) {
            Ok(doc) => doc,
            Err(err) => {
                return Ok(tokens_validation_error(
                    "invalid-json",
                    format!(
                        "`tokens` does not match the tokens document shape: {err}. Expected \
                         {{\"version\": 1, \"categories\": {{ \"colors\": {{ \"accent\": \
                         {{ \"light\": \"#6366f1\" }} }} }} }}."
                    ),
                ));
            }
        },
        (None, Some(css)) => css_to_tokens_json(&css),
    };

    let content = match serde_json::to_string(&doc) {
        Ok(s) => s,
        Err(_) => {
            return Ok(tokens_validation_error(
                "storage",
                "Could not serialize the tokens document; try again.".to_string(),
            ));
        }
    };

    agent_write(
        agent.project_id,
        &format!("{} ({})", agent.display_name, agent.agent_id),
        "styles/tokens.json",
        &content,
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
