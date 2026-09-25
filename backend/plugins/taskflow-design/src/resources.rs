//! The project's external resource document: named, toggleable groups of links
//! a page needs in order to look right — a web font and its companion
//! preconnects, or a third-party script.
//!
//! Stored as a `DesignFile` row at `styles/resources.json`, which means it
//! inherits versioning, the write validator, the operator and agent write
//! endpoints, and the manifest without any new plumbing. Shape mirrors
//! `tokens.rs`, which set that precedent.
//!
//! The security posture is the point of `validate`. These links are injected
//! into a document that runs scripts, so a URL scheme is a capability: only
//! `https:` is accepted, and `javascript:`/`data:` are refused in every
//! spelling. The sandbox is a separate origin with no cookies and a short-lived
//! read-only token, which bounds the blast radius — it does not license letting
//! an arbitrary scheme through.

use serde::{Deserialize, Serialize};

pub const RESOURCES_PATH: &str = "styles/resources.json";
pub const MAX_SETS: usize = 24;
pub const MAX_LINKS_PER_SET: usize = 16;
pub const MAX_HREF: usize = 2_048;
pub const MAX_SET_NAME: usize = 60;

/// `rel` values we accept on a `<link>`. All three are inert: none executes or
/// mutates the document, which is what makes them safe to allow alongside a
/// stylesheet. Every entry must also be USEFUL ON ITS OWN: `preload` is not,
/// because without an `as` attribute it fetches nothing and `ResourceLink` has
/// no `as` field, so it produced a `<link>` that sat in the DOM doing nothing.
/// Re-adding it means adding `as` to the model, not just the name back here.
pub const ALLOWED_REL: &[&str] = &["preconnect", "dns-prefetch", "stylesheet"];

