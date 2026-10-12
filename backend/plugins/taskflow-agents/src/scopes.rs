//! #605/#700 — credential capabilities: the allowlists, the canonical
//! read/write forms of the `scopes` / `denied_scopes` columns, and the checks
//! handlers make against them.
//!
//! A capability is something a KEY may do. It lives on the credential (never the
//! agent), it is set only by a human owner/admin at link time, and an
//! agent-authed mint never carries one — so authority flows one way,
//! humans → agents, and never agent → agent.
//!
//! TWO lists, because ordinary agent access is the DEFAULT, not something a
//! human assembles capability by capability (that would break every key minted
//! before #700, and every `taskflow init`):
//!
//!   * [`DEFAULT_CAPABILITIES`] — on for every key, and switchable OFF per key
//!     through `denied_scopes`. `identity.require(cap)` is the gate handlers
//!     call at the top.
//!   * [`GRANTABLE_SCOPES`] — off by default, switched ON per key through
//!     `scopes`. Reserved for authority beyond ordinary agent work.
//!
//! Effective set = defaults − denied ∪ granted. Both columns are canonical JSON
//! written only by `normalize_*`, both fail closed when read back
//! ([`parse_scopes`] / [`parse_denied`] drop anything unrecognized), and both
//! are `privileged` at the model layer so auto-REST can read but never write.
//!
//! Adding a capability means four things, in this order: name it here (in the
//! right list), enforce it with [`require_capability`] in the handler(s) it
//! gates, teach it to the MCP (`whoami` reports the effective set), and surface
//! it in the Connect-agents UI. A capability named but not enforced grants
//! nothing; one enforced but not named can never be toggled.

/// Run the project's agent setup — mint agents, write their role
/// instructions, revoke them. The "give it the key and it takes over from
/// there" scope #605 asks for: everything about AGENTS in the project, and
/// nothing about the people, the board's settings, or the project's own row.
pub const AGENTS_MANAGE: &str = "agents:manage";

// --- the default-on capabilities (#700) ------------------------------------
// Coarse groups, one per kind of work an agent does. Deliberately not one per
// tool: a human reads this list in the link form, and 30 checkboxes is a
// configuration surface nobody maintains.

/// Create, edit, re-status, claim or attach to a task, and open sub-work.
pub const TASKS_WRITE: &str = "tasks:write";
/// Record a review verdict on a task (`report_review`).
pub const REVIEWS_WRITE: &str = "reviews:write";
/// Send messages into the channels the agent is on.
pub const CHAT_SEND: &str = "chat:send";
/// Log activity — the agent's own audit trail.
pub const ACTIVITY_WRITE: &str = "activity:write";
/// The design surface's write half: pages, components, assets, tokens,
/// layout, deletes, route renames, version restores, comment resolution.
/// Reads and renders (screenshot/compare) stay open — they cost the sidecar
/// time, not other people's work.
pub const DESIGN_WRITE: &str = "design:write";
/// Save, vet, deprecate or report a run of the project's shared toolbox
/// entries.
pub const TOOLBOX_WRITE: &str = "toolbox:write";

/// The capabilities every key has unless its credential denies them. Sorted so
/// `whoami` and the UI read them in a stable order.
pub const DEFAULT_CAPABILITIES: &[&str] = &[
    TASKS_WRITE,
    REVIEWS_WRITE,
    CHAT_SEND,
    ACTIVITY_WRITE,
    DESIGN_WRITE,
    TOOLBOX_WRITE,
];

/// The complete set of GRANTABLE scopes — off by default, switched on per key.
/// `normalize_scopes` refuses anything else, so a typo'd or aspirational scope
/// is a 400 at mint time rather than a key that silently cannot do what its
/// name says.
pub const GRANTABLE_SCOPES: &[&str] = &[AGENTS_MANAGE];

