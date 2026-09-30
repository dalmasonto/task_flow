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

use crate::layout_doc::{self, LayoutDoc};
use crate::manifest;
use crate::models::{
    CommentStatus, DesignComment, DesignFileKind, DesignLayout, design_comment, design_layout,
};
use crate::store::{self, WriteOutcome};
use crate::tokens::{TokensDoc, css_to_tokens_json, tokens_json_to_css};
use crate::validation;
use crate::views::{conflict_response, conflict_response_values, project_locks, rejection_response};

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
/// written, what a page may load from outside the sandbox, and where a
/// webfont is loaded (once, from `styles/resources.json`, never per page).
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

Web fonts (one global change, never per page)
  The page font is the `typography.font-sans` token (design_write_tokens):
  it becomes --font-sans, the whole document's default family. The font FILE
  is loaded ONCE for every page from styles/resources.json, which the server
  emits into the head of every page, before the tokens. Write it with
  design_write_asset (path "styles/resources.json"), e.g. for Inter:
      {"version":1,"sets":[{"id":"font","name":"Font","enabled":true,
        "links":[
          {"rel":"preconnect","href":"https://cdn.jsdelivr.net","crossorigin":true},
          {"rel":"stylesheet","href":"https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5/index.css"}
        ]}]}
  Links must be https, with rel stylesheet, preconnect or dns-prefetch.
  The `resources` field of this response shows the current document and its
  version (pass it as base_version when you replace it).
  The operator often manages these sets from the panel (enable, disable, add).
  If the document already exists, change only what you need, typically the
  `enabled` flags, and keep every other set exactly as it is.

  Do NOT put a webfont <link> (or its preconnect) in a page fragment: it
  loads for that one page only, so changing the typeface becomes an edit per
  page. A page write that carries one is accepted with a warning (rule
  `page-resource-link`). To switch typeface: change font-sans in the tokens
  and the stylesheet href in resources.json — two writes, zero page edits.
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
    // The external-resources document as stored (webfonts live here, not in
    // pages — see the guide), with its version for a `base_version` replace.
    // `null` when the project has none yet. The raw row is parsed leniently:
    // an agent needs to SEE a document the manifest refused in order to fix it.
    let resources = files
        .iter()
        .find(|f| f.path == crate::resources::RESOURCES_PATH)
        .map(|f| {
            json!({
                "path": f.path,
                "version": f.version,
                "doc": serde_json::from_str::<serde_json::Value>(&f.content)
                    .unwrap_or_else(|_| json!(f.content)),
            })
        })
        .unwrap_or(serde_json::Value::Null);

    Ok(Json(json!({
        "tokens_css": tokens_css,
        "tokens_json": tokens_json,
        "tokens": manifest::to_json(&m)["tokens"],
        "components": manifest::to_json(&m)["components"],
        "routes": manifest::to_json(&m)["routes"],
        "revision": revision,
        "primitives": crate::primitives::catalog(),
        "resources": resources,
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
            // `file`, not `path`. This response was the one place left where a
            // file was spelled `path` while `design_list_components` spells a
            // ROUTE `path` (`manifest::RouteEntry`, served verbatim), so
            // `routes.find(r => r.path === page.path)` — the habit that tool
            // teaches — compared a route against `pages/index.html` and found
            // nothing. `design_read_layout` was renamed for exactly this reason
            // and this is the same key on the same surface; it is a rename
            // rather than a second key, so a caller reaching for `path` here
            // gets nothing rather than a value that means the opposite thing.
            "file": row.path,
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
///
/// The fragment is spelled `file`, like every other design read: `path` is a
/// ROUTE in `design_list_components` (`routes[].path`, `manifest::RouteEntry`
/// served verbatim), so a response handing back a file under that word is the
/// same collision `design_read_page` and `design_read_layout` were renamed for,
/// one endpoint over.
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
            // `file`, not `path`: the registry spells a ROUTE `path`
            // (`routes[].path` IS the route), and in the registry's own component
            // entries the fragment is `file` too (`components[].file`), so this
            // response was the last one where an agent comparing the two would
            // be holding a file name under a word that means a route next door.
            // The rename is safe for the same reason `design_read_page`'s was:
            // nothing reads this body's fields, the MCP client returns it whole.
            "file": row.path,
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
/// The arrangement is readable here and writable at the same path by
/// `write_layout`, whose body is an OPERATION rather than a document — the
/// contract change this read was waiting on. The AGENT write is no longer
/// UNCONDITIONALLY last-write-wins: the row carries a `version`, and a supplied
/// stale one is refused rather than applied — a write that supplies none still
/// applies to whatever is stored. The operator's save still always wins and
/// merely moves that number, so a conflict is a thing an agent can be told
/// about, never a thing the human's own save can hit. The warning below still
/// binds: this response is the panel's view, lossy in both directions, and
/// must never be PUT back.
///
/// The document comes from `views::load_layout` — the SAME loader the operator
/// read uses, so the forgiving rules are one implementation rather than two, and
/// a document naming a page that has since been deleted is served with that
/// route filtered out rather than refused.
///
/// # This response is NOT the document, and must never be PUT back as one
///
/// An agent writing the layout: this response is the panel's view of the
/// arrangement, not the stored document, and the difference is lossy in both
/// directions.
///   * a group's `routes` here are in FLOW order; the stored array is
///     ASSIGNMENT order, which `validate` stores by (`assignRoute` appends) and
///     this read never reveals. `layout_doc.rs::panel_sections` says why.
///   * `flow` is RESOLVED — every page in the project has a position, including
///     pages the stored `route_order` has never named. `layout_doc.rs::
///     resolve_route_order` says why.
///   * `pages[].name` is a label-or-title composite (`layout_doc::page_name`,
///     which the shared case table pins against the client's `pageLabel`);
///     `page_labels` is the stored half of it.
/// So a write tool that PUTs this shape back would silently reorder every group
/// by the flow and claim a flow the operator never set. Either read the stored
/// document (the operator route's `GET`, or the row itself) or pass the four
/// stored fields explicitly — but do not round-trip this.
pub async fn read_layout(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentLayoutQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    authorized_project(&agent, q.project)?;
    let (doc, m, version) = crate::views::load_layout(agent.project_id).await?;
    let paths: Vec<String> = m.routes.iter().map(|r| r.path.clone()).collect();
    let flow = layout_doc::resolve_route_order(&doc, &paths);
    let (groups, ungrouped) = layout_doc::panel_sections(&doc, &paths);

    // Every page in flow order, named the way the panel names it: a page's
    // label if it has one, else the manifest's own title. The route is the key
    // everything else here uses, so it is carried on the entry rather than left
    // to the reader to match up by position.
    //
    // `flow` is a permutation of THIS manifest's routes — `resolve_route_order`
    // only ever emits paths it was handed — so the lookup below cannot miss and
    // carries no fallback: an entry is either found or the invariant is broken.
    // It is looked up by route (one map, not a scan per page) and the two
    // functions' outputs are asserted against the same routes by a test that
    // counts them, so a miss would be a failing suite rather than a page
    // silently dropped or a name invented out of the route.
    let by_route: std::collections::HashMap<&str, &manifest::RouteEntry> =
        m.routes.iter().map(|r| (r.path.as_str(), r)).collect();
    let pages: Vec<serde_json::Value> = flow
        .iter()
        .filter_map(|route| by_route.get(route.as_str()).copied())
        .map(|entry| {
            let name = layout_doc::page_name(&doc, &entry.path, &entry.title);
            json!({
                "route": entry.path,
                "name": name,
                "title": entry.title,
                // `file`, not `path`: in `design_list_components` a route's
                // `path` IS the route (`manifest::RouteEntry` is served
                // verbatim, so `routes[].path` is `/settings`), and this key
                // holding a file name would be the same word meaning the
                // opposite thing. So this response spells the fragment `file`
                // and the route `route` — the registry spells the same route
                // `path`, which is why the route is never `path` HERE.
                "file": entry.file,
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
        // #508: the user flow. Arrows between pages by route, in creation
        // order, and each pinned page's canvas position. Both are the stored
        // fields verbatim (after dropping pages that are gone).
        "edges": doc.edges,
        "positions": doc.positions,
        // Two different numbers answering two different questions, and the one
        // to hand BACK is `version`: the layout row's own, `0` while nothing
        // has been arranged, and what a write's `base_version` is compared
        // against (a mismatch is a 409 carrying the current document).
        // `revision` is `max(design_file.version)` — the fragment revision the
        // canvas reloads on — and says nothing about the arrangement, so it is
        // never a base for one: do not round-trip it.
        "version": version,
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
                 manifest title) and gives its `file` — the fragment behind the \
                 route, spelled as design_list_components spells it. In THIS \
                 response a route is always `route`, never `path` — note that \
                 design_list_components spells a route `path` (`routes[].path`), \
                 so the two tools do NOT agree on that word: match on `route` \
                 here, and on `path` against its `routes`. `view` is the canvas \
                 arrangement \
                 (rows/bands/groups/flow) and the grouping reads the same in \
                 every one; `flow` is the user-flow canvas. `edges` is the user flow drawn as arrows on the Flow \
                 canvas: each `{id, from, to, label?}` says a user goes from \
                 route `from` to route `to` (the label names the path, e.g. \
                 \"new user\" / \"existing user\"). `positions` maps a route \
                 to its fixed `{x, y}` node on that canvas; an unlisted page is \
                 auto-placed. Arrange it with the layout write tools, which take an \
                 operation — never PUT a document built from this response \
                 back, because this is the panel's view and not the stored \
                 form."
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
pub struct AgentTrashPageInput {
    pub project: i64,
    pub route: String,
    pub reason: String,
}

/// `DELETE /api/taskflow/agents/design/page` — #501: move a page to the trash.
///
/// A TRASH, not a delete: the row stays, soft-deleted, and the operator can
/// restore it from the Pages panel. Like retiring a component it needs a real
/// `reason` — the operator reads it in the activity trail — but unlike one it
/// is never refused for being in use: nothing references a page by name.
pub async fn trash_page(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentTrashPageInput>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    if input.reason.trim().len() < 8 {
        return Ok(tokens_validation_error(
            "missing-reason",
            "design_delete_page requires a real `reason`: why should this page go?".to_string(),
        ));
    }
    let (path, _) = crate::views::trash_page_by_route(agent.project_id, input.route.trim()).await?;
    Ok((
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "trashed": path,
            "route": input.route,
            "note": format!(
                "{} moved to the trash. It no longer renders or appears in the manifest; the \
                 operator can restore it from the Pages panel. Writing a new page at {} \
                 discards the trashed copy.",
                input.route, input.route
            ),
        })),
    )
        .into_response())
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
    /// Merge shape `{category: {key: {light?, dark?} | null}}`: only what it
    /// names changes (see `tokens::apply_patch`). `design_compare`'s `apply`
    /// diff is exactly this. Exactly one of `tokens`/`css`/`patch`.
    #[serde(default)]
    pub patch: Option<serde_json::Value>,
    /// Refuse with 409 if `styles/tokens.json` moved past this version.
    #[serde(default)]
    pub base_version: Option<i64>,
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

    let given = [input.tokens.is_some(), input.css.is_some(), input.patch.is_some()]
        .iter()
        .filter(|g| **g)
        .count();
    if given != 1 {
        return Ok(tokens_validation_error(
            "tokens-or-css",
            "design_write_tokens takes exactly ONE of `patch` (only the tokens you change — \
             preferred for edits), `tokens` (a whole JSON token document) or `css` (legacy \
             tokens.css text)."
                .to_string(),
        ));
    }

    // The stored document: what a patch merges onto, and what the reply
    // diffs against.
    let current = store::load_file(input.project, "styles/tokens.json").await;
    let before = current
        .as_ref()
        .and_then(|row| serde_json::from_str::<TokensDoc>(&row.content).ok())
        .unwrap_or_default();

    // The version the write is checked against: the caller's, or — for a
    // patch — the one it was merged onto, so a concurrent write surfaces as
    // a 409 instead of being silently overwritten by a stale merge.
    let mut base_version = input.base_version;
    let doc = if let Some(patch) = input.patch {
        let mut doc = match &current {
            Some(row) => match serde_json::from_str::<TokensDoc>(&row.content) {
                Ok(doc) => doc,
                Err(_) => {
                    return Ok(tokens_validation_error(
                        "invalid-json",
                        "The stored tokens document could not be read, so a patch cannot be \
                         merged into it; write the whole document with `tokens` instead."
                            .to_string(),
                    ));
                }
            },
            None => TokensDoc::default(),
        };
        if let Err(err) = crate::tokens::apply_patch(&mut doc, &patch) {
            return Ok(tokens_validation_error("invalid-patch", err));
        }
        if base_version.is_none() {
            base_version = current.as_ref().map(|row| row.version);
        }
        doc
    } else if let Some(tokens) = input.tokens {
        match serde_json::from_value::<TokensDoc>(tokens) {
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
        }
    } else {
        css_to_tokens_json(input.css.as_deref().unwrap_or_default())
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

    // Written like every agent write (same lock, validator, conflict rules),
    // but answered compactly: a token write re-renders EVERY route, so the
    // shared reply — the stored file echoed back plus every route named twice
    // — cost ~2k tokens for a one-line change. The caller already has the
    // document; what it needs is the new version and what changed.
    let by = format!("{} ({})", agent.display_name, agent.agent_id);
    let outcome = project_locks()
        .with_lock(agent.project_id, || async {
            store::write_file(agent.project_id, "styles/tokens.json", &content, base_version, &by).await
        })
        .await;
    match outcome {
        WriteOutcome::Saved(row, verdict) => {
            let changes = crate::tokens::diff(&before, &doc);
            let routes = crate::views::affected_routes_for(&row.path, agent.project_id).await.len();
            const SHOWN: usize = 40;
            let names: Vec<&str> = changes.iter().take(5).map(|c| c.var.as_str()).collect();
            let note = format!(
                "tokens.json is now v{}: {} token(s) changed{}; {routes} route(s) re-render.",
                row.version,
                changes.len(),
                if names.is_empty() {
                    String::new()
                } else {
                    format!(
                        " ({}{})",
                        names.join(", "),
                        if changes.len() > names.len() { ", …" } else { "" }
                    )
                },
            );
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "ok": true,
                    "path": row.path,
                    "version": row.version,
                    "changed": changes.iter().take(SHOWN).collect::<Vec<_>>(),
                    "changed_count": changes.len(),
                    "routes_affected": routes,
                    "warnings": verdict.warnings,
                    "note": note,
                })),
            )
                .into_response())
        }
        WriteOutcome::Rejected(v) => Ok(rejection_response(&v)),
        WriteOutcome::Conflict(row) => Ok(conflict_response(&row)),
    }
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
            // Compact on purpose: the caller just sent this content, so the
            // stored row comes back WITHOUT it (a page write used to double its
            // own cost), and the routes it touched are a count, named only
            // while there are few — a shared component can reach dozens.
            let affected = crate::views::affected_routes_for(&row.path, project_id).await;
            let subject = row.path.split('/').next_back().unwrap_or(&row.path);
            const LISTED: usize = 10;
            let line = match affected.len() {
                0 => format!("{subject} is now v{}.", row.version),
                n if n <= 5 => format!("{subject} is now v{}; {n} route(s) re-render: {}", row.version, affected.join(", ")),
                n => format!("{subject} is now v{}; {n} route(s) re-render.", row.version),
            };
            let mut file = serde_json::to_value(&row).unwrap_or_default();
            if let Some(obj) = file.as_object_mut() {
                obj.remove("content");
            }
            let mut body = json!({
                "ok": true,
                "file": file,
                "warnings": verdict.warnings,
                "routes_affected": affected.len(),
                "note": line,
            });
            if affected.len() <= LISTED {
                body["affected_routes"] = json!(affected);
            }
            Ok((StatusCode::CREATED, Json(body)).into_response())
        }
        WriteOutcome::Rejected(v) => Ok(rejection_response(&v)),
        WriteOutcome::Conflict(row) => Ok(conflict_response(&row)),
    }
}

