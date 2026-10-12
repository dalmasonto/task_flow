//! #605 — credential scopes: the one allowlist, and the canonical read/write
//! forms of the `scopes` column.
//!
//! A scope is a capability a KEY carries beyond ordinary agent access. It lives
//! on the credential (never the agent), it is attached only by a human
//! owner/admin at link time, and an agent-authed mint never produces one — so
//! authority flows one way, humans → agents, and never agent → agent.
//!
//! Adding a scope means four things, in this order: name it here, enforce it
//! with `views::require_agent_scope` in the handler(s) it unlocks, teach it to
//! the MCP (`whoami` reports it, so the agent discovers its own capabilities),
//! and surface it in the Connect-agents UI so the human who grants it can see
//! what they are granting. A scope that is named but not enforced grants
//! nothing; one enforced but not named cannot be granted at all.

/// Run the project's agent setup — mint agents, write their role
/// instructions, revoke them. The "give it the key and it takes over from
/// there" scope #605 asks for: everything about AGENTS in the project, and
/// nothing about the people, the board's settings, or the project's own row.
pub const AGENTS_MANAGE: &str = "agents:manage";

/// The complete set of scopes. `normalize_scopes` refuses anything else, so a
/// typo'd or aspirational scope is a 400 at mint time rather than a key that
/// silently cannot do what its name says.
pub const KNOWN_SCOPES: &[&str] = &[AGENTS_MANAGE];

/// Normalize a requested scope list into the canonical stored form: trimmed,
/// lowercased, deduplicated, sorted, and validated against [`KNOWN_SCOPES`].
///
/// `Ok(None)` means "no scopes" — an ordinary key — which is what an empty
/// request, and every key minted before this column existed, has. `Err(name)`
/// names the first unrecognized entry so the caller can answer a 400 that says
/// WHICH scope it refused; dropping it silently would mint a key weaker than
/// the human asked for, and the response would not say so.
pub fn normalize_scopes(requested: &[String]) -> Result<Option<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in requested {
        let scope = raw.trim().to_ascii_lowercase();
        if !KNOWN_SCOPES.contains(&scope.as_str()) {
            return Err(raw.clone());
        }
        if !out.contains(&scope) {
            out.push(scope);
        }
    }
    if out.is_empty() {
        return Ok(None);
    }
    out.sort();
    Ok(Some(serde_json::to_string(&out).expect("a Vec<String> always serialises")))
}

/// Parse the stored column into the scopes a credential actually carries.
///
/// FAIL CLOSED: an unreadable value (never written by us) reads as no scopes,
/// and a name that is no longer in [`KNOWN_SCOPES`] is filtered out — a
/// retired scope must not keep unlocking routes just because a row still
/// mentions it.
pub fn parse_scopes(stored: Option<&str>) -> Vec<String> {
    let Some(stored) = stored else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(stored) {
        Ok(list) => list
            .into_iter()
            .filter(|s| KNOWN_SCOPES.contains(&s.as_str()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_request_is_no_scopes() {
        assert_eq!(normalize_scopes(&[]), Ok(None));
        assert_eq!(normalize_scopes(&["  ".into()]), Err("  ".to_string()));
    }

    #[test]
    fn a_known_scope_is_stored_canonically() {
        let stored = normalize_scopes(&[AGENTS_MANAGE.to_string()]).expect("known scope");
        assert_eq!(stored.as_deref(), Some("[\"agents:manage\"]"));
        // Case and surrounding space are the caller's problem, not the key's.
        let spaced = normalize_scopes(&[" Agents:Manage ".to_string()]).expect("known scope");
        assert_eq!(spaced, stored);
    }

    #[test]
    fn duplicates_collapse_and_the_order_is_stable() {
        let stored = normalize_scopes(&[AGENTS_MANAGE.into(), AGENTS_MANAGE.into()]).unwrap();
        assert_eq!(stored.as_deref(), Some("[\"agents:manage\"]"));
    }

    #[test]
    fn an_unknown_scope_is_named_in_the_refusal() {
        assert_eq!(normalize_scopes(&["root".to_string()]), Err("root".to_string()));
        // One unknown among knowns still refuses — all-or-nothing.
        assert_eq!(
            normalize_scopes(&[AGENTS_MANAGE.to_string(), "billing".to_string()]),
            Err("billing".to_string())
        );
    }

    #[test]
    fn parsing_fails_closed_on_junk_and_on_retired_names() {
        assert_eq!(parse_scopes(None), Vec::<String>::new());
        assert_eq!(parse_scopes(Some("not json")), Vec::<String>::new());
        assert_eq!(parse_scopes(Some("{\"agents:manage\":true}")), Vec::<String>::new());
        assert_eq!(parse_scopes(Some("[\"retired:scope\"]")), Vec::<String>::new());
        assert_eq!(
            parse_scopes(Some("[\"agents:manage\",\"retired:scope\"]")),
            vec![AGENTS_MANAGE.to_string()],
            "the known ones survive; only the retired name is dropped"
        );
    }
}
