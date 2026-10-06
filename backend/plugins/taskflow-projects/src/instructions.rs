//! #615/#616: the one wire shape both instruction blocks take, and the one rule
//! for what a write stores.
//!
//! It lives here, not in `taskflow-agents`, because the agents plugin depends on
//! this one. The agent PUT, the project PUT and the agent `whoami` must all
//! agree on it.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

/// What a write stores: `None` (cleared) for a missing, empty or
/// whitespace-only body. Anything else is kept exactly as written; the human's
/// text is not reformatted.
pub fn normalize_markdown(input: Option<String>) -> Option<String> {
    input.filter(|text| !text.trim().is_empty())
}

/// `{"markdown": …, "updated_at": …}`. Both keys are always present and `null`
/// when unset, so a client can tell "no instructions" from "an old backend".
pub fn instructions_block(markdown: Option<&str>, updated_at: Option<DateTime<Utc>>) -> Value {
    json!({ "markdown": markdown, "updated_at": updated_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_blank_markdown_clears() {
        assert_eq!(normalize_markdown(None), None);
        assert_eq!(normalize_markdown(Some(String::new())), None);
        assert_eq!(normalize_markdown(Some("  \n\t ".to_string())), None);
    }

    #[test]
    fn real_markdown_is_kept_verbatim() {
        let md = "  ## Role\n\n- review only\n";
        assert_eq!(normalize_markdown(Some(md.to_string())).as_deref(), Some(md));
    }

    #[test]
    fn an_empty_block_still_has_both_keys() {
        assert_eq!(instructions_block(None, None), json!({ "markdown": null, "updated_at": null }));
    }

    #[test]
    fn a_block_carries_the_text_and_the_time() {
        let at = DateTime::parse_from_rfc3339("2026-10-06T12:00:00Z")
            .expect("valid time")
            .with_timezone(&Utc);
        let block = instructions_block(Some("x"), Some(at));
        assert_eq!(block["markdown"], json!("x"));
        assert_eq!(block["updated_at"], json!(at));
    }
}