/// The arrangement edits an agent may make.
///
/// One enum on one route because these are edits to ONE resource — the
/// document — not separate resources. Never a document in, either: the read
/// response is the panel's view and is lossy in both directions, so a payload
/// that PUT it back would silently reorder every group by the flow
/// (`agent_views.rs` read_layout, "This response is NOT the document").
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutOp {
    /// Add an empty group. The name rules live in `validate`.
    CreateGroup { name: String },
    /// Rename one group. Membership is `ReorderPage`'s job.
    UpdateGroup { group_id: String, name: String },
    /// Move a group to a 1-based slot in the group list.
    ReorderGroup { group_id: String, position: usize },
    /// Move a page into a group and/or to a 1-based position in its section.
    ReorderPage {
        route: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        position: Option<usize>,
    },
    /// #501: remove a group; its pages fall back to Ungrouped, none is deleted.
    DeleteGroup { group_id: String },
    /// #508: draw a flow arrow `from → to` ("the user goes from here to
    /// there"), optionally labelled ("new user"). Mints the edge id.
    LinkPages {
        from: String,
        to: String,
        #[serde(default)]
        label: Option<String>,
    },
    /// #508: remove a flow arrow, named by `edge_id` OR by `from` + `to`.
    UnlinkPages {
        #[serde(default)]
        edge_id: Option<String>,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    /// #508: relabel a flow arrow; an absent, null or blank label clears it.
    UpdateLink {
        edge_id: String,
        #[serde(default)]
        label: Option<String>,
    },
    /// #508: pin a page's node at `(x, y)` on the Flow canvas. Not to be
    /// confused with `ReorderPage`, which moves a page in the LIST.
    PlacePage { route: String, x: f64, y: f64 },
}

impl LayoutOp {
    /// The op's wire name, for an error that has to say WHICH op of a batch.
    fn name(&self) -> &'static str {
        match self {
            LayoutOp::CreateGroup { .. } => "create_group",
            LayoutOp::UpdateGroup { .. } => "update_group",
            LayoutOp::ReorderGroup { .. } => "reorder_group",
            LayoutOp::ReorderPage { .. } => "reorder_page",
            LayoutOp::DeleteGroup { .. } => "delete_group",
            LayoutOp::LinkPages { .. } => "link_pages",
            LayoutOp::UnlinkPages { .. } => "unlink_pages",
            LayoutOp::UpdateLink { .. } => "update_link",
            LayoutOp::PlacePage { .. } => "place_page",
        }
    }
}

