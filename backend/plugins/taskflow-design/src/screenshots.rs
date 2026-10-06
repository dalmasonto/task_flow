//! Screenshot rendering (§8.1) — agents cannot see, so a visual feedback loop
//! is not optional.
//!
//! ISOLATION MODEL: this process never renders anything itself. It delegates
//! to a pluggable renderer executable (`TASKFLOW_DESIGN_RENDERER`) that
//! receives the sandbox URL, a viewport size, a hard timeout and an output
//! path. The renderer is disposable (one process per shot) and is responsible
//! for egress blocking — the reference implementation in
//! `renderer/design-render.mjs` intercepts every request and denies RFC1918 +
//! link-local targets except the sandbox origin itself, because headless
//! Chromium is exactly the SSRF surface the spec says it is.
//!
//! The backend enforces the parts a misconfigured renderer cannot skip: a hard
//! wall-clock timeout (the child is killed), a size cap on the returned PNG,
//! and a fully-composed sandbox URL whose token grants nothing else.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;

/// Hard ceiling per screenshot. A full-page laptop shot at DPR 2 lands well
/// under this; anything larger means the renderer has gone wrong.
const MAX_PNG_BYTES: usize = 12 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub dpr: u32,
    /// Render as a phone/tablet browser: touch, a mobile user agent and
    /// mobile viewport handling, so `pointer: coarse` / `hover: none` media
    /// queries and the viewport meta behave as on the device.
    pub mobile: bool,
}

/// The named device presets the tools accept. Mirrors the chrome's
/// design-devices.ts table; ids must stay identical across both.
pub fn viewport_for(device_id: &str) -> Option<Viewport> {
    let (width, height, dpr) = match device_id {
        "iphone-se" => (375, 667, 2),
        "iphone-16-pro" => (393, 852, 3),
        "iphone-16-pro-max" => (440, 956, 3),
        "pixel-8" => (412, 915, 3),
        "galaxy-s24" => (360, 780, 3),
        "ipad-mini" => (744, 1133, 2),
        "ipad-pro-11" => (834, 1194, 2),
        "ipad-pro-13" => (1024, 1366, 2),
        "laptop" | "bp-xl" => (1280, 800, 2),
        "laptop-l" => (1440, 900, 2),
        "desktop" => (1920, 1080, 1),
        "bp-sm" => (640, 900, 1),
        "bp-md" => (768, 1000, 1),
        "bp-lg" => (1024, 1100, 1),
        "bp-2xl" => (1536, 960, 1),
        _ => return None,
    };
    // Phones and tablets are the presets up to the iPad Pro 13"; laptops,
    // desktops and the Tailwind breakpoints render as a desktop browser.
    let mobile = matches!(
        device_id,
        "iphone-se" | "iphone-16-pro" | "iphone-16-pro-max" | "pixel-8" | "galaxy-s24"
            | "ipad-mini" | "ipad-pro-11" | "ipad-pro-13"
    );
    Some(Viewport { width, height, dpr, mobile })
}

/// What an agent or the UI can ask a screenshot for, beyond the route.
#[derive(Debug, Clone, Default)]
pub struct ScreenshotRequest {
    /// A preset id (`iphone-16-pro`, `laptop`, …). Ignored for the SIZE when
    /// `width` and `height` are given, but still names the device frame.
    pub viewport: String,
    /// A custom size, in CSS px. Both or neither.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Device pixel ratio for a custom size (1–4, default 1), or an override
    /// of the preset's.
    pub dpr: Option<u32>,
    /// Override mobile emulation. Default: the preset's; for a custom size,
    /// on up to 1024px wide.
    pub mobile: Option<bool>,
    /// Capture the whole scrollable page instead of one screen.
    pub full_page: bool,
    /// `none` (default), `classic` or `device` — the Design Surface export's
    /// three dresses.
    pub frame: Frame,
    /// light (default), dark, both, or a declared theme name (never all here).
    pub theme: Theme,
    /// #522: unsaved token/CSS overrides to render with (validated).
    pub overrides: crate::compare::Overrides,
    /// Longest side of the returned PNG in px; 0 = as captured.
    pub max_px: u32,
}

/// What agents get by default: about the size their model downscales to.
pub const AGENT_MAX_PX: u32 = 1568;

/// Which theme(s) a screenshot renders in: `light` (default), `dark`, `both`
/// (light and dark side by side), #619 any theme the project declares, or
/// `all` (one shot per declared theme — the agent endpoint loops; the
/// renderer never sees `all`). Travels as a plain string.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Theme {
    #[default]
    Light,
    Dark,
    Both,
    All,
    Named(String),
}

