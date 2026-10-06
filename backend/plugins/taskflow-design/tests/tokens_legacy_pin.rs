//! #619: the light/dark output every existing project renders with is PINNED
//! byte for byte. The fixture is captured from the pre-#619 code (run
//! `capture_legacy_pin` once, before touching tokens.rs); the pin then holds
//! through every later change.

use taskflow_design::defaults::effective_tokens;
use taskflow_design::tokens::{tokens_json_to_css, TokensDoc};

/// A legacy document: light/dark, a light-only token, a radius scale step and
/// the shadcn `custom.radius` — compact, exactly as the server stores it.
const LEGACY: &str = r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"},"brand":{"light":"#111111"}},"radius":{"md":{"light":"8px"}},"custom":{"radius":{"light":"0.5rem"}}}}"##;

fn legacy_css() -> String {
    let doc: TokensDoc = serde_json::from_str(LEGACY).expect("legacy doc parses");
    tokens_json_to_css(&effective_tokens(&doc))
}

/// Run ONCE on the pre-#619 code: `cargo test -p taskflow-design --test tokens_legacy_pin -- --ignored capture_legacy_pin`.
#[test]
#[ignore]
fn capture_legacy_pin() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    std::fs::create_dir_all(dir).expect("fixtures dir");
    std::fs::write(format!("{dir}/legacy_effective_tokens.css"), legacy_css()).expect("write pin");
}

#[test]
fn legacy_light_dark_css_is_byte_identical() {
    assert_eq!(legacy_css(), include_str!("fixtures/legacy_effective_tokens.css"));
}

#[test]
fn legacy_json_round_trips_byte_identically() {
    let doc: TokensDoc = serde_json::from_str(LEGACY).expect("legacy doc parses");
    assert_eq!(serde_json::to_string(&doc).expect("serialise"), LEGACY);
}
