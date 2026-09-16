//! Screenshot rendering (§8.1) — agents cannot see, so a visual feedback loop
//! is not optional.
//!
//! ISOLATION MODEL: this process never renders anything itself. It delegates
//! to a pluggable renderer executable (`TASKFLOW_DESIGN_RENDERER`) that
//! receives the sandbox URL, a viewport size, a hard timeout and an output
//! path. The renderer is disposable (one process per shot) and is responsible
//! for egress blocking — the reference implementation in
//! `scripts/design-render.mjs` intercepts every request and denies RFC1918 +
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

#[derive(Debug, Serialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub dpr: u32,
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
    Some(Viewport { width, height, dpr })
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

    let png = tokio::fs::read(&out)
        .await
        .map_err(|e| RenderError::Failed(format!("no screenshot written ({e})")))?;
    let _ = tokio::fs::remove_file(&out).await;

    if png.len() > MAX_PNG_BYTES {
        return Err(RenderError::TooLarge(png.len()));
    }
    Ok(png)
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
    viewport_id: &str,
    state: Option<&str>,
    mint_token: impl FnOnce() -> String,
) -> Result<Vec<u8>, RenderError> {
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
    let Some(viewport) = viewport_for(viewport_id) else {
        return Err(RenderError::UnknownViewport(viewport_id.to_string()));
    };

    let url = sandbox_render_url(&base, &mint_token(), route, state);
    // §8.1: short timeout — a hung page must cost seconds, not minutes.
    render_with(&program, &url, &viewport, 20_000).await
}

/// Keep the io trait import honest even if the spawn shape changes.
#[allow(dead_code)]
fn _assert_async_write_imported<T: AsyncWriteExt>(_: &T) {}
