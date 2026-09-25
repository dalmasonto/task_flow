//! Sandbox tokens — HMAC-signed, short-lived, read-only grants for the
//! sandbox origin.
//!
//! The frame is served from a distinct origin with NO auth cookies (an opaque
//! origin could not send them usefully anyway), so read access is granted by a
//! token in the URL path. The token is `HMAC(secret, "{project}.{expiry}")`
//! truncated and URL-safe. It grants READ of one project's design files and
//! nothing else — never a write, never another project, never user identity.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// How long a token stays valid. Short by design: the chrome mints a fresh one
/// whenever it composes artboard URLs, so a leaked link dies within minutes.
const TOKEN_TTL_SECS: i64 = 600;

/// Signing key. `TASKFLOW_DESIGN_SANDBOX_SECRET` in any real deployment; the
/// fallback keeps dev boots working but is loudly not a production secret.
fn secret() -> Vec<u8> {
    std::env::var("TASKFLOW_DESIGN_SANDBOX_SECRET")
        .unwrap_or_else(|_| "dev-only-design-surface-secret-change-me".to_string())
        .into_bytes()
}

fn sign(project_id: i64, expiry_unix: i64) -> String {
    let mut mac = HmacSha256::new_from_slice(&secret()).expect("hmac accepts any key length");
    mac.update(format!("{project_id}.{expiry_unix}").as_bytes());
    let digest = mac.finalize().into_bytes();
    // 16 bytes = 128 bits — plenty for a 10-minute read grant, half the size.
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Mint a token granting read of `project_id`'s design files until now + TTL.
pub fn mint(project_id: i64) -> String {
    let expiry = chrono::Utc::now().timestamp() + TOKEN_TTL_SECS;
    format!("{project_id}.{expiry:x}.{}", sign(project_id, expiry))
}

/// Parse and verify a token into `(project_id, expiry_unix)`.
///
/// Fail closed on every malformed shape, expired stamp, or signature miss.
/// Constant-time-ish compare via recomputed-digest equality on fixed-length hex.
///
/// The single verification path: [`verify`] and [`remaining_secs`] both read
/// the token through here, so neither can drift from the other's idea of what
/// a valid token is — a second copy of this logic that accepted one shape more
/// than the other would be a hole only one of the two callers could see.
fn parse(token: &str) -> Option<(i64, i64)> {
    let mut parts = token.split('.');
    let project_raw = parts.next()?;
    let expiry_raw = parts.next()?;
    let sig = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let Ok(project_id) = project_raw.parse::<i64>() else {
        return None;
    };
    let Ok(expiry) = i64::from_str_radix(expiry_raw, 16) else {
        return None;
    };
    if chrono::Utc::now().timestamp() >= expiry {
        return None;
    }
    let expected = sign(project_id, expiry);
    if expected.len() != sig.len() {
        return None;
    }
    let diff = expected
        .bytes()
        .zip(sig.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if diff == 0 {
        Some((project_id, expiry))
    } else {
        None
    }
}

/// Verify a token; returns the project id it reads on success.
pub fn verify(token: &str) -> Option<i64> {
    parse(token).map(|(project_id, _)| project_id)
}

/// Seconds of life left in `token`, or `None` if it is not valid.
///
/// This is the ONLY cache lifetime a sandbox response may claim. A response
/// that outlives its token would leave a cache entry covering a grant the
/// server no longer honours, which is exactly what `no-store` on every sandbox
/// response was there to prevent — so a cacheable subresource (see
/// `views::serve_file`) is allowed to be stored for precisely this long and not
/// a second more. The value is always positive: `parse` refuses an expired
/// stamp, so a token that reaches here has time left.
pub fn remaining_secs(token: &str) -> Option<i64> {
    let (_, expiry) = parse(token)?;
    Some((expiry - chrono::Utc::now().timestamp()).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_expiry() {
        let tok = mint(42);
        assert_eq!(verify(&tok), Some(42));
        assert_eq!(verify("42.deadbeef.00000000000000000000000000000000"), None);
        assert_eq!(verify("garbage"), None);
        assert_eq!(verify("43.not-a-sig.sig"), None);
        // Cross-project forgery: a valid signature for one project must not
        // verify as another.
        let forged = tok.replacen("42.", "43.", 1);
        assert_ne!(verify(&forged), Some(43));
    }

    /// The cache lifetime of a versioned subresource is this value, so it has
    /// to be positive and can never exceed the token's own TTL — a response
    /// stored for longer than the grant would outlive the access it was
    /// fetched under.
    #[test]
    fn remaining_secs_is_positive_and_bounded_by_the_ttl() {
        let left = remaining_secs(&mint(42)).expect("a fresh token has life left");
        assert!(left > 0, "a stored response needs a positive lifetime: {left}");
        assert!(left <= TOKEN_TTL_SECS, "lifetime must not exceed the ttl: {left}");
    }

    /// `remaining_secs` reads the token through the same verification `verify`
    /// does, so it can never report a lifetime for something that would not
    /// serve at all.
    #[test]
    fn remaining_secs_refuses_everything_verify_refuses() {
        let tok = mint(42);
        for bad in [
            "garbage",
            "43.not-a-sig.sig",
            &tok.replacen("42.", "43.", 1),
            "42.deadbeef.00000000000000000000000000000000",
        ] {
            assert_eq!(verify(bad), None, "precondition: {bad} is not a valid token");
            assert_eq!(remaining_secs(bad), None, "{bad}");
        }
    }
}
