//! #41: token auth for the realtime SSE.
//!
//! `EventSource` cannot set request headers, so the realtime stream could only
//! authenticate by session cookie — which a backend restart invalidates, 403-ing
//! the entire live feed while REST (which sends the bearer token) keeps working.
//! The existing #33 reconnect can't recover a 403: that is an auth rejection, not
//! a dropped socket.
//!
//! This middleware promotes a `?access_token=<t>` query param on `/realtime`
//! requests into an `Authorization: Bearer <t>` header (only when none is already
//! present), so the SSE authenticates with the SAME token REST uses and survives
//! cookie loss. `umbral_auth::resolve_identity` already accepts the bearer header
//! for the realtime handshake — the only gap was that EventSource can't send one.
//!
//! Scoped to `/realtime` so a token in the URL never reaches other routes. The
//! token is umbral-auth's URL-safe base64 string (`[A-Za-z0-9-_]`), so the raw
//! query value needs no percent-decoding.

use axum::extract::Request;
use axum::http::header::AUTHORIZATION;
use axum::response::Response;
use umbral::middleware::Middleware;

/// Pull the `access_token` value out of a raw query string, or `None` when it is
/// absent or empty. Matches the key EXACTLY, so `my_access_token=…` is ignored.
pub(crate) fn access_token_from_query(query: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == "access_token")
        .map(|(_, value)| value.to_string())
        .filter(|token| !token.is_empty())
}

/// Promotes `?access_token=` on `/realtime` requests to a Bearer header.
pub(crate) struct RealtimeQueryTokenAuth;

#[umbral::async_trait]
impl Middleware for RealtimeQueryTokenAuth {
    fn name(&self) -> &'static str {
        "realtime-query-token-auth"
    }

    async fn before_request(&self, mut req: Request) -> Result<Request, Response> {
        // Only /realtime, and never override an Authorization header the client
        // did manage to send (e.g. a WS handshake from a non-browser client).
        if req.uri().path().starts_with("/realtime")
            && !req.headers().contains_key(AUTHORIZATION)
        {
            if let Some(token) = req.uri().query().and_then(access_token_from_query) {
                if let Ok(value) = format!("Bearer {token}").parse() {
                    req.headers_mut().insert(AUTHORIZATION, value);
                }
            }
        }
        Ok(req)
    }
}

#[cfg(test)]
mod tests {
    use super::access_token_from_query;

    #[test]
    fn extracts_the_token_alongside_other_params() {
        assert_eq!(
            access_token_from_query("groups=a%2Cb&access_token=abc-_123").as_deref(),
            Some("abc-_123"),
        );
    }

    #[test]
    fn none_when_absent_or_empty() {
        assert_eq!(access_token_from_query("groups=a"), None);
        assert_eq!(access_token_from_query("access_token="), None);
        assert_eq!(access_token_from_query(""), None);
    }

    #[test]
    fn matches_the_key_exactly() {
        // A key that merely contains "access_token" must not match.
        assert_eq!(access_token_from_query("my_access_token=x"), None);
    }
}
