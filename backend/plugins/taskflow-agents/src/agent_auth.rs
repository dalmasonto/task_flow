//! Agent authentication: the `RequireAgent` axum extractor.
//!
//! Agents authenticate with an opaque API key (`tfk_<prefix>_<secret>`) rather
//! than a user session. This is the agent-side counterpart to
//! `umbral_auth::RequireAuth`: a handler that takes `RequireAgent` cannot run
//! for an unauthenticated or forged caller, because the extractor 401s before
//! the body executes.
//!
//! Trust model (mirrors how credentials are minted in `views::link_agent`):
//!   * The key is read from `Authorization: Agent <key>` OR `x-taskflow-key`.
//!   * The non-secret prefix (`tfk_<prefix>`, up to the 2nd `_`) indexes the
//!     `TaskflowAgentCredential` row — an O(1) unique lookup, no secret in the
//!     query.
//!   * The credential must be `active` and unexpired.
//!   * `sha256(raw_key)` (lowercase hex) must equal the stored `key_hash`. The
//!     raw key is never stored, so a DB read alone cannot reconstruct it.
//! Any miss, mismatch, revoked, or expired credential → `401 UNAUTHORIZED`.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::Utc;
use sha2::{Digest, Sha256};
use umbral::web::{StatusCode, header};

use crate::models::{
    TaskflowAgent, TaskflowAgentCredential, taskflow_agent, taskflow_agent_credential,
};

/// The stored value of `TaskflowCredentialStatus::Active`. The status column is
/// a string at the DB layer, so we compare against this literal — same
/// convention `send_message` uses for membership status.
const ACTIVE_CREDENTIAL: &str = "active";

/// The resolved identity of an agent-authed caller. Every field is derived
/// server-side from the credential — never accepted from the request — exactly
/// like the sender trio in the human send path.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub agent_id: i64,
    pub project_id: i64,
    pub display_name: String,
}

/// Extractor that yields the authenticated [`AgentIdentity`] or rejects with a
/// 401. Use it as the first argument of an agent-authed handler:
///
/// ```ignore
/// async fn handler(RequireAgent(agent): RequireAgent) -> impl IntoResponse {
///     // `agent.agent_id` etc. — an unauthenticated caller never reaches here.
/// }
/// ```
pub struct RequireAgent(pub AgentIdentity);

/// Pull the raw key out of the request headers. Prefers the scheme-qualified
/// `Authorization: Agent <key>`, falling back to the bare `x-taskflow-key`
/// header. Returns `None` if neither is present or well-formed.
fn read_key(parts: &Parts) -> Option<String> {
    if let Some(value) = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        // `Authorization: Agent <key>` — case-insensitive scheme, single space.
        if let Some(rest) = value.strip_prefix("Agent ").or_else(|| value.strip_prefix("agent ")) {
            let key = rest.trim();
            if !key.is_empty() {
                return Some(key.to_string());
            }
        }
    }
    parts
        .headers
        .get("x-taskflow-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The non-secret lookup prefix (`tfk_<prefix>`) of a raw key — everything up to
/// and including the 2nd `_`. Returns `None` for anything that isn't a
/// well-formed `tfk_<prefix>_<secret>`.
fn key_prefix_of(raw: &str) -> Option<String> {
    let mut parts = raw.splitn(3, '_');
    let scheme = parts.next()?;
    let prefix = parts.next()?;
    let secret = parts.next()?;
    if scheme != "tfk" || prefix.is_empty() || secret.is_empty() {
        return None;
    }
    Some(format!("{scheme}_{prefix}"))
}

/// Lowercase hex of `sha256(raw_key)` — the value compared against the stored
/// `key_hash`.
pub fn hash_key(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    hex_lower(&digest)
}

/// Lowercase hex encoding without pulling in a hex crate.
fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Constant-time-ish equality on the two hex digests. Both are the same fixed
/// length (64 hex chars) for any real key, so this never short-circuits on
/// length for a genuine comparison.
fn hashes_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Resolve a raw key to an [`AgentIdentity`], or `None` on any failure. Split
/// out from the extractor so the resolution logic is unit-testable without a
/// live request.
pub async fn resolve_agent(raw_key: &str) -> Option<AgentIdentity> {
    let prefix = key_prefix_of(raw_key)?;

    // O(1) lookup by the non-secret, UNIQUE prefix, gated on active status.
    let credential = TaskflowAgentCredential::objects()
        .filter(
            taskflow_agent_credential::KEY_PREFIX.eq(prefix.as_str())
                & taskflow_agent_credential::STATUS.eq(ACTIVE_CREDENTIAL),
        )
        .first()
        .await
        .ok()??;

    // Expiry: a null `expires_at` never expires; otherwise it must be in the
    // future. Checked in Rust so we don't depend on DB datetime comparison.
    if let Some(expires_at) = credential.expires_at {
        if expires_at <= Utc::now() {
            return None;
        }
    }

    // Verify the secret. A matching prefix is not proof of possession — only the
    // hash is.
    if !hashes_match(&hash_key(raw_key), &credential.key_hash) {
        return None;
    }

    // A credential without an agent cannot authenticate one.
    let agent_id = credential.agent.as_ref().map(|fk| fk.id())?;

    let agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent_id))
        .first()
        .await
        .ok()??;

    Some(AgentIdentity {
        agent_id: agent.id,
        project_id: agent.project.id(),
        display_name: agent.display_name,
    })
}

impl<S> FromRequestParts<S> for RequireAgent
where
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let raw_key = read_key(parts).ok_or(StatusCode::UNAUTHORIZED)?;
        let identity = resolve_agent(&raw_key)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
        Ok(RequireAgent(identity))
    }
}
