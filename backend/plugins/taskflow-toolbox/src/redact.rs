//! #617: what a Toolbox entry is allowed to contain.
//!
//! Two layers, and they are different on purpose (owner's decision,
//! 2026-10-06):
//!
//!  - **Secrets are REJECTED.** A private key, a token, a password literal —
//!    a save carrying one is refused outright. Storing a credential at all is
//!    the mistake; redacting it would still leave a script that quietly reads
//!    a value that is now wrong.
//!  - **Identifiers are REDACTED.** IPs, emails and phone numbers are replaced
//!    with placeholders, and the save says what it replaced, because a silent
//!    edit would break the script on its next run. The placeholder teaches the
//!    right shape: the value belongs in `requires_env`, read at runtime.
//!
//! Both run on every save, for every field. The tests below are the spec: each
//! allowlisted placeholder survives, each real value is replaced, and the
//! things that look like values but are not (version strings, timestamps,
//! documentation ranges) are left alone.

use serde::Serialize;

/// One replacement, reported back to the caller so it can fix the source.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Redaction {
    /// `ipv4`, `ipv6`, `email` or `phone`.
    pub kind: &'static str,
    /// 1-based line in the field the value came from.
    pub line: usize,
    pub replaced_with: &'static str,
}

/// Why a save was refused. `Secrets` names the rule that matched so the agent
/// can find it; the value itself is never echoed back.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SecretFinding {
    pub rule: &'static str,
    pub line: usize,
}

const IPV4_PLACEHOLDER: &str = "xxx.xxx.xx.xx";
const IPV6_PLACEHOLDER: &str = "xxxx:xxxx::xxxx";
const EMAIL_PLACEHOLDER: &str = "user@example.com";
const PHONE_PLACEHOLDER: &str = "+000 000 000 000";

/// Scan one field for secrets. Empty result = safe to store.
pub fn scan_secrets(text: &str) -> Vec<SecretFinding> {
    let mut findings = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        let trimmed = line.trim();
        // A private key block, however it is spelled.
        if trimmed.contains("-----BEGIN") && trimmed.contains("PRIVATE KEY") {
            findings.push(SecretFinding { rule: "private_key", line: number });
            continue;
        }
        // Common token prefixes. Word-boundary so `sk-` inside a word is not a
        // hit, and a minimum length so `sk-` in prose is not either.
        for (rule, prefix) in [
            ("github_token", "ghp_"),
            ("github_token", "github_pat_"),
            ("github_token", "gho_"),
            ("openai_key", "sk-"),
            ("aws_key", "AKIA"),
            ("slack_token", "xoxb-"),
            ("slack_token", "xoxp-"),
        ] {
            if let Some(at) = find_token(line, prefix) {
                let tail = &line[at + prefix.len()..];
                let len = tail.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
                if len >= 16 {
                    findings.push(SecretFinding { rule, line: number });
                    break;
                }
            }
        }
        // `password = "..."` / `secret: ...` / `api_key=...` with a real value.
        if let Some(rule) = assignment_rule(trimmed) {
            findings.push(SecretFinding { rule, line: number });
        }
    }
    findings
}

fn find_token(line: &str, prefix: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = line[from..].find(prefix) {
        let absolute = from + at;
        let before_ok = absolute == 0
            || !line[..absolute]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if before_ok {
            return Some(absolute);
        }
        from = absolute + prefix.len();
    }
    None
}

/// `password=...`, `secret: ...`, `api_key = ...`, `token=...` — with a value
/// that is not obviously a placeholder or a variable reference.
fn assignment_rule(line: &str) -> Option<&'static str> {
    let lower = line.to_lowercase();
    for (rule, key) in [
        ("password_literal", "password"),
        ("secret_literal", "secret"),
        ("api_key_literal", "api_key"),
        ("api_key_literal", "apikey"),
        ("token_literal", "access_token"),
        ("token_literal", "auth_token"),
    ] {
        let Some(at) = lower.find(key) else { continue };
        let rest = line[at + key.len()..].trim_start();
        let Some(rest) = rest.strip_prefix(['=', ':', ' ']) else { continue };
        let value = rest.trim_start_matches(['=', ':', ' ']).trim();
        let value = value.trim_matches(['"', '\'', '`']);
        if value.len() < 8 {
            continue;
        }
        let placeholderish = value.starts_with('$')
            || value.starts_with("${")
            || value.starts_with("os.environ")
            || value.starts_with("process.env")
            || value.contains("xxx")
            || value.contains("example")
            || value.contains("REPLACE")
            || value.contains("<")
            || value.contains("YOUR_");
        if !placeholderish {
            return Some(rule);
        }
    }
    None
}

