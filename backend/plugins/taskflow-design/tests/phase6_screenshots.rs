//! Phase 6d: the screenshot service contract.
//!
//! The backend never renders anything itself; it delegates to a configured
//! renderer executable under a hard timeout. These tests pin that contract
//! with STUB renderers (no Chromium needed): happy path, failure path, and
//! the kill-on-timeout guarantee.

mod support;

use std::time::Duration;

use taskflow_design::screenshots::{
    Frame, RenderError, ScreenshotRequest, Viewport, render_shot, render_with, resolve_viewport,
    viewport_for,
};

/// Write an executable stub renderer that sleeps `sleep_ms` then writes a tiny
/// PNG to --out (or exits non-zero when `fail` is set).
async fn write_stub(name: &str, sleep_ms: u64, fail: bool) -> String {
    let n = umbral_testing::seq();
    let path = std::env::temp_dir().join(format!("{name}-{n}.sh"));
    let body = format!(
        "#!/bin/sh\nwhile [ $# -ge 2 ]; do [ \"$1\" = --out ] && out=\"$2\"; shift 2; done\n\
         sleep {ms}\n\
         {fail_branch}
         printf 'PNGDATA' > \"$out\"\n\
         {warn_branch}",
        ms = sleep_ms as f64 / 1000.0,
        fail_branch = if fail { "exit 1\n" } else { "" },
        warn_branch = if name.contains("warn") {
            "printf '{\"warnings\":[\"webfont failed: Inter\"]}' > \"$out.json\"\n"
        } else {
            ""
        },
    );
    std::fs::write(&path, body).expect("write stub");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    path.to_string_lossy().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn renderer_happy_path_returns_png_bytes() {
    let stub = write_stub("design-render-ok", 10, false).await;
    let vp = Viewport {
        width: 393,
        height: 852,
        dpr: 3,
        mobile: false,
    };
    let png = render_with(&stub, "http://127.0.0.1:1/s/tok/", &vp, 5_000)
        .await
        .expect("stub render succeeds");
    assert_eq!(png, b"PNGDATA");
}

#[tokio::test(flavor = "multi_thread")]
async fn renderer_failure_is_surfaced_not_swallowed() {
    let stub = write_stub("design-render-fail", 10, true).await;
    let vp = Viewport {
        width: 1280,
        height: 800,
        dpr: 2,
        mobile: false,
    };
    let err = render_with(&stub, "http://127.0.0.1:1/s/tok/settings", &vp, 5_000)
        .await
        .err()
        .expect("failing stub must error");
    assert!(matches!(err, RenderError::Failed(_)), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn hung_renderer_is_killed_at_the_deadline() {
    // Sleeps far past the budget; the wrapper must return Timeout well before.
    let stub = write_stub("design-render-hang", 30_000, false).await;
    let vp = Viewport {
        width: 1280,
        height: 800,
        dpr: 1,
        mobile: false,
    };
    let started = std::time::Instant::now();
    let err = render_with(&stub, "http://127.0.0.1:1/s/tok/", &vp, 500)
        .await
        .err()
        .expect("hung renderer must time out");
    assert!(matches!(err, RenderError::Timeout), "{err}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout must be enforced, took {:?}",
        started.elapsed()
    );
}

#[test]
fn viewport_table_matches_the_spec_devices() {
    assert_eq!(viewport_for("iphone-16-pro").map(|v| v.width), Some(393));
    assert_eq!(viewport_for("desktop").map(|v| v.dpr), Some(1));
    assert_eq!(viewport_for("bp-2xl").map(|v| v.height), Some(960));
    assert!(viewport_for("made-up").is_none());
}

#[tokio::test]
async fn sandbox_render_url_shape() {
    let url = taskflow_design::screenshots::sandbox_render_url(
        "http://127.0.0.1:8017",
        "TOK",
        "/settings",
        Some("dialog:confirm-delete"),
    );
    assert_eq!(url, "http://127.0.0.1:8017/s/TOK/settings?state=dialog%3Aconfirm-delete");
    let root = taskflow_design::screenshots::sandbox_render_url("http://x", "TOK", "/", None);
    assert_eq!(root, "http://x/s/TOK");
}

// Silence unused import when only some helpers compile per binary.
const _: Option<support::TestApp> = None;

#[tokio::test(flavor = "multi_thread")]
async fn renderer_warnings_are_read_back_and_cleaned_up() {
    let stub = write_stub("design-render-warn", 10, false).await;
    let vp = viewport_for("iphone-16-pro").expect("preset");
    let req = ScreenshotRequest {
        viewport: "iphone-16-pro".into(),
        frame: Frame::Device,
        ..Default::default()
    };
    let shot = render_shot(&stub, "http://127.0.0.1:1/s/tok/", &vp, &req, 5_000)
        .await
        .expect("stub renders");
    assert_eq!(shot.png, b"PNGDATA");
    assert_eq!(shot.warnings, vec!["webfont failed: Inter".to_string()]);
}

#[test]
fn presets_carry_mobile_emulation() {
    assert!(viewport_for("iphone-16-pro").expect("preset").mobile);
    assert!(viewport_for("ipad-pro-13").expect("preset").mobile);
    assert!(!viewport_for("laptop").expect("preset").mobile);
    assert!(!viewport_for("bp-sm").expect("preset").mobile);
}

#[test]
fn custom_sizes_override_the_preset_and_are_bounded() {
    let custom = |w, h, dpr, mobile| ScreenshotRequest {
        viewport: "laptop".into(),
        width: w,
        height: h,
        dpr,
        mobile,
        ..Default::default()
    };
    let vp = resolve_viewport(&custom(Some(390), Some(844), Some(3), None)).expect("valid");
    assert_eq!((vp.width, vp.height, vp.dpr, vp.mobile), (390, 844, 3, true));
    let wide = resolve_viewport(&custom(Some(1600), Some(900), None, None)).expect("valid");
    assert_eq!((wide.dpr, wide.mobile), (1, false));
    let forced = resolve_viewport(&custom(None, None, Some(1), Some(true))).expect("preset + overrides");
    assert_eq!((forced.width, forced.dpr, forced.mobile), (1280, 1, true));

    for bad in [
        custom(Some(390), None, None, None),
        custom(Some(100), Some(844), None, None),
        custom(Some(390), Some(9000), None, None),
        custom(Some(390), Some(844), Some(5), None),
    ] {
        assert!(matches!(resolve_viewport(&bad), Err(RenderError::BadSize(_))), "{bad:?}");
    }
    assert!(matches!(
        resolve_viewport(&ScreenshotRequest { viewport: "made-up".into(), ..Default::default() }),
        Err(RenderError::UnknownViewport(_))
    ));
}