/// Every capability name the system knows, either list. `whoami` reports the
/// effective set as a subset of this, and the UI renders from it.
pub const KNOWN_SCOPES: &[&str] = &[
    AGENTS_MANAGE,
    TASKS_WRITE,
    REVIEWS_WRITE,
    CHAT_SEND,
    ACTIVITY_WRITE,
    DESIGN_WRITE,
    TOOLBOX_WRITE,
];


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
        if !GRANTABLE_SCOPES.contains(&scope.as_str()) {
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

/// Normalize a requested DENY list into the canonical stored form. Only
/// default-on capabilities can be denied — naming a grantable scope here is a
/// 400, because "deny `agents:manage`" is what NOT granting it already means,
/// and two ways to express one state drift.
pub fn normalize_denied(requested: &[String]) -> Result<Option<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in requested {
        let scope = raw.trim().to_ascii_lowercase();
        if !DEFAULT_CAPABILITIES.contains(&scope.as_str()) {
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
            .filter(|s| GRANTABLE_SCOPES.contains(&s.as_str()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// The denied capabilities a credential actually carries.
///
/// FAIL CLOSED, and here that means STRICTER, not emptier: a value this module
/// did not write (hand-edited, corrupted, a future format) reads as "everything
/// default-on is denied" rather than "nothing is denied" — the second reading
/// would silently hand back abilities a human deliberately switched off, which
/// is the one outcome the column exists to prevent. A name that is no longer
/// default-on is dropped, matching the grant side.
pub fn parse_denied(stored: Option<&str>) -> Vec<String> {
    let Some(stored) = stored else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(stored) {
        Ok(list) => list
            .into_iter()
            .filter(|s| DEFAULT_CAPABILITIES.contains(&s.as_str()))
            .collect(),
        Err(_) => DEFAULT_CAPABILITIES.iter().map(|cap| (*cap).to_string()).collect(),
    }
}

/// The effective capability set of a credential: the defaults, minus what the
/// human denied, plus what was granted. Sorted, so `whoami` and the UI agree.
pub fn effective_capabilities(granted: &[String], denied: &[String]) -> Vec<String> {
    let mut out: Vec<String> = DEFAULT_CAPABILITIES
        .iter()
        .filter(|cap| !denied.iter().any(|d| d == *cap))
        .map(|cap| (*cap).to_string())
        .collect();
    for scope in granted {
        if !out.contains(scope) {
            out.push(scope.clone());
        }
    }
    out.sort();
    out
}

/// The refusal every gated handler hands back: 403 plus a body the MCP (and the
/// agent reading it) can act on. `agent_manage` is the #605 shape — the same
/// envelope, so one client-side mapper handles both the scope case and the
/// denied-capability case without reading prose.
#[derive(Debug)]
pub enum CapabilityError {
    /// A refusal with a machine code, the capability at issue, and a sentence
    /// that says who can change it.
    Denied { code: &'static str, capability: String },
    /// Anything else a handler answers with, unchanged.
    Status(axum::http::StatusCode),
}

impl From<axum::http::StatusCode> for CapabilityError {
    fn from(status: axum::http::StatusCode) -> Self {
        CapabilityError::Status(status)
    }
}

impl CapabilityError {
    /// The refusal as a `(status, body)` pair. The ONE place the envelope is
    /// spelled out, so the `IntoResponse` impl below and plugins that carry
    /// their own `type ApiError = (StatusCode, Json<Value>)` (the toolbox) say
    /// exactly the same thing.
    pub fn into_status_json(self) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
        match self {
            CapabilityError::Status(status) => (status, axum::Json(serde_json::json!({}))),
            CapabilityError::Denied { code, capability } => (
                axum::http::StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({
                    "error": code,
                    "capability": capability,
                    "message": format!(
                        "This agent key does not have the `{capability}` capability. A project owner/admin can change it from the dashboard's Connect-agents page."
                    ),
                })),
            ),
        }
    }
}

impl axum::response::IntoResponse for CapabilityError {
    fn into_response(self) -> axum::response::Response {
        self.into_status_json().into_response()
    }
}

/// The gate for a capability a key may LACK. Handlers call this at the top with
/// the capability they implement — one line, so which handler is gated by what
/// is readable in the handler itself rather than inferred from a table.
pub fn require_capability(
    granted: &[String],
    denied: &[String],
    capability: &str,
) -> Result<(), CapabilityError> {
    let allowed = if DEFAULT_CAPABILITIES.contains(&capability) {
        !denied.iter().any(|d| d == capability)
    } else {
        granted.iter().any(|g| g == capability)
    };
    if allowed {
        Ok(())
    } else {
        Err(CapabilityError::Denied {
            code: "capability_denied",
            capability: capability.to_string(),
        })
    }
}

/// The two checks a handler ever needs, on the identity it already holds.
/// Written as methods so a gated handler reads `agent.require(TASKS_WRITE)?;` —
/// the capability is visible where it is enforced.
impl crate::agent_auth::AgentIdentity {
    /// The gate: `Ok` when this key may do `capability`, else a refusal the
    /// client can act on.
    pub fn require(&self, capability: &str) -> Result<(), CapabilityError> {
        require_capability(&self.scopes, &self.denied, capability)
    }

    /// The effective set — what `whoami` reports and the dashboard badges.
    pub fn effective_capabilities(&self) -> Vec<String> {
        effective_capabilities(&self.scopes, &self.denied)
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

    // --- #700: the default-on capabilities ---------------------------------

    #[test]
    fn only_default_capabilities_can_be_denied() {
        let stored = normalize_denied(&[DESIGN_WRITE.to_string()]).expect("deniable");
        assert_eq!(stored.as_deref(), Some("[\"design:write\"]"));
        assert_eq!(normalize_denied(&[]), Ok(None));
        // Denying a GRANTABLE scope is refused — "deny agents:manage" is what
        // not granting it already means, and two ways to say one thing drift.
        assert_eq!(normalize_denied(&[AGENTS_MANAGE.to_string()]), Err(AGENTS_MANAGE.to_string()));
        assert_eq!(normalize_denied(&["nope".to_string()]), Err("nope".to_string()));
    }

    #[test]
    fn an_unreadable_deny_column_reads_as_deny_everything() {
        // STRICTER, not emptier: junk must never hand back an ability a human
        // switched off. A NULL column (every key minted before #700) is not
        // junk — it is "nothing was ever denied".
        assert_eq!(parse_denied(None), Vec::<String>::new());
        assert_eq!(
            parse_denied(Some("not json")),
            DEFAULT_CAPABILITIES.iter().map(|c| (*c).to_string()).collect::<Vec<_>>()
        );
        assert_eq!(parse_denied(Some("[\"design:write\"]")), vec![DESIGN_WRITE.to_string()]);
        assert_eq!(parse_denied(Some("[\"retired:cap\"]")), Vec::<String>::new());
    }

    #[test]
    fn the_effective_set_is_defaults_minus_denied_plus_granted() {
        let all = effective_capabilities(&[], &[]);
        assert_eq!(all.len(), DEFAULT_CAPABILITIES.len(), "an ordinary key has every default");

        let denied = vec![DESIGN_WRITE.to_string(), REVIEWS_WRITE.to_string()];
        let scoped = effective_capabilities(&[AGENTS_MANAGE.to_string()], &denied);
        assert!(!scoped.contains(&DESIGN_WRITE.to_string()));
        assert!(!scoped.contains(&REVIEWS_WRITE.to_string()));
        assert!(scoped.contains(&TASKS_WRITE.to_string()), "untouched capabilities stay");
        assert!(scoped.contains(&AGENTS_MANAGE.to_string()), "grants ride along");
        let mut sorted = scoped.clone();
        sorted.sort();
        assert_eq!(scoped, sorted, "stable order, so whoami and the UI agree");
    }

    #[test]
    fn require_capability_answers_for_both_lists() {
        let granted = vec![AGENTS_MANAGE.to_string()];
        let denied = vec![DESIGN_WRITE.to_string()];

        assert!(require_capability(&granted, &denied, TASKS_WRITE).is_ok());
        assert!(require_capability(&granted, &denied, AGENTS_MANAGE).is_ok());
        match require_capability(&granted, &denied, DESIGN_WRITE) {
            Err(CapabilityError::Denied { code, capability }) => {
                assert_eq!(code, "capability_denied");
                assert_eq!(capability, DESIGN_WRITE);
            }
            other => panic!("expected a denial, got {other:?}"),
        }
        // A grantable scope without the grant is a denial too.
        assert!(require_capability(&[], &[], AGENTS_MANAGE).is_err());
    }
}