/// Replace identifiers in one field, returning the cleaned text and what was
/// replaced. Line numbers refer to the INPUT, so the caller can point at the
/// original line.
pub fn redact_identifiers(text: &str) -> (String, Vec<Redaction>) {
    let mut redactions = Vec::new();
    let mut out = String::with_capacity(text.len());
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        let (line_out, mut found) = redact_line(line, number);
        redactions.append(&mut found);
        out.push_str(&line_out);
        out.push('\n');
    }
    // `lines()` drops a trailing newline's own line; keep the text's shape by
    // trimming the newline we added for the last line only when the input did
    // not end with one.
    if !text.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }
    (out, redactions)
}

/// Replace every identifier on one line, in SOURCE order — the report is read
/// top-to-bottom against the original text, so it has to come out that way.
///
/// All kinds are scanned against the ORIGINAL line and the matches resolved by
/// position (an earlier match wins where two overlap), rather than running one
/// kind and rescanning: a pipeline would report a later pass's offsets against
/// text the caller never saw.
fn redact_line(line: &str, number: usize) -> (String, Vec<Redaction>) {
    struct Hit {
        at: usize,
        len: usize,
        kind: &'static str,
        placeholder: &'static str,
    }
    const KINDS: [(&str, &str, fn(&str, usize) -> Option<usize>); 4] = [
        ("ipv4", IPV4_PLACEHOLDER, is_ipv4_at),
        ("ipv6", IPV6_PLACEHOLDER, is_ipv6_at),
        ("email", EMAIL_PLACEHOLDER, is_email_at),
        ("phone", PHONE_PLACEHOLDER, is_phone_at),
    ];

    let mut hits: Vec<Hit> = Vec::new();
    for (kind, placeholder, matcher) in KINDS {
        let mut i = 0;
        while i < line.len() {
            match matcher(line, i) {
                Some(len) if len > 0 => {
                    let starts_clean = i == 0
                        || {
                            let prev = line[..i].chars().next_back().unwrap_or(' ');
                            !prev.is_ascii_alphanumeric() && prev != '.' && prev != '_' && prev != ':'
                        };
                    if starts_clean {
                        hits.push(Hit { at: i, len, kind, placeholder });
                    }
                    i += len;
                }
                _ => {
                    let ch = line[i..].chars().next().expect("char boundary");
                    i += ch.len_utf8();
                }
            }
        }
    }
    hits.sort_by_key(|hit| (hit.at, hit.len));

    let mut out = String::with_capacity(line.len());
    let mut redactions = Vec::new();
    let mut cursor = 0;
    for hit in hits {
        if hit.at < cursor {
            // Overlaps something already replaced (an email inside a longer
            // run, say); the earlier match owns the span.
            continue;
        }
        out.push_str(&line[cursor..hit.at]);
        out.push_str(hit.placeholder);
        redactions.push(Redaction { kind: hit.kind, line: number, replaced_with: hit.placeholder });
        cursor = hit.at + hit.len;
    }
    out.push_str(&line[cursor..]);
    (out, redactions)
}

