//! Server-side fetch of a page's EXTERNAL image, for the design export.
//!
//! An exported screen is drawn by the page itself (`composer.rs`, the
//! `design:capture` runtime): the DOM becomes an SVG image, and an image loads
//! nothing, so every `<img>` and CSS background the page shows has to travel
//! INLINE as a data: URL. The page cannot fetch them — its sandbox's
//! `connect-src` is deliberately tight (`composer::sandbox_csp`) — and the
//! chrome cannot either for a host that serves no CORS headers (a stock-video
//! thumbnail, say). So the page asks the chrome, the chrome asks THIS server,
//! and the server fetches the bytes and hands them back.
//!
//! That makes this the one place the backend fetches a URL a project member
//! typed, which is a server-side request forgery surface, and the bounds here
//! are the whole of its defence:
//!
//! * `https:` only, to a NAMED public host — never an IP literal, `localhost`,
//!   a `.local`/`.internal`/`.lan` name or a bare single-label name.
//! * The name is resolved HERE, every address it resolves to must be public
//!   (no loopback, private, link-local, CGNAT, multicast or v4-mapped/NAT64
//!   forms of those), and the connection is PINNED to those addresses, so a
//!   name that resolves differently a moment later (DNS rebinding) cannot
//!   reach anything the check did not see.
//! * Redirects are followed by hand, a few at most, and every hop passes the
//!   same checks — a public host that 302s to `http://169.254.169.254/` is
//!   refused at the hop.
//! * Only an `image/*` response is returned, at most [`MAX_BYTES`] of it, and
//!   the whole exchange is bounded by a timeout.
//! * No credentials of any kind are sent: no cookies, no auth header.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

/// Cap on a fetched image. A hero photo from a stock host at export size is
/// well under a megabyte; ten is generous and still bounds memory per call.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 3;
const USER_AGENT: &str = "TaskFlow design export (+https://taskflow.supercodehive.com)";

/// Why a fetch was refused or failed. The handler maps each to a status; the
/// export treats every one the same way (the image becomes a placeholder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Not a URL, or not `https:`.
    NotHttps,
    /// No host at all.
    NoHost,
    /// A host name that means "here" or a private network by convention.
    LocalName,
    /// An IPv4/IPv6 literal for a host: only names are fetched.
    IpLiteral,
    /// The name resolves to (at least one) non-public address.
    PrivateAddress,
    /// The name did not resolve.
    Unresolvable,
    /// More than [`MAX_REDIRECTS`] hops.
    TooManyRedirects,
    /// A redirect without a usable `Location`.
    BadRedirect,
    /// The upstream answered, but not with success.
    Upstream(u16),
    /// The upstream answered with something other than an image.
    NotAnImage,
    /// The body is over [`MAX_BYTES`].
    TooLarge,
    /// Connection, TLS or timeout trouble.
    Network,
}

/// What a successful fetch hands back.
#[derive(Debug)]
pub struct Fetched {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// The static part of the policy: is this a URL the server may even try?
/// Pure, so it is the part with unit tests. Resolution and the address
/// checks are `resolve_public`, below.
pub fn check_url(raw: &str) -> Result<url::Url, Refusal> {
    let parsed = url::Url::parse(raw).map_err(|_| Refusal::NotHttps)?;
    if parsed.scheme() != "https" {
        return Err(Refusal::NotHttps);
    }
    match parsed.host() {
        None => Err(Refusal::NoHost),
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => Err(Refusal::IpLiteral),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if name.is_empty() {
                return Err(Refusal::NoHost);
            }
            // A bracketless v4 literal parses as a Domain on some inputs
            // (`url` normalises the common ones to Ipv4, but be certain).
            if name.parse::<Ipv4Addr>().is_ok() {
                return Err(Refusal::IpLiteral);
            }
            if name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".internal")
                || name.ends_with(".lan")
                || name.ends_with(".home")
                || name.ends_with(".arpa")
                || !name.contains('.')
            {
                return Err(Refusal::LocalName);
            }
            Ok(parsed)
        }
    }
}

