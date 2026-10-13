//! #523: the compare GRID — one render core, two doors.
//!
//! #522 gave `design_compare` to agents; #523 is its operator twin, the
//! Compare drawer on the Design Surface. The two must not fork: the grid, its
//! validation, its contrast checks and the `apply` payload are the SAME
//! artefact, and the only real differences are who may ask and where the
//! project id comes from — an agent credential, or the path. So the request
//! shape and the render live here once, and each route parses its own
//! authorization and delegates.
//!
//! `deliver` (#525) stays an agent power: it posts the render into a channel
//! AS the agent. An operator route refuses it rather than ignoring a field the
//! caller clearly meant.

use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use umbral::web::{Json, StatusCode};

use crate::compare::{ContrastCheck, GridRoute, GridSpec, GridVariant, OverrideValue, Overrides};
use crate::manifest;
use crate::store;

/// A route to compare: a path, or `{route, state?, label?}`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CompareRouteInput {
    Path(String),
    Full(GridRoute),
}

#[derive(Debug, Deserialize)]
pub struct CompareVariantInput {
    pub label: String,
    #[serde(default)]
    pub tokens: std::collections::BTreeMap<String, OverrideValue>,
    #[serde(default)]
    pub css: Option<String>,
}

/// The compare request both routes accept. The shared fields are the spec;
/// `project` and the `deliver_*` group are per-door concerns that the handlers
/// read before delegating (and that `render_grid` ignores).
#[derive(Debug, Deserialize)]
pub struct CompareInput {
    /// The AGENT route carries the project here and checks it against its
    /// credential; the operator route takes it from the path and refuses a
    /// body that contradicts it. Absent on every operator request.
    #[serde(default)]
    pub project: Option<i64>,
    /// #525: where the render goes — `inline` (default), `message` (posted to
    /// `deliver_channel` as attachments) or `url`. Flat rather than one object
    /// for the same reason as the screenshot tool: MCP tool schemas.
    #[serde(default)]
    pub deliver: Option<String>,
    #[serde(default)]
    pub deliver_channel: Option<i64>,
    #[serde(default)]
    pub deliver_body: Option<String>,
    #[serde(default)]
    pub deliver_reply_to: Option<i64>,
    pub routes: Vec<CompareRouteInput>,
    pub variants: Vec<CompareVariantInput>,
    /// Theme rows, any the project declares; ["light"] when absent.
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
    pub checks: Vec<ContrastCheck>,
    /// Cell scale, 0.2–1 (default 0.5).
    #[serde(default)]
    pub scale: Option<f32>,
    /// Overrides every variant starts from (a variant's own win).
    #[serde(default)]
    pub tokens: std::collections::BTreeMap<String, OverrideValue>,
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

/// Where the rendered grid parts go. The operator route is always `Inline`.
pub enum GridDelivery<'a> {
    Inline,
    To(&'a taskflow_agents::agent_auth::AgentIdentity, &'a crate::delivery::Delivery),
}

