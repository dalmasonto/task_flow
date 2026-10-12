//! The spec's own test list for #617's two layers, written as one suite:
//! every allowlisted placeholder survives untouched, real identifiers are
//! replaced with the right placeholder and the right line numbers, and the
//! things that merely LOOK like values (versions, timestamps, ports) are left
//! alone. The secret rules are a separate axis: rejected, never redacted.

use taskflow_toolbox::redact::{redact_identifiers, scan_secrets, Redaction};

fn kinds(redactions: &[Redaction]) -> Vec<&'static str> {
    redactions.iter().map(|r| r.kind).collect()
}

#[test]
fn allowlisted_placeholders_survive_untouched() {
    let text = [
        "host = 127.0.0.1",
        "bind = 0.0.0.0",
        "peer = 192.0.2.10",
        "peer = 198.51.100.7",
        "peer = 203.0.113.250",
        "loopback = ::1",
        "any = ::",
        "doc = 2001:db8::42",
        "mail user@example.com",
        "site https://example.org/x",
        "dev box test.example",
        "machine thing.invalid",
        "local thing.localhost",
        "support 555-0100",
    ]
    .join("\n");
    let (out, redactions) = redact_identifiers(&text);
    assert_eq!(out, text, "nothing allowlisted may change");
    assert!(redactions.is_empty(), "{redactions:?}");
}

#[test]
fn real_identifiers_are_replaced_with_the_placeholder_for_their_kind() {
    let text = [
        "server 203.0.114.9 down",          // real-looking public IPv4
        "internal 10.4.0.7 also",           // private ranges too: network layout
        "lan 192.168.1.44",
        "v6 fe80::1c9b:1ff:fe0a:1",         // link-local IPv6
        "ping ops@mycorp.io now",
        "call +254 712 345 678",
    ]
    .join("\n");
    let (out, redactions) = redact_identifiers(&text);
    assert_eq!(kinds(&redactions), ["ipv4", "ipv4", "ipv4", "ipv6", "email", "phone"], "{redactions:?}");
    assert!(out.contains("server xxx.xxx.xx.xx down"), "{out}");
    assert!(out.contains("internal xxx.xxx.xx.xx also"), "{out}");
    assert!(out.contains("lan xxx.xxx.xx.xx"), "{out}");
    assert!(out.contains("v6 xxxx:xxxx::xxxx"), "{out}");
    assert!(out.contains("ping user@example.com now"), "{out}");
    assert!(out.contains("call +000 000 000 000"), "{out}");
}

#[test]
fn line_numbers_point_at_the_original_line() {
    let text = "line one\nhost 203.0.114.9\nline three\nmail ops@mycorp.io";
    let (_, redactions) = redact_identifiers(text);
    assert_eq!(redactions[0].line, 2);
    assert_eq!(redactions[1].line, 4);
}

#[test]
fn versions_timestamps_and_ports_are_left_alone() {
    let text = [
        "pin v1.2.3.4 of the plugin",   // version string
        "requires == 1.2.3.4",          // an equality, not an address
        "ipa class 1.2.3.4.5",          // five octets is not an IPv4
        "octet out of range 999.1.1.1", // invalid octets
        "listening on port 8080",
        "id 1234567890",
        "at 2026-10-12 13:45:02",
        "ratio 12:30",
        "sha 3f9a:2b",                  // too few groups to be IPv6
    ]
    .join("\n");
    let (out, redactions) = redact_identifiers(&text);
    assert!(redactions.is_empty(), "{redactions:?}");
    assert_eq!(out, text);
}

#[test]
fn secrets_are_found_by_rule() {
    let text = [
        "k = ghp_abcdefghijklmnopqrstuvwxyz01",
        "k2 = sk-abcdefghijklmnopqrstuvwx01",
        "k3 = AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "-----END OPENSSH PRIVATE KEY-----",
        "password = \"hunter2hunter2\"",
        "api_key: abcdef1234567890",
        "token=$TOKEN_OK",              // a reference, not a literal
        "password = YOUR_PASSWORD",      // a placeholder, not a literal
        "secret = short",                // too short to be worth rejecting
    ]
    .join("\n");
    let findings = scan_secrets(&text);
    let rules: Vec<&'static str> = findings.iter().map(|f| f.rule).collect();
    assert_eq!(
        rules,
        ["github_token", "openai_key", "aws_key", "private_key", "password_literal", "api_key_literal"],
        "{findings:?}"
    );
    // A key BLOCK is one secret, reported once (at its opening line) rather
    // than line by line.
    assert_eq!(findings.iter().filter(|f| f.rule == "private_key").count(), 1);
    assert_eq!(findings.iter().find(|f| f.rule == "private_key").unwrap().line, 4);
}

#[test]
fn a_clean_script_passes_the_scan() {
    let text = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "HOST=\"${SERVER_HOST:?set SERVER_HOST}\"",
        "ssh \"$USER_AT_HOST\" \"df -h\"",
        "echo done",
    ]
    .join("\n");
    assert!(scan_secrets(&text).is_empty());
}