/// Is this an address on the public internet — one the server may connect to
/// on a member's behalf? Everything that names this machine, a private or
/// link-local network, a carrier-grade NAT range, multicast or a reserved
/// block is refused, and the IPv6 forms that EMBED a v4 address (v4-mapped
/// `::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) are judged by that address.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        // 100.64.0.0/10: carrier-grade NAT (RFC 6598).
        || (a == 100 && (64..=127).contains(&b))
        // 192.0.0.0/24: IETF protocol assignments (RFC 6890).
        || (a == 192 && b == 0 && ip.octets()[2] == 0)
        // 198.18.0.0/15: benchmarking (RFC 2544).
        || (a == 198 && (18..=19).contains(&b))
        // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, together.
        || a >= 224)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let seg = ip.segments();
    // NAT64 well-known prefix 64:ff9b::/96 carries a v4 address in the tail.
    if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let v4 = Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            seg[6] as u8,
            (seg[7] >> 8) as u8,
            seg[7] as u8,
        );
        return is_public_v4(v4);
    }
    // Deprecated v4-compatible `::a.b.c.d`: anything in ::/96 other than the
    // unspecified and loopback addresses, which the checks below catch.
    if seg[..6] == [0, 0, 0, 0, 0, 0] {
        return false;
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // fc00::/7 unique local.
        || (seg[0] & 0xfe00) == 0xfc00
        // fe80::/10 link local.
        || (seg[0] & 0xffc0) == 0xfe80
        // 2001:db8::/32 documentation.
        || (seg[0] == 0x2001 && seg[1] == 0x0db8)
        // 2002::/16 6to4 and 2001::/32 Teredo both embed a v4 address a
        // relay would connect to; refuse rather than decode.
        || seg[0] == 0x2002
        || (seg[0] == 0x2001 && seg[1] == 0))
}

/// Resolve `host` and insist that EVERY address is public. All of them, not
/// just the one the client would pick: a name answering with one public and
/// one private address is exactly the trick a rebinding attack plays.
async fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, Refusal> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Refusal::Unresolvable)?
        .collect();
    if addrs.is_empty() {
        return Err(Refusal::Unresolvable);
    }
    if addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(Refusal::PrivateAddress);
    }
    Ok(addrs)
}