/// Render `routes × variants × themes` as one labelled grid (or one per route
/// when a single grid would shrink its cells past readable), with UNSAVED
/// overrides per variant, plus contrast `checks` and, when asked, the token
/// patch that would make each variant the design. Nothing is written.
pub async fn render_grid(
    project_id: i64,
    input: CompareInput,
    delivery: GridDelivery<'_>,
) -> Result<Response, StatusCode> {
    use base64::Engine as _;

    let viewport_id = input.viewport.clone().unwrap_or_else(|| "iphone-16-pro".to_string());
    let size = match crate::screenshots::resolve_viewport(&crate::screenshots::ScreenshotRequest {
        viewport: viewport_id.clone(),
        width: input.width,
        height: input.height,
        ..Default::default()
    }) {
        Ok(vp) => vp,
        Err(e) => return Ok(crate::views::bad_request(e.to_string())),
    };
    let shared = Overrides { tokens: input.tokens, css: input.css };
    let spec = GridSpec {
        routes: input
            .routes
            .into_iter()
            .map(|r| match r {
                CompareRouteInput::Path(route) => GridRoute { route, state: None, label: None },
                CompareRouteInput::Full(full) => full,
            })
            .collect(),
        variants: input
            .variants
            .into_iter()
            .map(|v| GridVariant {
                label: v.label,
                overrides: crate::compare::layered(&shared, &Overrides { tokens: v.tokens, css: v.css }),
            })
            .collect(),
        themes: input.themes.unwrap_or_else(|| vec!["light".to_string()]),
        width: size.width,
        height: size.height,
        scale: input.scale.unwrap_or(0.5),
        checks: input.checks,
    };
    if let Err(e) = crate::compare::validate_spec(&spec) {
        return Ok(crate::views::bad_request(e));
    }
    // Every route must be a page the project has: a missing one would render
    // as a 404 cell that looks like a result.
    let files = store::list_files(project_id).await;
    let manifest = manifest::build(project_id, &files, 0);
    let known: std::collections::HashSet<&str> = manifest.routes.iter().map(|r| r.path.as_str()).collect();
    if let Some(missing) = spec.routes.iter().find(|r| !known.contains(r.route.as_str())) {
        return Ok(crate::views::bad_request(format!(
            "`{}` is not a page in this project (routes: {})",
            missing.route,
            manifest.routes.iter().map(|r| r.path.as_str()).collect::<Vec<_>>().join(", ")
        )));
    }
    // #619: every theme row and every per-theme override must be a theme the
    // project declares — an unknown one would render light and look like a result.
    let declared = crate::tokens::project_tokens_doc(&files).declared_themes();
    if let Some(unknown) = spec.themes.iter().find(|t| !declared.contains(t)) {
        return Ok(crate::views::bad_request(format!(
            "theme `{unknown}` is not declared in this project (themes: {}); add it with design_write_tokens first",
            declared.join(", ")
        )));
    }
    for v in &spec.variants {
        if let Err(e) = crate::compare::check_override_themes(&v.overrides, &declared) {
            return Ok(crate::views::bad_request(format!("variant `{}`: {e}", v.label)));
        }
    }

    // One grid, or one per route when a single grid would shrink its cells
    // past readable within `max_px`. The parts render concurrently (the
    // sidecar queues past its own limit).
    let max_px = input.max_px.unwrap_or(crate::screenshots::AGENT_MAX_PX);
    let parts = crate::compare::split_for_readability(&spec, max_px);
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
    let mut deliverable: Vec<crate::delivery::RenderedImage> = Vec::new();
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
            Err(e @ crate::screenshots::RenderError::BadOverrides(_)) => return Ok(crate::views::bad_request(e.to_string())),
            Err(other) => {
                eprintln!("design compare: {other}");
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
        let routes: Vec<String> = part.routes.iter().map(|r| r.route.clone()).collect();
        deliverable.push(crate::agent_views::delivered_image(&routes.join("+"), "grid", &shot));
        images.push(json!({
            "routes": routes,
            "size": crate::agent_views::png_size(&shot.png),
            "png_base64": base64::engine::general_purpose::STANDARD.encode(&shot.png),
        }));
    }

    // #525: deliver the grid parts; the reply then carries ids and sizes
    // instead of pixels. `checks`, labels and warnings ride along in every mode.
    let delivered = match delivery {
        GridDelivery::Inline => None,
        GridDelivery::To(agent, delivery) => {
            match crate::delivery::deliver(agent, delivery, deliverable).await {
                Ok(value) => value,
                Err((code, detail)) => return Ok((code, Json(json!({ "detail": detail }))).into_response()),
            }
        }
    };
    if delivered.is_some() {
        for image in images.iter_mut() {
            if let Some(object) = image.as_object_mut() {
                object.remove("png_base64");
            }
        }
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
        let (apply, base_version) = compare_apply(&files, &spec.variants);
        body["apply"] = apply;
        body["tokens_version"] = json!(base_version);
    }
    if let Some(delivered) = delivered {
        body["delivered"] = delivered;
    }
    Ok(Json(body).into_response())
}

