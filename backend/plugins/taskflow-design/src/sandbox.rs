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

/// Verify a token; returns the project id it reads on success.
///
/// Fail closed on every malformed shape, expired stamp, or signature miss.
/// Constant-time-ish compare via recomputed-digest equality on fixed-length hex.
pub fn verify(token: &str) -> Option<i64> {
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
        Some(project_id)
    } else {
        None
    }
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
}