/// Fetch an image at `raw` under the policy above.
pub async fn fetch_image(raw: &str) -> Result<Fetched, Refusal> {
    let mut url = check_url(raw)?;
    for _hop in 0..=MAX_REDIRECTS {
        let host = url.host_str().ok_or(Refusal::NoHost)?.to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs = resolve_public(&host, port).await?;

        // A client per hop, because the address pin is per host and this is a
        // rare call (an export's worth of images, once).
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .resolve_to_addrs(&host, &addrs)
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| Refusal::Network)?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "image/*")
            .send()
            .await
            .map_err(|_| Refusal::Network)?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(Refusal::BadRedirect)?;
            let next = url.join(location).map_err(|_| Refusal::BadRedirect)?;
            url = check_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(Refusal::Upstream(status.as_u16()));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !content_type.starts_with("image/") {
            return Err(Refusal::NotAnImage);
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BYTES as u64)
        {
            return Err(Refusal::TooLarge);
        }

        // Read in chunks against the cap: a `Content-Length` is a claim, and
        // a chunked body makes none at all.
        let mut response = response;
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Refusal::Network)? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(Refusal::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(Fetched { content_type, bytes });
    }
    Err(Refusal::TooManyRedirects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_url_accepts_a_public_https_name() {
        let url = check_url("https://images.unsplash.com/photo-1?auto=format&w=800").unwrap();
        assert_eq!(url.host_str(), Some("images.unsplash.com"));
        assert!(check_url("https://assets.mixkit.co/videos/4942/4942-thumb-720-0.jpg").is_ok());
    }

    #[test]
    fn check_url_refuses_every_non_https_scheme() {
        assert_eq!(check_url("http://images.unsplash.com/a.jpg"), Err(Refusal::NotHttps));
        assert_eq!(check_url("ftp://images.unsplash.com/a.jpg"), Err(Refusal::NotHttps));
        assert_eq!(check_url("file:///etc/passwd"), Err(Refusal::NotHttps));
        assert_eq!(check_url("data:image/png;base64,AAAA"), Err(Refusal::NotHttps));
        assert_eq!(check_url("not a url"), Err(Refusal::NotHttps));
        assert_eq!(check_url("//images.unsplash.com/a.jpg"), Err(Refusal::NotHttps));
    }

    #[test]
    fn check_url_refuses_ip_literals_and_local_names() {
        assert_eq!(check_url("https://127.0.0.1/a.jpg"), Err(Refusal::IpLiteral));
        assert_eq!(check_url("https://169.254.169.254/latest/meta-data"), Err(Refusal::IpLiteral));
        assert_eq!(check_url("https://[::1]/a.jpg"), Err(Refusal::IpLiteral));
        assert_eq!(check_url("https://[fd00::1]/a.jpg"), Err(Refusal::IpLiteral));
        assert_eq!(check_url("https://localhost/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://LOCALHOST:8000/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://api.localhost/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://printer.local/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://db.internal/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://nas.lan/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://minio/a.jpg"), Err(Refusal::LocalName));
        assert_eq!(check_url("https://backend-web-1./a.jpg"), Err(Refusal::LocalName));
    }

    #[test]
    fn public_v4_excludes_every_special_range() {
        let public = |s: &str| is_public_ip(s.parse().unwrap());
        assert!(public("104.18.0.1"));
        assert!(public("8.8.8.8"));
        assert!(!public("0.0.0.0"));
        assert!(!public("10.0.0.5"));
        assert!(!public("100.64.0.1"));
        assert!(!public("100.127.255.254"));
        assert!(public("100.128.0.1"));
        assert!(!public("127.0.0.1"));
        assert!(!public("127.255.255.254"));
        assert!(!public("169.254.169.254"));
        assert!(!public("172.16.0.1"));
        assert!(!public("172.31.255.255"));
        assert!(public("172.32.0.1"));
        assert!(!public("192.0.0.1"));
        assert!(!public("192.0.2.1"));
        assert!(!public("192.168.1.1"));
        assert!(!public("198.18.0.1"));
        assert!(!public("198.19.255.255"));
        assert!(public("198.20.0.1"));
        assert!(!public("224.0.0.1"));
        assert!(!public("240.0.0.1"));
        assert!(!public("255.255.255.255"));
    }

    #[test]
    fn public_v6_excludes_local_forms_and_embedded_v4() {
        let public = |s: &str| is_public_ip(s.parse().unwrap());
        assert!(public("2606:4700::6812:1"));
        assert!(!public("::"));
        assert!(!public("::1"));
        assert!(!public("fc00::1"));
        assert!(!public("fd12:3456::1"));
        assert!(!public("fe80::1"));
        assert!(!public("ff02::1"));
        assert!(!public("2001:db8::1"));
        assert!(!public("2002:c0a8:101::1"));
        assert!(!public("2001::1"));
        // v4-mapped and NAT64 carry a v4 address: judged by it.
        assert!(!public("::ffff:127.0.0.1"));
        assert!(!public("::ffff:10.0.0.1"));
        assert!(public("::ffff:8.8.8.8"));
        assert!(!public("64:ff9b::127.0.0.1"));
        assert!(!public("64:ff9b::a9fe:a9fe"));
        assert!(public("64:ff9b::8.8.8.8"));
        assert!(!public("::10.0.0.1"));
    }

    /// Against the real hosts the zoezi project uses. Ignored by default: it
    /// needs the network. `cargo test -p taskflow-design --lib -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn fetches_real_images_and_refuses_the_rest() {
        let unsplash = fetch_image(
            "https://images.unsplash.com/photo-1510894347713-fc3ed6fdf539?auto=format&fit=crop&w=800&h=400&q=60",
        )
        .await
        .expect("unsplash");
        assert!(unsplash.content_type.starts_with("image/"), "{}", unsplash.content_type);
        assert!(unsplash.bytes.len() > 10_000);

        // mixkit serves no CORS headers — the case a browser-side fetch cannot do.
        let mixkit = fetch_image("https://assets.mixkit.co/videos/4942/4942-thumb-720-0.jpg")
            .await
            .expect("mixkit");
        assert_eq!(mixkit.content_type, "image/jpeg");
        assert!(mixkit.bytes.len() > 10_000);

        // An HTML page is not an image.
        assert_eq!(fetch_image("https://example.com/").await.err(), Some(Refusal::NotAnImage));
        // A video is not an image either, and is refused on its type before
        // any of its megabytes are read.
        assert_eq!(
            fetch_image("https://assets.mixkit.co/videos/4942/4942-720.mp4").await.err(),
            Some(Refusal::NotAnImage)
        );
        assert_eq!(fetch_image("https://localhost:8000/x.png").await.err(), Some(Refusal::LocalName));
        assert_eq!(fetch_image("https://127.0.0.1/x.png").await.err(), Some(Refusal::IpLiteral));
    }
}