/// `design_compare`'s `apply`, per variant with token overrides: the PATCH
/// (just the tokens it changes) that makes it the design via
/// `design_write_tokens({patch})`, plus the stored tokens row's version.
/// Diffs against what RENDERS (stored tokens + built-in defaults), so a token
/// served from the defaults is a change, not an addition.
pub fn compare_apply(
    files: &[crate::models::DesignFile],
    variants: &[GridVariant],
) -> (serde_json::Value, Option<i64>) {
    use crate::tokens::TokensDoc;
    let doc: TokensDoc = crate::defaults::effective_tokens(&crate::tokens::project_tokens_doc(files));
    let base_version = files.iter().find(|f| f.path == "styles/tokens.json").map(|f| f.version);
    let mut apply = serde_json::Map::new();
    for v in variants.iter().filter(|v| !v.overrides.tokens.is_empty()) {
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
    (json!(apply), base_version)
}

/// #702: the operator's comparison — one image PER CELL, at device size and
/// full DPR, instead of one composed grid at the agent's scale.
///
/// The grid render (`render_grid`) exists for the MCP: a single image, capped
/// small because a model pays per pixel. The drawer asked for it too and got
/// half-scale cells shrunk into 1568px, which is exactly what "low quality"
/// looked like. Here each cell is the raw sandbox page — the same URL the grid
/// embeds in an iframe — rendered as the top document, so there is no grid
/// page, no compositing, and no downscale.
///
/// `checks` still come from ONE cheap grid render (scale 0.25): they are
/// measured from computed styles inside the page, so the pixels the grid uses
/// do not affect them.
pub async fn render_cells(project_id: i64, input: CompareInput) -> Result<Response, StatusCode> {
    use base64::Engine as _;
    use crate::compare::{GridRoute, GridSpec, GridVariant, Overrides};

    let viewport_id = input.viewport.clone().unwrap_or_else(|| "iphone-16-pro".to_string());
    let size = match crate::screenshots::resolve_viewport(&crate::screenshots::ScreenshotRequest {
        viewport: viewport_id.clone(),
        width: input.width,
        height: input.height,
        ..Default::default()
    }) {
        Ok(vp) => vp,
        Err(e) => return Ok(crate::views::bad_request(e.to_string())),
    };
    let shared = Overrides { tokens: input.tokens.clone(), css: input.css.clone() };
    let spec = GridSpec {
        routes: input
            .routes
            .iter()
            .map(|r| match r {
                CompareRouteInput::Path(route) => GridRoute { route: route.clone(), state: None, label: None },
                CompareRouteInput::Full(full) => full.clone(),
            })
            .collect(),
        variants: input
            .variants
            .iter()
            .map(|v| GridVariant {
                label: v.label.clone(),
                overrides: crate::compare::layered(&shared, &Overrides { tokens: v.tokens.clone(), css: v.css.clone() }),
            })
            .collect(),
        themes: input.themes.clone().unwrap_or_else(|| vec!["light".to_string()]),
        width: size.width,
        height: size.height,
        scale: 1.0,
        checks: input.checks.clone(),
    };
    if let Err(e) = crate::compare::validate_spec(&spec) {
        return Ok(crate::views::bad_request(e));
    }
    // Same gates as the grid path: every route must be a real page, every theme
    // declared, every override themed. A cell that 404s would look like a result.
    let files = store::list_files(project_id).await;
    let manifest = manifest::build(project_id, &files, 0);
    let known: std::collections::HashSet<&str> = manifest.routes.iter().map(|r| r.path.as_str()).collect();
    if let Some(missing) = spec.routes.iter().find(|r| !known.contains(r.route.as_str())) {
        return Ok(crate::views::bad_request(format!(
            "`{}` is not a page in this project (routes: {})",
            missing.route,
            manifest.routes.iter().map(|r| r.path.as_str()).collect::<Vec<_>>().join(", ")
        )));
    }
    let declared = crate::tokens::project_tokens_doc(&files).declared_themes();
    if let Some(unknown) = spec.themes.iter().find(|t| !declared.contains(t)) {
        return Ok(crate::views::bad_request(format!(
            "theme `{unknown}` is not declared in this project (themes: {}); add it with design_write_tokens first",
            declared.join(", ")
        )));
    }
    for v in &spec.variants {
        if let Err(e) = crate::compare::check_override_themes(&v.overrides, &declared) {
            return Ok(crate::views::bad_request(format!("variant `{}`: {e}", v.label)));
        }
    }

    // One task per cell; the sidecar queues past its own concurrency limit.
    struct Cell {
        variant: String,
        route: String,
        theme: String,
        label: String,
    }
    let mut cells: Vec<Cell> = Vec::new();
    for route in &spec.routes {
        for theme in &spec.themes {
            for variant in &spec.variants {
                cells.push(Cell {
                    variant: variant.label.clone(),
                    route: route.route.clone(),
                    theme: theme.clone(),
                    label: route.label.clone().unwrap_or_else(|| route.route.clone()),
                });
            }
        }
    }

    let handles: Vec<_> = cells
        .iter()
        .map(|cell| {
            let route = spec.routes.iter().find(|r| r.route == cell.route).cloned().expect("route in spec");
            let variant = spec.variants.iter().find(|v| v.label == cell.variant).cloned().expect("variant in spec");
            let theme = cell.theme.clone();
            let spec = spec.clone();
            tokio::spawn(async move {
                crate::screenshots::render_cell(&spec, &route, &variant.overrides, &theme, 0, move || {
                    crate::sandbox::mint(project_id)
                })
                .await
            })
        })
        .collect();

    let mut images = Vec::with_capacity(cells.len());
    let mut warnings = Vec::new();
    for (cell, handle) in cells.iter().zip(handles) {
        let shot = match handle.await.unwrap_or_else(|e| {
            Err(crate::screenshots::RenderError::Failed(format!("render task failed: {e}")))
        }) {
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
            Err(e @ crate::screenshots::RenderError::BadOverrides(_)) => {
                return Ok(crate::views::bad_request(e.to_string()));
            }
            Err(other) => {
                eprintln!("design compare (cells): {other}");
                return Ok((StatusCode::BAD_GATEWAY, Json(json!({ "detail": other.to_string() }))).into_response());
            }
        };
        warnings.extend(shot.warnings.iter().cloned());
        images.push(json!({
            "variant": cell.variant,
            "route": cell.route,
            "theme": cell.theme,
            "label": cell.label,
            "size": crate::agent_views::png_size(&shot.png),
            "png_base64": base64::engine::general_purpose::STANDARD.encode(&shot.png),
        }));
    }

    // The contrast table: measured from computed styles, so ONE small grid
    // render yields every cell's numbers without rendering the grid for show.
    let checks_spec = GridSpec { scale: 0.25, ..spec.clone() };
    let checks = match crate::screenshots::render_compare(&checks_spec, 900, || crate::sandbox::mint(project_id)).await {
        Ok(shot) => shot.data["checks"].clone(),
        Err(_) => json!([]),
    };

    let mut body = json!({
        "mime": "image/png",
        "cells": images,
        "grid": {
            "columns": spec.variants.iter().map(|v| v.label.clone()).collect::<Vec<_>>(),
            "rows": spec
                .routes
                .iter()
                .flat_map(|r| spec.themes.iter().map(move |t| json!({ "route": r.route, "theme": t, "label": r.label })))
                .collect::<Vec<_>>(),
            "cell": { "width": spec.width, "height": spec.height },
        },
        "checks": checks,
        "warnings": warnings,
    });
    if input.include_apply {
        let (apply, base_version) = compare_apply(&files, &spec.variants);
        body["apply"] = apply;
        body["tokens_version"] = json!(base_version);
    }
    Ok(Json(body).into_response())
}
