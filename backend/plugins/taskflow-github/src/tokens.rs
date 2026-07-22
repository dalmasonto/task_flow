//! Key-selection: which GitHub token (if any) may perform an action.
//!
//! This is the security heart of the feature. The rule (decisions A/B/C):
//!   - owner key  = system/tracking actions (create issue)
//!   - actor key  = anything attributed to a person, and ONLY when opted in
//!   - absent token => NeedsConnect, NEVER a fallback to another user's key

use std::collections::HashMap;

use async_trait::async_trait;

/// Where a revealed GitHub token comes from. The real impl (Task 8) reads the
/// user's `SocialAccount`; tests use `FakeTokenSource`.
#[async_trait]
pub trait GithubTokenSource: Send + Sync {
    /// The revealed GitHub access token for this user, or `None` if unlinked.
    async fn token_for_user(&self, user_id: i64) -> Option<String>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenOutcome {
    Ready(String),
    NeedsConnect,
}

/// Resolve the OWNER / tracking key for a project.
///
/// `github_linked_by` is `project.github_linked_by` (the user whose linked
/// account is the project's tracking key), or `None` if no one has linked / the
/// linker left the project.
///
pub async fn resolve_owner_token(
    src: &dyn GithubTokenSource,
    github_linked_by: Option<i64>,
) -> TokenOutcome {
    // No linker (never linked, or the linker left the project) => disabled.
    let Some(uid) = github_linked_by else {
        return TokenOutcome::NeedsConnect;
    };
    // Linker exists but has no live token => disabled, not a fallback.
    match src.token_for_user(uid).await {
        Some(token) => TokenOutcome::Ready(token),
        None => TokenOutcome::NeedsConnect,
    }
}

/// Resolve the ACTOR key — the token used to act *as* `user_id`.
///
/// `post_as_me` is that user's opt-in for this project. A comment/PR only ever
/// goes out under someone's name when they opted in AND have a linked token.
///
pub async fn resolve_actor_token(
    src: &dyn GithubTokenSource,
    user_id: i64,
    post_as_me: bool,
) -> TokenOutcome {
    // Opt-in gate: without it we never act under this person's name.
    if !post_as_me {
        return TokenOutcome::NeedsConnect;
    }
    // Opted in but unlinked => prompt to connect, never borrow another key.
    match src.token_for_user(user_id).await {
        Some(token) => TokenOutcome::Ready(token),
        None => TokenOutcome::NeedsConnect,
    }
}

/// Test double: a fixed map of user_id -> token.
pub struct FakeTokenSource {
    tokens: HashMap<i64, String>,
}
impl FakeTokenSource {
    pub fn new() -> Self {
        Self { tokens: HashMap::new() }
    }
    pub fn with(mut self, user_id: i64, token: &str) -> Self {
        self.tokens.insert(user_id, token.to_string());
        self
    }
}
impl Default for FakeTokenSource {
    fn default() -> Self {
        Self::new()
    }
}
#[async_trait]
impl GithubTokenSource for FakeTokenSource {
    async fn token_for_user(&self, user_id: i64) -> Option<String> {
        self.tokens.get(&user_id).cloned()
    }
}
