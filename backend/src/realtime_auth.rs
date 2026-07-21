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

/// The header the ticket is promoted into, read by the realtime resolver (#43).
const REALTIME_TICKET_HEADER: &str = "x-realtime-ticket";

/// Pull one query param's value out of a raw query string, or `None` when it is
/// absent or empty. Matches the key EXACTLY, so `my_access_token=…` is ignored.
pub(crate) fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

/// Promotes realtime auth query params on `/realtime` requests into headers
/// EventSource cannot set itself:
/// - `?ticket=` (#43) → `X-Realtime-Ticket` (a one-time ticket the resolver
///   validates + consumes).
/// - `?access_token=` (#41) → `Authorization: Bearer` (only when the client did
///   not already send an Authorization header).
pub(crate) struct RealtimeQueryTokenAuth;

#[umbral::async_trait]
impl Middleware for RealtimeQueryTokenAuth {
    fn name(&self) -> &'static str {
        "realtime-query-token-auth"
    }

    async fn before_request(&self, mut req: Request) -> Result<Request, Response> {
        if req.uri().path().starts_with("/realtime") {
            let query = req.uri().query().unwrap_or("").to_string();

            // #43: a one-time ticket. A forged header value just fails to resolve
            // (it is looked up + consumed against the DB), so no need to strip.
            if let Some(ticket) = query_value(&query, "ticket") {
                if let (Ok(name), Ok(value)) =
                    (REALTIME_TICKET_HEADER.parse::<axum::http::HeaderName>(), ticket.parse())
                {
                    req.headers_mut().insert(name, value);
                }
            }

            // #41 back-compat: the bearer token. Never override an Authorization
            // header the client managed to send (e.g. a non-browser WS client).
            if !req.headers().contains_key(AUTHORIZATION) {
                if let Some(token) = query_value(&query, "access_token") {
                    if let Ok(value) = format!("Bearer {token}").parse() {
                        req.headers_mut().insert(AUTHORIZATION, value);
                    }
                }
            }
        }
        Ok(req)
    }
}

#[cfg(test)]
mod tests {
    use super::query_value;

    #[test]
    fn extracts_a_value_alongside_other_params() {
        assert_eq!(
            query_value("groups=a%2Cb&access_token=abc-_123", "access_token").as_deref(),
            Some("abc-_123"),
        );
        assert_eq!(
            query_value("groups=a&ticket=deadbeef00", "ticket").as_deref(),
            Some("deadbeef00"),
        );
    }

    #[test]
    fn none_when_absent_or_empty() {
        assert_eq!(query_value("groups=a", "access_token"), None);
        assert_eq!(query_value("access_token=", "access_token"), None);
        assert_eq!(query_value("", "ticket"), None);
    }

    #[test]
    fn matches_the_key_exactly() {
        // A key that merely contains the target must not match.
        assert_eq!(query_value("my_access_token=x", "access_token"), None);
        assert_eq!(query_value("xticket=y", "ticket"), None);
    }
}