/// #501: the most edits one batch may carry. Generous for rearranging a board
/// (a page per op) while keeping one request's lock hold bounded.
const MAX_LAYOUT_OPS: usize = 100;

/// Exactly one of `op` (a single edit) or `ops` (a batch, #501). A batch is
/// applied in order to ONE document under ONE lock and stored as ONE version:
/// every op lands or none does, so a half-applied rearrangement is never saved.
#[derive(Debug, Deserialize)]
pub struct AgentLayoutWrite {
    pub project: i64,
    #[serde(default)]
    pub base_version: Option<i64>,
    #[serde(default)]
    pub op: Option<LayoutOp>,
    #[serde(default)]
    pub ops: Option<Vec<LayoutOp>>,
}

/// What one op touched beyond what the op itself names: the group id a create
/// minted, and the flow edge a link op minted or resolved (#508).
#[derive(Default)]
struct OpEffect {
    minted_group: Option<String>,
    edge: Option<String>,
}

/// Apply one op to `doc`, returning the next document and its `OpEffect`.
/// Every rule failure is the op's own message, for a 400.
fn apply_layout_op(
    doc: LayoutDoc,
    known: &[String],
    op: &LayoutOp,
) -> Result<(LayoutDoc, OpEffect), String> {
    let none = |next: LayoutDoc| (next, OpEffect::default());
    match op {
        LayoutOp::CreateGroup { name } => {
            let (next, id) = layout_doc::create_group(doc, name);
            Ok((next, OpEffect { minted_group: Some(id), edge: None }))
        }
        LayoutOp::UpdateGroup { group_id, name } => {
            layout_doc::rename_group(doc, group_id, name).map(none)
        }
        LayoutOp::ReorderGroup { group_id, position } => {
            layout_doc::move_group(doc, group_id, *position).map(none)
        }
        LayoutOp::ReorderPage { route, group_id, position } => {
            // Spec §6: `group_id` alone appends to that group, `position`
            // alone moves the page within its section, both does both —
            // and NEITHER asks for nothing at all. Refused here, in the
            // handler, rather than only in the tool schema: a schema is
            // a client-side courtesy, and a direct call would otherwise
            // re-append the page to its own section and report success.
            if group_id.is_none() && position.is_none() {
                return Err("reorder_page needs a group_id, a position, or both".to_string());
            }
            layout_doc::place_page(doc, known, route, group_id.as_deref(), *position)
                .map(none)
        }
        LayoutOp::DeleteGroup { group_id } => {
            layout_doc::delete_group(doc, group_id).map(none)
        }
        LayoutOp::LinkPages { from, to, label } => {
            let (next, id) = layout_doc::link_pages(doc, known, from, to, label.as_deref())?;
            Ok((next, OpEffect { minted_group: None, edge: Some(id) }))
        }
        LayoutOp::UnlinkPages { edge_id, from, to } => {
            let id = layout_doc::find_edge(&doc, edge_id.as_deref(), from.as_deref(), to.as_deref())?;
            let next = layout_doc::unlink_pages(doc, &id)?;
            Ok((next, OpEffect { minted_group: None, edge: Some(id) }))
        }
        LayoutOp::UpdateLink { edge_id, label } => {
            let next = layout_doc::update_link(doc, edge_id, label.as_deref())?;
            Ok((next, OpEffect { minted_group: None, edge: Some(edge_id.clone()) }))
        }
        LayoutOp::PlacePage { route, x, y } => {
            layout_doc::set_position(doc, known, route, *x, *y).map(none)
        }
    }
}