impl Theme {
    pub fn parse(raw: &str) -> Theme {
        match raw {
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            "both" => Theme::Both,
            "all" => Theme::All,
            other => Theme::Named(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::Both => "both",
            Theme::All => "all",
            Theme::Named(name) => name,
        }
    }
}

impl Serialize for Theme {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for Theme {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        Ok(Theme::parse(&raw))
    }
}

/// Refuse a theme the project does not declare BEFORE anything renders: an
/// unknown name would otherwise come back as a light picture. `both` needs
/// `dark`; `all` is always fine.
pub fn check_theme(theme: &Theme, declared: &[String]) -> Result<(), RenderError> {
    let needed = match theme {
        Theme::Light | Theme::All => None,
        Theme::Dark | Theme::Both => Some("dark"),
        Theme::Named(name) => Some(name.as_str()),
    };
    match needed {
        Some(name) if !crate::tokens::is_theme_name(name) || !declared.iter().any(|d| d == name) => {
            Err(RenderError::BadTheme(format!(
                "theme `{name}` is not declared in this project (themes: {}; or \"both\", \"all\")",
                declared.join(", ")
            )))
        }
        _ => Ok(()),
    }
}

/// The shots a request takes: one per declared theme, in order, for `all`;
/// otherwise just itself.
pub fn theme_shots(theme: &Theme, declared: &[String]) -> Vec<Theme> {
    match theme {
        Theme::All => declared.iter().map(|name| Theme::parse(name)).collect(),
        other => vec![other.clone()],
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frame {
    #[default]
    None,
    Classic,
    Device,
}

impl Frame {
    fn as_str(self) -> &'static str {
        match self {
            Frame::None => "none",
            Frame::Classic => "classic",
            Frame::Device => "device",
        }
    }
}

/// Custom sizes stay within what the renderer sidecar accepts.
const SIZE_RANGE: std::ops::RangeInclusive<u32> = 200..=4000;

/// Resolve the request's viewport: a custom size when given, else the preset.
pub fn resolve_viewport(req: &ScreenshotRequest) -> Result<Viewport, RenderError> {
    let preset = viewport_for(&req.viewport);
    let mut vp = match (req.width, req.height) {
        (Some(width), Some(height)) => {
            if !SIZE_RANGE.contains(&width) || !SIZE_RANGE.contains(&height) {
                return Err(RenderError::BadSize(format!(
                    "width and height must each be {}–{} px",
                    SIZE_RANGE.start(),
                    SIZE_RANGE.end()
                )));
            }
            Viewport { width, height, dpr: 1, mobile: width <= 1024 }
        }
        (None, None) => preset.ok_or_else(|| RenderError::UnknownViewport(req.viewport.clone()))?,
        _ => return Err(RenderError::BadSize("give both width and height, or neither".into())),
    };
    if let Some(dpr) = req.dpr {
        if !(1..=4).contains(&dpr) {
            return Err(RenderError::BadSize("dpr must be 1–4".into()));
        }
        vp.dpr = dpr;
    }
    if let Some(mobile) = req.mobile {
        vp.mobile = mobile;
    }
    Ok(vp)
}

/// A rendered shot: the PNG and what did not load into it.
#[derive(Debug)]
pub struct Rendered {
    pub png: Vec<u8>,
    /// Fonts, images or stylesheets that failed, and anything the renderer
    /// had to change (a frame it could not draw as asked, a full page it cut).
    pub warnings: Vec<String>,
    /// What the rendered page itself reported (`window.__tfResult`) — the
    /// comparison grid's contrast checks. `Null` for an ordinary page.
    pub data: serde_json::Value,
    pub viewport: Viewport,
}

/// The configured renderer program, if any.
pub fn configured_renderer() -> Option<String> {
    std::env::var("TASKFLOW_DESIGN_RENDERER")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

#[derive(Debug)]
pub enum RenderError {
    /// No renderer configured / no base URL — a configuration state, not a
    /// crash. Surfaces as 503 so the tool can say so plainly.
    Unconfigured(&'static str),
    UnknownViewport(String),
    /// A custom size out of range, or half of one.
    BadSize(String),
    /// Token/CSS overrides (or a comparison spec) that failed validation.
    BadOverrides(String),
    /// A theme the project does not declare (or `all` where one shot is meant).
    BadTheme(String),
    SpawnFailed(String),
    Timeout,
    TooLarge(usize),
    Failed(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unconfigured(what) => write!(
                f,
                "Screenshot service is not configured: set {what}."
            ),
            Self::UnknownViewport(id) => write!(f, "Unknown viewport '{id}'."),
            Self::BadSize(why) => write!(f, "Bad screenshot size: {why}."),
            Self::BadOverrides(why) => write!(f, "Bad overrides: {why}."),
            Self::BadTheme(why) => write!(f, "Bad theme: {why}."),
            Self::SpawnFailed(e) => write!(f, "Could not start the renderer: {e}"),
            Self::Timeout => write!(f, "Renderer timed out."),
            Self::TooLarge(n) => write!(f, "Renderer produced {n} bytes; over cap."),
            Self::Failed(e) => write!(f, "Renderer failed: {e}"),
        }
    }
}

/// Run one shot: `<renderer> --url <url> --width W --height H --dpr D --timeout-ms T --out <file>`
/// then read the PNG back. The child gets its own wall-clock budget; when it
/// elapses the child is killed and the shot fails loudly.
///
/// Split from the env-reading wrappers so tests can drive it with a stub
/// renderer program.
pub async fn render_with(
    program: &str,
    url: &str,
    viewport: &Viewport,
    timeout_ms: u64,
) -> Result<Vec<u8>, RenderError> {
    render_shot(program, url, viewport, &ScreenshotRequest::default(), timeout_ms)
        .await
        .map(|shot| shot.png)
}

/// [`render_with`] with the full request (frame, full page, device) and the
/// renderer's warnings, read from `<out>.json` when it leaves one.
pub async fn render_shot(
    program: &str,
    url: &str,
    viewport: &Viewport,
    req: &ScreenshotRequest,
    timeout_ms: u64,
) -> Result<Rendered, RenderError> {
    let out = std::env::temp_dir().join(format!(
        "design-shot-{}-{}.png",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    let mut child = tokio::process::Command::new(program)
        .args([
            "--url",
            url,
            "--width",
            &viewport.width.to_string(),
            "--height",
            &viewport.height.to_string(),
            "--dpr",
            &viewport.dpr.to_string(),
            "--timeout-ms",
            &timeout_ms.to_string(),
            "--out",
            out.to_string_lossy().as_ref(),
            "--mobile",
            if viewport.mobile { "1" } else { "0" },
            "--full-page",
            if req.full_page { "1" } else { "0" },
            "--frame",
            req.frame.as_str(),
            "--device",
            &req.viewport,
            "--theme",
            req.theme.as_str(),
            "--max-px",
            &req.max_px.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // A renderer that outlives its budget is a zombie burning CPU on a
        // page nobody will read — kill it when the handle drops.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| RenderError::SpawnFailed(e.to_string()))?;

    let deadline = Duration::from_millis(timeout_ms + 2_000);
    let output = tokio::time::timeout(deadline, child.wait_with_output())
        .await
        .map_err(|_| {
            RenderError::Timeout
        })?
        .map_err(|e| RenderError::Failed(e.to_string()))?;

    // A timed-out child may still be reaped by wait_with_output above, but a
    // non-zero exit with stderr tells us (and the agent) why it failed.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = tokio::fs::remove_file(&out).await;
        return Err(RenderError::Failed(
            stderr.lines().last().unwrap_or("non-zero exit").to_string(),
        ));
    }

    let sidecar = out.with_extension("png.json");
    let png = tokio::fs::read(&out)
        .await
        .map_err(|e| RenderError::Failed(format!("no screenshot written ({e})")));
    let report = tokio::fs::read(&sidecar)
        .await
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .unwrap_or_default();
    let warnings = serde_json::from_value::<Vec<String>>(report["warnings"].clone()).unwrap_or_default();
    let data = report["data"].clone();
    let _ = tokio::fs::remove_file(&out).await;
    let _ = tokio::fs::remove_file(&sidecar).await;
    let png = png?;

    if png.len() > MAX_PNG_BYTES {
        return Err(RenderError::TooLarge(png.len()));
    }
    Ok(Rendered { png, warnings, data, viewport: viewport.clone() })
}

/// Build the sandbox URL the renderer should load.
pub fn sandbox_render_url(base_url: &str, token: &str, route: &str, state: Option<&str>) -> String {
    let clean = if route == "/" {
        String::new()
    } else {
        route.trim_end_matches('/').to_string()
    };
    let mut url = format!("{}/s/{token}{clean}", base_url.trim_end_matches('/'));
    if let Some(state) = state.filter(|s| !s.is_empty()) {
        url.push_str(&format!("?state={}", urlencode(state)));
    }
    url
}

/// Minimal percent-encoding for the shapes we mint (':' and '/').
fn urlencode(value: &str) -> String {
    value.replace(':', "%3A").replace('/', "%2F")
}

/// The public API used by handlers: resolve config, mint nothing here (caller
/// passes a fresh token), delegate to [`render_with`].
pub async fn render_screenshot(
    route: &str,
    req: &ScreenshotRequest,
    state: Option<&str>,
    mint_token: impl FnOnce() -> String,
) -> Result<Rendered, RenderError> {
    if req.theme == Theme::All {
        return Err(RenderError::BadTheme("render one theme at a time; `all` is expanded by the caller".into()));
    }
    let Some(base) = std::env::var("TASKFLOW_DESIGN_BASE_URL")
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
    else {
        return Err(RenderError::Unconfigured("TASKFLOW_DESIGN_BASE_URL"));
    };
    let Some(program) = configured_renderer() else {
        return Err(RenderError::Unconfigured("TASKFLOW_DESIGN_RENDERER"));
    };
    let viewport = resolve_viewport(req)?;

    crate::compare::validate(&req.overrides).map_err(RenderError::BadOverrides)?;
    let mut url = sandbox_render_url(&base, &mint_token(), route, state);
    if !req.overrides.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&format!("ov={}", crate::compare::encode(&req.overrides)));
    }
    // §8.1: short timeout — a hung page must cost seconds, not minutes. A
    // frame or a full page is a second pass over the capture, so it gets a
    // few seconds more.
    let budget = if req.theme == Theme::Both {
        40_000
    } else if req.full_page || req.frame != Frame::None {
        25_000
    } else {
        20_000
    };
    render_shot(&program, &url, &viewport, req, budget).await
}

/// Keep the io trait import honest even if the spawn shape changes.
#[allow(dead_code)]
fn _assert_async_write_imported<T: AsyncWriteExt>(_: &T) {}

/// #522: render a comparison grid (`compare::grid_html`) as one full-page
/// image. The grid page is 2× so each half-scale cell keeps the detail of a
/// 1× screen, and desktop (not mobile) so the grid itself lays out at its own
/// width; the cells inside keep the page's own width via their iframes.
pub async fn render_compare(
    spec: &crate::compare::GridSpec,
    max_px: u32,
    mint_token: impl FnOnce() -> String,
) -> Result<Rendered, RenderError> {
    let Some(base) = std::env::var("TASKFLOW_DESIGN_BASE_URL")
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
    else {
        return Err(RenderError::Unconfigured("TASKFLOW_DESIGN_BASE_URL"));
    };
    let Some(program) = configured_renderer() else {
        return Err(RenderError::Unconfigured("TASKFLOW_DESIGN_RENDERER"));
    };
    crate::compare::validate_spec(spec).map_err(RenderError::BadOverrides)?;
    let url = format!(
        "{}/s/{}/{}?spec={}",
        base.trim_end_matches('/'),
        mint_token(),
        crate::compare::GRID_ROUTE,
        crate::compare::encode_spec(spec)
    );
    let viewport = Viewport { width: crate::compare::grid_width(spec), height: 900, dpr: 2, mobile: false };
    let req = ScreenshotRequest { full_page: true, max_px, ..Default::default() };
    render_shot(&program, &url, &viewport, &req, 55_000).await
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    fn declared() -> Vec<String> {
        ["light", "dark", "ocean"].map(String::from).to_vec()
    }

    #[test]
    fn a_theme_parses_from_its_name_and_serialises_back() {
        for raw in ["light", "dark", "both", "all", "ocean"] {
            let theme: Theme = serde_json::from_value(serde_json::json!(raw)).expect("theme");
            assert_eq!(theme.as_str(), raw);
            assert_eq!(serde_json::to_value(&theme).expect("json"), serde_json::json!(raw));
        }
        assert_eq!(Theme::parse("ocean"), Theme::Named("ocean".into()));
        assert_eq!(Theme::parse("dark"), Theme::Dark);
    }

    #[test]
    fn only_declared_themes_pass() {
        assert!(check_theme(&Theme::Named("ocean".into()), &declared()).is_ok());
        assert!(check_theme(&Theme::Both, &declared()).is_ok());
        assert!(check_theme(&Theme::All, &declared()).is_ok());
        let err = check_theme(&Theme::Named("sunset".into()), &declared()).unwrap_err().to_string();
        assert!(err.contains("sunset") && err.contains("light, dark, ocean"), "{err}");
        let no_dark = ["light", "ocean"].map(String::from).to_vec();
        assert!(check_theme(&Theme::Dark, &no_dark).is_err(), "dark only when declared");
        assert!(check_theme(&Theme::Both, &no_dark).is_err(), "both needs dark");
        assert!(check_theme(&Theme::Named("Ocean\"]".into()), &declared()).is_err());
    }

    #[test]
    fn all_is_one_shot_per_declared_theme_in_order() {
        assert_eq!(
            theme_shots(&Theme::All, &declared()),
            vec![Theme::Light, Theme::Dark, Theme::Named("ocean".into())]
        );
        assert_eq!(theme_shots(&Theme::Both, &declared()), vec![Theme::Both]);
    }
}