/// `a.b.c.d`, each octet 0-255, not preceded by `.`/digit (version strings,
/// `==1.2.3.4`) and not inside a longer dotted run.
fn is_ipv4_at(line: &str, at: usize) -> Option<usize> {
    let rest = &line[at..];
    let mut octets = [0u32; 4];
    let mut cursor = 0usize;
    for (index, octet) in octets.iter_mut().enumerate() {
        let digits: String = rest[cursor..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || digits.len() > 3 {
            return None;
        }
        *octet = digits.parse().ok()?;
        if *octet > 255 {
            return None;
        }
        cursor += digits.len();
        if index < 3 {
            if rest[cursor..].starts_with('.') {
                cursor += 1;
            } else {
                return None;
            }
        }
    }
    // Not followed by another dot (a fifth octet, `1.2.3.4.5`).
    if rest[cursor..].starts_with('.') {
        return None;
    }
    // Not glued to a word (`v1.2.3.4`, `sha1.2.3.4`)...
    if at > 0 {
        let prev = line[..at].chars().next_back()?;
        if prev.is_ascii_alphanumeric() || prev == 'v' || prev == 'V' {
            return None;
        }
        // ...and not the right-hand side of an equality, with or without
        // spaces (`== 1.2.3.4`, `version = 1.2.3.4`): a version, not a host.
        if line[..at].trim_end().ends_with('=') {
            return None;
        }
    }
    let value = &line[at..at + cursor];
    if is_allowlisted_ipv4(value) {
        return None;
    }
    Some(cursor)
}

fn is_allowlisted_ipv4(value: &str) -> bool {
    matches!(value, "127.0.0.1" | "0.0.0.0")
        || value.starts_with("192.0.2.")
        || value.starts_with("198.51.100.")
        || value.starts_with("203.0.113.")
}

/// A conservative IPv6 match: two or more `:`-separated groups of hex with at
/// least one `::` or six groups, so `::1` and `2001:db8::1` are found and a
/// time like `12:30` is not.
fn is_ipv6_at(line: &str, at: usize) -> Option<usize> {
    let rest = &line[at..];
    if let Some(prev) = line[..at].chars().next_back() {
        if prev.is_ascii_alphanumeric() || prev == ':' || prev == '.' {
            return None;
        }
    }
    let candidate: String = rest
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == ':' || *c == '.')
        .collect();
    if !candidate.contains(':') {
        return None;
    }
    let groups = candidate.split(':').filter(|g| !g.is_empty()).count();
    let has_double = candidate.contains("::");
    if !has_double && groups < 6 {
        return None;
    }
    if groups < 2 {
        return None;
    }
    if is_allowlisted_ipv6(&candidate) {
        return None;
    }
    Some(candidate.len())
}

fn is_allowlisted_ipv6(value: &str) -> bool {
    matches!(value, "::1" | "::") || value.starts_with("2001:db8")
}

/// `local@domain.tld` with a plausible domain. `@example.*` and the other
/// reserved names survive, because documentation is allowed to name them.
fn is_email_at(line: &str, at: usize) -> Option<usize> {
    if at > 0 {
        let prev = line[..at].chars().next_back()?;
        if prev.is_ascii_alphanumeric() || prev == '.' || prev == '@' || prev == '_' {
            return None;
        }
    }
    let rest = &line[at..];
    let candidate: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-'))
        .collect();
    if candidate.is_empty() {
        return None;
    }
    let after = &rest[candidate.len()..];
    let Some(after) = after.strip_prefix('@') else { return None };
    let domain: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        .collect();
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return None;
    }
    let total = candidate.len() + 1 + domain.len();
    if is_reserved_domain(&domain) {
        return None;
    }
    Some(total)
}

fn is_reserved_domain(domain: &str) -> bool {
    let lower = domain.to_lowercase();
    lower.ends_with(".example")
        || lower.ends_with(".test")
        || lower.ends_with(".invalid")
        || lower.ends_with(".localhost")
        || lower.ends_with("@example.com")
        || lower == "example.com"
        || lower == "example.org"
        || lower == "example.net"
        || lower.ends_with(".example.com")
        || lower.ends_with(".example.org")
        || lower.ends_with(".example.net")
}

/// A phone number needs a country code or a separator — never a bare digit run,
/// which would eat timestamps, ids and ports.
fn is_phone_at(line: &str, at: usize) -> Option<usize> {
    if at > 0 {
        let prev = line[..at].chars().next_back()?;
        if prev.is_ascii_alphanumeric() || prev == '.' || prev == ':' {
            return None;
        }
    }
    let rest = &line[at..];
    let candidate: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' ' | '(' | ')'))
        .collect();
    let digits = candidate.chars().filter(|c| c.is_ascii_digit()).count();
    if digits < 7 || digits > 15 {
        return None;
    }
    let has_plus = candidate.starts_with('+');
    let has_separator = candidate.contains('-') || candidate.contains(' ') || candidate.contains('(');
    if !has_plus && !has_separator {
        return None;
    }
    // A date/time is not a phone number: `2026-10-12 13:45` has separators and
    // digits but starts with a 4-digit year and a `-`.
    if candidate.starts_with("20") && candidate[4..].starts_with('-') {
        return None;
    }
    let trimmed = candidate.trim_end_matches([' ', '-']);
    // Fictional ranges survive: `555-0100`…`555-0199` is the documented
    // "not a real number" space, and a doc that shows one is not a leak.
    let digits_only: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits_only.len() >= 7 && digits_only[digits_only.len() - 7..].starts_with("55501") {
        return None;
    }
    Some(trimmed.len())
}