/// What one write did, resolved inside the lock so the response can be built
/// without holding it.
enum LayoutOutcome {
    Written {
        version: i64,
        groups: Vec<String>,
        routes: Vec<String>,
        edges: Vec<String>,
        positions: Vec<String>,
    },
    Conflict {
        current: i64,
        doc: serde_json::Value,
    },
    Invalid(String),
}

/// `PUT /api/taskflow/agents/design/layout` — the agent's arrangement write.
///
/// Read-modify-write inside the project lock, exactly as the operator's
/// `put_layout` does, so an agent's edit and the operator's save cannot
/// interleave.
///
/// It begins from the SERVED view (`filter_to_known`), not the stored row.
/// `validate` REJECTS a route the manifest no longer has, while `load_layout`
/// FILTERS one out; a write that started from the raw row would therefore fail
/// forever the moment a page was deleted, naming a page nobody can see. That
/// asymmetry is deliberate on both sides — see `layout_doc`'s module docs — and
/// this is the composition that respects it.
///
/// A row that exists but will not PARSE is a 500 and nothing is written. The
/// read's fallback to `default_doc()` is right for a read and catastrophic
/// here: it would persist `default + op` and discard the real arrangement.
pub async fn write_layout(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentLayoutWrite>,
) -> Result<Response, StatusCode> {
    authorized_project(&agent, input.project)?;
    // Exactly one of `op` / `ops`, and a batch that is neither empty nor huge.
    let ops: Vec<LayoutOp> = match (input.op, input.ops) {
        (Some(op), None) => vec![op],
        (None, Some(ops)) if !ops.is_empty() && ops.len() <= MAX_LAYOUT_OPS => ops,
        (None, Some(ops)) => {
            return Ok(layout_invalid(format!(
                "ops must hold between 1 and {MAX_LAYOUT_OPS} operations, not {}",
                ops.len()
            )));
        }
        _ => {
            return Ok(layout_invalid(
                "send exactly one of `op` (a single edit) or `ops` (a batch)".to_string(),
            ));
        }
    };
    let project_id = agent.project_id;
    let by = format!("{} ({})", agent.display_name, agent.agent_id);
    let known = crate::views::known_routes(project_id).await;

    let outcome = crate::views::project_locks()
        .with_lock(project_id, || async {
            let existing = DesignLayout::objects()
                .filter(design_layout::PROJECT.eq(project_id))
                .first()
                .await
                .map_err(|err| {
                    eprintln!("design layout read: {err}");
                    StatusCode::INTERNAL_SERVER_ERROR
                })?;

            let current_version = existing.as_ref().map(|row| row.version).unwrap_or(0);

            let stored = match existing.as_ref() {
                Some(row) => layout_doc::parse(&row.layout_json).map_err(|err| {
                    eprintln!(
                        "design layout write refused: the stored document will not parse: {err}"
                    );
                    StatusCode::INTERNAL_SERVER_ERROR
                })?,
                None => layout_doc::default_doc(),
            };
            let doc = layout_doc::filter_to_known(stored, &known);

            // A supplied base that does not match is refused; an OMITTED base
            // is the normal case and simply proceeds at the current version,
            // which is what makes the tool safe for an agent that never read.
            if let Some(base) = input.base_version {
                if base != current_version {
                    return Ok(LayoutOutcome::Conflict {
                        current: current_version,
                        doc: layout_doc::to_value(&doc),
                    });
                }
            }

            let before_doc = doc.clone();

            // Applied in order, each to the result of the one before, so a
            // batch can create a group and then fill it only if the caller
            // already knows the id — ids are minted here, never predictable.
            // The first failure refuses the WHOLE batch and names its index.
            let batched = ops.len() > 1;
            let mut next = doc;
            let mut minted: Vec<String> = Vec::new();
            let mut changed_edges: Vec<String> = Vec::new();
            for (index, op) in ops.iter().enumerate() {
                match apply_layout_op(next, &known, op) {
                    Ok((doc, effect)) => {
                        next = doc;
                        minted.extend(effect.minted_group);
                        if let Some(edge) = effect.edge {
                            if !changed_edges.contains(&edge) {
                                changed_edges.push(edge);
                            }
                        }
                    }
                    Err(message) => {
                        return Ok(LayoutOutcome::Invalid(if batched {
                            format!(
                                "ops[{index}] ({}) was refused, so none of the {} ops was applied: {message}",
                                op.name(),
                                ops.len()
                            )
                        } else {
                            message
                        }));
                    }
                }
            }

            // Note the `return Ok(...)`: the closure's error type is
            // `StatusCode`, and a rule failure is a 400 with `validate`'s or the
            // operation's own message, not a 500. `?` cannot do this conversion,
            // so every fallible step is matched explicitly.
            let validated = match layout_doc::validate(next, &known) {
                Ok(doc) => doc,
                Err(message) => return Ok(LayoutOutcome::Invalid(message)),
            };

            let json = layout_doc::to_json_string(&validated);
            if json.len() > 65536 {
                // `delete_group` is the one op that shrinks the document, and
                // it can only do so in a write of its own — this write, which
                // would have grown it, is refused whole. Say so, rather than
                // inviting a retry of the same write that cannot succeed.
                return Ok(LayoutOutcome::Invalid(format!(
                    "the arrangement is too large to store ({} bytes, over the 65536-byte \
                     limit). Retrying this write will fail the same way; shrink the board \
                     first (delete_group removes a group, or the operator can drop pages \
                     and groups in the Pages panel).",
                    json.len()
                )));
            }

            let next_version = current_version + 1;
            match existing.as_ref() {
                Some(row) => {
                    let updated = DesignLayout::objects()
                        .filter(
                            design_layout::ID.eq(row.id) & design_layout::VERSION.eq(row.version),
                        )
                        .update_values(
                            json!({
                                "view": validated.view,
                                "layout_json": json,
                                "updated_by": by,
                                "updated_at": chrono::Utc::now(),
                                "version": next_version,
                            })
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                        )
                        .await
                        .map_err(|err| {
                            eprintln!("design layout agent update: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                    if updated == 0 {
                        // Slipped past the lock. Report what is STORED now — not
                        // the version this write tried from, which this outcome
                        // has just proved stale, and not the document it meant to
                        // store, which never landed. A caller told to merge has to
                        // merge against reality.
                        let fresh = DesignLayout::objects()
                            .filter(design_layout::PROJECT.eq(project_id))
                            .first()
                            .await
                            // `.ok()` below keeps the fallback rather than
                            // failing the request, but the reason has to reach
                            // the log — every other failure path in this
                            // function says why before it degrades.
                            .map_err(|err| eprintln!("design layout agent conflict re-read: {err}"))
                            .ok()
                            .flatten()
                            .and_then(|row| {
                                layout_doc::parse(&row.layout_json).ok().map(|doc| {
                                    (
                                        row.version,
                                        layout_doc::to_value(&layout_doc::filter_to_known(
                                            doc, &known,
                                        )),
                                    )
                                })
                            });
                        return Ok(match fresh {
                            Some((version, doc)) => LayoutOutcome::Conflict {
                                current: version,
                                doc,
                            },
                            // The re-read failed, the row is gone, or its bytes
                            // will not parse: there is nothing truer to report, so
                            // this falls back to the version the write tried from
                            // and the document it meant to store. Both are stale,
                            // and neither pretends to be the stored row.
                            None => LayoutOutcome::Conflict {
                                current: row.version,
                                doc: layout_doc::to_value(&validated),
                            },
                        });
                    }
                }
                None => {
                    DesignLayout::objects()
                        .create(DesignLayout {
                            id: 0,
                            project: umbral::orm::ForeignKey::new(project_id),
                            view: validated.view,
                            layout_json: json,
                            version: 1,
                            updated_by: by,
                            created_at: None,
                            updated_at: None,
                        })
                        .await
                        .map_err(|err| {
                            eprintln!("design layout agent create: {err}");
                            StatusCode::INTERNAL_SERVER_ERROR
                        })?;
                }
            }

            // A create reports the id it minted; the others report the group
            // the caller named, since that is what was asked about. Over a
            // batch: every one, in op order, each once.
            let mut minted_ids = minted.into_iter();
            let mut changed_groups: Vec<String> = Vec::new();
            for op in ops.iter() {
                let named = match op {
                    LayoutOp::CreateGroup { .. } => minted_ids.next(),
                    LayoutOp::UpdateGroup { group_id, .. }
                    | LayoutOp::ReorderGroup { group_id, .. }
                    | LayoutOp::DeleteGroup { group_id } => Some(group_id.clone()),
                    LayoutOp::ReorderPage { group_id, .. } => group_id.clone(),
                    LayoutOp::LinkPages { .. }
                    | LayoutOp::UnlinkPages { .. }
                    | LayoutOp::UpdateLink { .. }
                    | LayoutOp::PlacePage { .. } => None,
                };
                if let Some(id) = named {
                    if !changed_groups.contains(&id) {
                        changed_groups.push(id);
                    }
                }
            }

            // Which pages changed VISIBLE position. A positional diff of the raw
            // flow would flag pages whose global index moved while nothing a
            // reader can see changed — and a placement materialises the flow
            // (D6), so that is most of them. Compare each page's 1-based index
            // WITHIN ITS SECTION instead, which is the numbering the panel
            // shows: that is what "did anything move?" means.
            let section_index = |doc: &LayoutDoc| {
                let (groups, ungrouped) = layout_doc::panel_sections(doc, &known);
                let mut map: std::collections::HashMap<String, usize> =
                    std::collections::HashMap::new();
                for group in groups {
                    for (index, route) in group.routes.into_iter().enumerate() {
                        map.insert(route, index + 1);
                    }
                }
                for (index, route) in ungrouped.into_iter().enumerate() {
                    map.insert(route, index + 1);
                }
                map
            };
            let before_positions = section_index(&before_doc);
            let after_positions = section_index(&validated);
            let mut changed_routes: Vec<String> = after_positions
                .iter()
                .filter(|(route, position)| before_positions.get(*route) != Some(*position))
                .map(|(route, _)| route.clone())
                .collect();
            // A page that changed SECTION but happened to keep its index would
            // not show up above, and it is the very page the caller named.
            for op in ops.iter() {
                if let LayoutOp::ReorderPage { route, .. } = op {
                    if !changed_routes.contains(route) {
                        changed_routes.push(route.clone());
                    }
                }
            }
            changed_routes.sort();

            // #508: the pages whose canvas position a `place_page` set, in op
            // order, each once. Kept apart from `routes`, which is the LIST
            // numbering — a canvas placement never moves a page in the list.
            let mut changed_positions: Vec<String> = Vec::new();
            for op in ops.iter() {
                if let LayoutOp::PlacePage { route, .. } = op {
                    if !changed_positions.contains(route) {
                        changed_positions.push(route.clone());
                    }
                }
            }

            // The type is named at the tail so the earlier `return`s resolve:
            // the closure's error side is `StatusCode` (same turbofish idiom as
            // `views.rs::put_layout`), which is what makes a rule failure a 400
            // and a broken row a 500 without either being inferred.
            Ok::<LayoutOutcome, StatusCode>(LayoutOutcome::Written {
                version: next_version,
                groups: changed_groups,
                routes: changed_routes,
                edges: changed_edges,
                positions: changed_positions,
            })
        })
        .await?;

    Ok(match outcome {
        LayoutOutcome::Written { version, groups, routes, edges, positions } => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "version": version,
                "changed": {
                    "groups": groups,
                    "routes": routes,
                    "edges": edges,
                    "positions": positions,
                },
            })),
        )
            .into_response(),
        LayoutOutcome::Conflict { current, doc } => conflict_response_values(current, doc),
        LayoutOutcome::Invalid(message) => layout_invalid(message),
    })
}