/// camelCase on the wire throughout, so the frontend mirror is mechanical.
/// Everything is always serialised — no `skip_serializing_if` — because a
/// `None`/`false` round-trips through `#[serde(default)]` identically and the
/// attribute gymnastics buy nothing but a chance to get one wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLink {
    /// Present for `<link>` shapes.
    #[serde(default)]
    pub rel: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub crossorigin: bool,
    /// Present for `<script>` shapes.
    #[serde(default)]
    pub script: Option<String>,
    /// True when this link is a `<script src>` rather than a `<link>`.
    #[serde(default)]
    pub is_script: bool,
    #[serde(default)]
    pub is_async: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSet {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub links: Vec<ResourceLink>,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesDoc {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub sets: Vec<ResourceSet>,
}

fn default_version() -> u32 { 1 }

pub fn parse(raw: &str) -> Result<ResourcesDoc, String> {
    serde_json::from_str::<ResourcesDoc>(raw).map_err(|e| format!("invalid resources document: {e}"))
}

pub fn to_json_string(doc: &ResourcesDoc) -> String {
    serde_json::to_string(doc).expect("ResourcesDoc serialises")
}

/// The URL a link actually points at, whichever shape it is.
fn url_of(link: &ResourceLink) -> Option<&str> {
    if link.is_script { link.script.as_deref() } else { link.href.as_deref() }
}

/// `https:` and nothing else. Checked on the LOWERCASED url with leading C0
/// controls and spaces stripped, so case and leading whitespace cannot smuggle
/// a scheme past it, and deliberately strict — a scheme-relative `//host/x` and
/// a bare path are both refused, because "it will resolve to https anyway" is
/// an assumption about the page's origin, not a property of the link.
fn is_safe_url(url: &str) -> bool {
    // NOT `str::trim`, which strips UNICODE whitespace (NBSP, U+3000, and
    // friends) while a URL parser strips only C0 controls and space. Trimming
    // more than the parser does is not extra strictness — it is a hole: a
    // leading NBSP survives into the emitted value, the browser finds no
    // scheme there, and resolves the whole thing as a RELATIVE url, which is
    // the bare-path case above under a different spelling. So the predicate
    // below is the parser's own strip, and the guarantee it buys is scoped to
    // the SCHEME: for anything it accepts the value begins literally with
    // `https://`, and no later stage can alter those first eight characters —
    // every rewrite between here and a request either happens past index 8 or
    // is a deletion that cannot reach back into them.
    //
    // Two stages do diverge from the URL parser, and nothing here claims
    // otherwise. The HTML tokenizer normalises newlines BEFORE tokenizing, so
    // an interior CR is already gone when the URL parser's own strip runs; and
    // it decodes character references in attribute values, so `&amp;` is
    // reinterpreted. Both are scheme-preserving, and `&` is escaped wherever
    // these values are emitted, so neither becomes a live difference.
    //
    // U+0000 is the one character that CAN change the head: the tokenizer
    // rewrites it to U+FFFD before the URL parser's own strip sees it, so this
    // predicate cannot account for it. `validate` therefore refuses any url
    // containing one (see the containment check below) rather than leaving it
    // to the strip.
    let u = url.trim_matches(|c: char| c <= ' ').to_ascii_lowercase();
    u.starts_with("https://") && !u.starts_with("https://javascript:")
}

pub fn validate(doc: ResourcesDoc) -> Result<ResourcesDoc, String> {
    if doc.sets.len() > MAX_SETS {
        return Err(format!("at most {MAX_SETS} resource sets are allowed"));
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sets = Vec::with_capacity(doc.sets.len());

    for set in doc.sets {
        let name = set.name.trim().to_string();
        if name.is_empty() {
            return Err("a resource set needs a name".into());
        }
        if name.chars().count() > MAX_SET_NAME {
            return Err(format!("a set name is limited to {MAX_SET_NAME} characters"));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("the set name \"{name}\" is already used"));
        }
        let id = set.id.trim().to_string();
        if id.is_empty() {
            return Err("a resource set needs a non-empty id".into());
        }
        // Names are the human label and are checked above; the id is the key
        // every consumer addresses a set by, so a duplicate leaves the document
        // with no stable address for either set.
        if !seen_ids.insert(id.clone()) {
            return Err(format!("the set id \"{id}\" is already used"));
        }
        if set.links.len() > MAX_LINKS_PER_SET {
            return Err(format!("at most {MAX_LINKS_PER_SET} links per set"));
        }

        let mut links = Vec::with_capacity(set.links.len());
        for link in set.links {
            // One shape, one url field. `url_of` reads exactly one of them, so
            // a link carrying both would strand the other somewhere no reader
            // looks — the ambiguous shape is refused rather than resolved, and
            // refused before any scheme check, so the verdict does not depend
            // on which of the two fields happens to be the dangerous one.
            if link.href.is_some() && link.script.is_some() {
                return Err(format!(
                    "a link in \"{name}\" has both an href and a src; a link is one shape or the other"
                ));
            }
            let url = url_of(&link).ok_or_else(|| {
                format!("a link in \"{name}\" has no {}",
                    if link.is_script { "src" } else { "href" })
            })?;
            if url.trim().is_empty() {
                return Err(format!("a link in \"{name}\" has an empty url"));
            }
            // U+0000 is the one character `is_safe_url`'s strip cannot account
            // for, because the value reaches a TOKENIZER before it reaches a
            // URL parser: the tokenizer rewrites NUL to U+FFFD, which is
            // neither a C0 control nor a space, so it is not stripped and the
            // value resolves as a relative url while still reading as https
            // here. Refused wherever it appears rather than un-stripped, since
            // an interior NUL mangles the address just as silently.
            if url.contains('\u{0}') {
                return Err(format!(
                    "a url in \"{name}\" contains a U+0000 character; the html parser rewrites it to U+FFFD, so the address that loads would not be the one written"
                ));
            }
            if url.chars().count() > MAX_HREF {
                return Err(format!("a url in \"{name}\" is too long"));
            }
            if !is_safe_url(url) {
                return Err(format!("\"{url}\" is not an https address"));
            }
            if !link.is_script {
                let rel = link.rel.as_deref().unwrap_or("").trim().to_ascii_lowercase();
                if !ALLOWED_REL.contains(&rel.as_str()) {
                    // The alternatives are enumerated FROM the constant, not
                    // spelled out, so this message cannot drift from the list
                    // it describes — a refusal a user cannot act on is the
                    // thing `preload`'s removal was about.
                    return Err(format!(
                        "\"{rel}\" is not an allowed link relation; use one of: {}",
                        ALLOWED_REL.join(", ")
                    ));
                }
            }
            links.push(link);
        }
        sets.push(ResourceSet { id, name, enabled: set.enabled, links });
    }

    Ok(ResourcesDoc { version: doc.version, sets })
}

/// Every link from enabled sets, in document order, paired with whether it is a
/// script. Disabled sets contribute nothing — that is the whole point of the
/// toggle, and the reason a font can be kept without affecting a page.
pub fn enabled_links(doc: &ResourcesDoc) -> Vec<(bool, &ResourceLink)> {
    doc.sets
        .iter()
        .filter(|s| s.enabled)
        .flat_map(|s| s.links.iter().map(|l| (l.is_script, l)))
        .collect()
}