/// The layout write's 400: one shape for a rule an op broke and for a body
/// that named no op at all.
fn layout_invalid(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": "invalid_operation", "message": message })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct AgentScreenshotQuery {
    pub project: i64,
    pub route: String,
    #[serde(default = "default_viewport")]
    pub viewport: String,
    #[serde(default)]
    pub state: Option<String>,
    /// A custom size in CSS px (both or neither); overrides the preset's size.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub dpr: Option<u32>,
    /// Override mobile emulation (default: the preset's).
    #[serde(default)]
    pub mobile: Option<bool>,
    /// Capture the whole scrollable page.
    #[serde(default)]
    pub full_page: bool,
    /// `none` | `classic` | `device` — the export's three dresses.
    #[serde(default)]
    pub frame: crate::screenshots::Frame,    /// `light` | `dark` | `both`.
    #[serde(default)]
    pub theme: crate::screenshots::Theme,
    /// #522: unsaved overrides — a JSON object `{"--name": value | {light, dark}}`
    /// (a query string carries it as a JSON string).
    #[serde(default)]
    pub tokens: Option<String>,
    /// #522: extra CSS for what tokens cannot express.
    #[serde(default)]
    pub css: Option<String>,
    /// Longest side of the returned image (default 1568, the size the model
    /// reads at; 0 = full resolution, e.g. for a human).
    #[serde(default)]
    pub max_px: Option<u32>,
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
    let tokens = match q.tokens.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(raw) => match serde_json::from_str(raw) {
            Ok(map) => map,
            Err(e) => {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "detail": format!("tokens must be a JSON object of --name → value: {e}") })),
                )
                    .into_response());
            }
        },
        None => Default::default(),
    };
    let req = crate::screenshots::ScreenshotRequest {
        viewport: q.viewport.clone(),
        width: q.width,
        height: q.height,
        dpr: q.dpr,
        mobile: q.mobile,
        full_page: q.full_page,
        frame: q.frame,
        theme: q.theme,
        overrides: crate::compare::Overrides { tokens, css: q.css.clone() },
        max_px: q.max_px.unwrap_or(crate::screenshots::AGENT_MAX_PX),
    };
    let shot = match crate::screenshots::render_screenshot(
        &q.route,
        &req,
        q.state.as_deref(),
        || crate::sandbox::mint(agent.project_id),
    )
    .await
    {
        Ok(shot) => shot,
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
        Err(err @ (crate::screenshots::RenderError::UnknownViewport(_)
        | crate::screenshots::RenderError::BadSize(_)
        | crate::screenshots::RenderError::BadOverrides(_))) => {
            return Ok((StatusCode::BAD_REQUEST, Json(json!({ "detail": err.to_string() }))).into_response());
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
    let b64 = base64::engine::general_purpose::STANDARD.encode(&shot.png);
    Ok(Json(json!({
        "route": q.route,
        // A custom size is not the preset it was sent alongside.
        "viewport": if q.width.is_some() { "custom".to_string() } else { q.viewport.clone() },
        "size": shot.viewport,
        "image": png_size(&shot.png),
        "theme": q.theme,
        "full_page": q.full_page,
        "frame": q.frame,
        "warnings": shot.warnings,
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

// ---------------------------------------------------------------------------
// #522: design_compare
// ---------------------------------------------------------------------------

/// A route to compare: a path, or `{route, state?, label?}`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CompareRouteInput {
    Path(String),
    Full(crate::compare::GridRoute),
}

#[derive(Debug, Deserialize)]
pub struct CompareVariantInput {
    pub label: String,
    #[serde(default)]
    pub tokens: std::collections::BTreeMap<String, crate::compare::OverrideValue>,
    #[serde(default)]
    pub css: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentCompareInput {
    pub project: i64,
    pub routes: Vec<CompareRouteInput>,
    pub variants: Vec<CompareVariantInput>,
    /// `["light"]` when absent.
    #[serde(default)]
    pub themes: Option<Vec<String>>,
    /// Preset id; default `iphone-16-pro`.
    #[serde(default)]
    pub viewport: Option<String>,
    /// A custom cell size in CSS px (both or neither).
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub checks: Vec<crate::compare::ContrastCheck>,
    /// Cell scale, 0.2–1 (default 0.5).
    #[serde(default)]
    pub scale: Option<f32>,
    /// Overrides every variant starts from (a variant's own win).
    #[serde(default)]
    pub tokens: std::collections::BTreeMap<String, crate::compare::OverrideValue>,
    /// CSS every variant gets (before a variant's own).
    #[serde(default)]
    pub css: Option<String>,
    /// Return `apply`: per variant, the patch that would make it the design.
    #[serde(default)]
    pub include_apply: bool,
    /// Longest side of each returned image (default 1568; 0 = full size).
    #[serde(default)]
    pub max_px: Option<u32>,
}

fn bad_request(detail: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "detail": detail }))).into_response()
}

/// `POST /api/taskflow/agents/design/compare` — render routes × variants ×
/// themes as one labelled grid, with UNSAVED overrides per variant, plus
/// contrast `checks` and, per variant, the `design_write_tokens` payload that
/// would make it the design. Nothing is written.
pub async fn compare(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentCompareInput>,
) -> Result<Response, StatusCode> {
    use base64::Engine as _;
    authorized_project(&agent, input.project)?;

    let viewport_id = input.viewport.clone().unwrap_or_else(|| "iphone-16-pro".to_string());
    let size = match crate::screenshots::resolve_viewport(&crate::screenshots::ScreenshotRequest {
        viewport: viewport_id.clone(),
        width: input.width,
        height: input.height,
        ..Default::default()
    }) {
        Ok(vp) => vp,
        Err(e) => return Ok(bad_request(e.to_string())),
    };
    let shared = crate::compare::Overrides { tokens: input.tokens, css: input.css };
    let spec = crate::compare::GridSpec {
        routes: input
            .routes
            .into_iter()
            .map(|r| match r {
                CompareRouteInput::Path(route) => crate::compare::GridRoute { route, state: None, label: None },
                CompareRouteInput::Full(full) => full,
            })
            .collect(),
        variants: input
            .variants
            .into_iter()
            .map(|v| crate::compare::GridVariant {
                label: v.label,
                overrides: crate::compare::layered(&shared, &crate::compare::Overrides { tokens: v.tokens, css: v.css }),
            })
            .collect(),
        themes: input.themes.unwrap_or_else(|| vec!["light".to_string()]),
        width: size.width,
        height: size.height,
        scale: input.scale.unwrap_or(0.5),
        checks: input.checks,
    };
    if let Err(e) = crate::compare::validate_spec(&spec) {
        return Ok(bad_request(e));
    }
    // Every route must be a page the project has: a missing one would render
    // as a 404 cell that looks like a result.
    let files = store::list_files(input.project).await;
    let manifest = manifest::build(input.project, &files, 0);
    let known: std::collections::HashSet<&str> = manifest.routes.iter().map(|r| r.path.as_str()).collect();
    if let Some(missing) = spec.routes.iter().find(|r| !known.contains(r.route.as_str())) {
        return Ok(bad_request(format!(
            "`{}` is not a page in this project (routes: {})",
            missing.route,
            manifest.routes.iter().map(|r| r.path.as_str()).collect::<Vec<_>>().join(", ")
        )));
    }

    // One grid, or one per route when a single grid would shrink its cells
    // past readable within `max_px`. The parts render concurrently (the
    // sidecar queues past its own limit).
    let max_px = input.max_px.unwrap_or(crate::screenshots::AGENT_MAX_PX);
    let parts = crate::compare::split_for_readability(&spec, max_px);
    let project_id = agent.project_id;
    let handles: Vec<_> = parts
        .iter()
        .cloned()
        .map(|part| {
            tokio::spawn(async move {
                crate::screenshots::render_compare(&part, max_px, move || crate::sandbox::mint(project_id)).await
            })
        })
        .collect();
    let mut renders = Vec::with_capacity(handles.len());
    for handle in handles {
        renders.push(handle.await.unwrap_or_else(|e| {
            Err(crate::screenshots::RenderError::Failed(format!("render task failed: {e}")))
        }));
    }

    let mut images = Vec::new();
    let mut checks: Vec<serde_json::Value> = Vec::new();
    let mut seen_checks = std::collections::HashSet::new();
    let mut warnings = Vec::new();
    for (part, rendered) in parts.iter().zip(renders) {
        let shot = match rendered {
            Ok(shot) => shot,
            Err(crate::screenshots::RenderError::Unconfigured(what)) => {
                return Ok((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "detail": format!("Screenshot renderer not configured on this backend ({what}). Ask your human to set it up."),
                    })),
                )
                    .into_response());
            }
            Err(e @ crate::screenshots::RenderError::BadOverrides(_)) => return Ok(bad_request(e.to_string())),
            Err(other) => {
                eprintln!("design agent compare: {other}");
                return Ok((StatusCode::BAD_GATEWAY, Json(json!({ "detail": other.to_string() }))).into_response());
            }
        };
        warnings.extend(shot.warnings.iter().cloned());
        if let Some(grid_warnings) = shot.data["warnings"].as_array() {
            warnings.extend(grid_warnings.iter().filter_map(|w| w.as_str().map(str::to_string)));
        }
        // Each part measures every variant × theme; keep the first of each.
        for check in shot.data["checks"].as_array().into_iter().flatten() {
            let key = format!("{}|{}|{}|{}", check["variant"], check["theme"], check["fg"], check["bg"]);
            if seen_checks.insert(key) {
                checks.push(check.clone());
            }
        }
        images.push(json!({
            "routes": part.routes.iter().map(|r| r.route.clone()).collect::<Vec<_>>(),
            "size": png_size(&shot.png),
            "png_base64": base64::engine::general_purpose::STANDARD.encode(&shot.png),
        }));
    }

    let mut body = json!({
        "mime": "image/png",
        "images": images,
        "split": parts.len() > 1,
        "grid": {
            "columns": spec.variants.iter().map(|v| v.label.clone()).collect::<Vec<_>>(),
            "rows": spec
                .routes
                .iter()
                .flat_map(|r| spec.themes.iter().map(move |t| json!({ "route": r.route, "theme": t, "label": r.label })))
                .collect::<Vec<_>>(),
            "cell": { "width": spec.width, "height": spec.height, "scale": spec.scale },
        },
        "checks": checks,
        "warnings": warnings,
    });

    // `apply`, only when asked: per variant with token overrides, the PATCH
    // (just the tokens it changes) that makes it the design via
    // `design_write_tokens({patch})`.
    if input.include_apply {
        let doc = files
            .iter()
            .find(|f| f.path == "styles/tokens.json")
            .and_then(|f| serde_json::from_str::<TokensDoc>(&f.content).ok())
            .unwrap_or_default();
        let base_version = files.iter().find(|f| f.path == "styles/tokens.json").map(|f| f.version);
        let mut apply = serde_json::Map::new();
        for v in spec.variants.iter().filter(|v| !v.overrides.tokens.is_empty()) {
            let (patch, added) = crate::compare::apply_diff(&doc, &v.overrides);
            let mut entry = json!({ "patch": patch });
            if !added.is_empty() {
                entry["added_to_custom"] = json!(added);
            }
            if v.overrides.css.is_some() {
                entry["css_not_applied"] = json!(true);
            }
            apply.insert(v.label.clone(), entry);
        }
        body["apply"] = json!(apply);
        body["tokens_version"] = json!(base_version);
    }
    Ok(Json(body).into_response())
}

/// Width and height of a PNG, from its IHDR chunk.
fn png_size(png: &[u8]) -> serde_json::Value {
    let read = |at: usize| png.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    json!({ "width": read(16), "height": read(20) })
}
