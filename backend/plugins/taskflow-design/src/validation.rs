//! Write validation — the constraint layer every design write passes through.
//!
//! Rejection is the feature: an agent that invents `bg-[#3b82f6]` learns the
//! token scale from the error; a permitted drift is a bug nobody notices until
//! page nine. Both the operator's PUT and every agent tool call run through
//! this same module — there is no second, looser path.

use serde::Serialize;

/// One actionable problem with a proposed write. `line` is 1-based where known;
/// `suggest` carries the replacement the agent should have written.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ValidationError {
    pub line: usize,
    pub rule: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggest: Option<String>,
}

/// A non-fatal observation. Currently only "component file is large enough that
/// it probably wants splitting" — surfaced to the agent but never a rejection.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ValidationWarning {
    pub rule: &'static str,
    pub message: String,
}

/// The structured verdict handed back to whichever caller wrote.
#[derive(Debug, Clone, Serialize)]
pub struct Validation {
    /// `true` only when there are zero errors.
    pub ok: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ValidationError>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ValidationWarning>,
}

impl Validation {
    pub(crate) fn pass() -> Self {
        Self {
            ok: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub(crate) fn fail(mut self, err: ValidationError) -> Self {
        self.ok = false;
        self.errors.push(err);
        self
    }

    pub(crate) fn warn(mut self, warning: ValidationWarning) -> Self {
        self.warnings.push(warning);
        self
    }
}

// ---------------------------------------------------------------------------
// Caps (§6.3 path rules)
// ---------------------------------------------------------------------------

pub const MAX_FILES_PER_PROJECT: usize = 200;
pub const MAX_FILE_BYTES: usize = 128 * 1024;
pub const MAX_PROJECT_BYTES: usize = 4 * 1024 * 1024;

/// Components above this size draw a split-it warning (never a rejection).
const COMPONENT_SOFT_SIZE_BYTES: usize = 6 * 1024;

const PATH_RULE: &str = "path";

/// Validate a candidate path against `^(pages|components|styles|assets)/[a-z0-
/// 9][a-z0-9._-]{0,63}$` plus the explicit bans: traversal, absolute paths,
/// backslashes, nesting, and the config/build filenames agents reach for when
/// they want a build step. There is no build step, ever, so there is nothing
/// for those files to configure.
pub fn validate_path(path: &str) -> Result<(), ValidationError> {
    let bad = |rule: &'static str, message: String| Err(ValidationError {
        line: 0,
        rule,
        message,
        found: Some(path.to_string()),
        suggest: None,
    });

    if path.is_empty() {
        return bad(PATH_RULE, "Path must not be empty.".into());
    }
    if path.contains('\\') {
        return bad(PATH_RULE, "Backslashes are not path separators here; use `/`.".into());
    }
    if path.starts_with('/') {
        return bad(PATH_RULE, "Paths are relative to the design root; drop the leading slash.".into());
    }
    if path.contains("..") {
        return bad(PATH_RULE, "Path traversal (`..`) is not allowed.".into());
    }

    let Some((dir, name)) = path.split_once('/') else {
        return bad(
            PATH_RULE,
            format!(
                "`{path}` must live in one of pages/, components/, styles/, assets/."
            ),
        );
    };
    if dir != "pages" && dir != "components" && dir != "styles" && dir != "assets" {
        return bad(
            PATH_RULE,
            format!("Unknown directory `{dir}`. Use pages/, components/, styles/ or assets/."),
        );
    }
    if name.contains('/') || name.is_empty() {
        return bad(PATH_RULE, "Nesting beyond one level is not allowed.".into());
    }

    let first = name.chars().next().expect("non-empty name");
    let ok_char =
        |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-';
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return bad(
            PATH_RULE,
            format!("Filename `{name}` must start with a lowercase letter or digit."),
        );
    }
    if name.len() > 64 || !name.chars().all(ok_char) {
        return bad(
            PATH_RULE,
            format!(
                "Filename `{name}` may only contain a-z, 0-9, dot, dash, underscore (max 64 chars)."
            ),
        );
    }

    // The build-step ban list. Matched on the basename so e.g.
    // `components/tailwind.config.js` cannot smuggle through either.
    let lower = name.to_ascii_lowercase();
    let banned_name = lower == "package.json"
        || lower.starts_with("vite.config.")
        || lower.starts_with("webpack.config.")
        || lower.starts_with("rollup.config.")
        || lower.starts_with("tsconfig.")
        || lower.ends_with(".config.js")
        || lower.ends_with(".config.mjs")
        || lower.ends_with(".config.cjs")
        || lower.ends_with(".config.ts")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
        || lower.ends_with(".ts")
        || lower.ends_with(".tsx")
        || lower.ends_with(".jsx");
    if banned_name {
        return bad(
            PATH_RULE,
            format!(
                "`{name}` looks like build tooling. Generated designs are plain HTML/CSS/vanilla JS \
                 with no build step — delete this call and write the artifact directly."
            ),
        );
    }

    Ok(())
}

/// The extension each kind expects. Assets are generous (images only); pages,
/// components and styles are exact.
fn check_extension(path: &str, kind: crate::models::DesignFileKind) -> Result<(), ValidationError> {
    use crate::models::DesignFileKind as K;
    let ok = match kind {
        K::Page => path.ends_with(".html"),
        K::Component => path.ends_with(".js"),
        K::Token => path == "styles/tokens.css" || path == "styles/tokens.json",
        K::Asset => [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"]
            .iter()
            .any(|ext| path.ends_with(ext)),
    };
    if ok {
        return Ok(());
    }
    let expected = match kind {
        K::Page => "pages/<name>.html",
        K::Component => "components/<element-name>.js",
        K::Token => "exactly styles/tokens.json (or legacy styles/tokens.css; there is one tokens file per project)",
        K::Asset => "an image extension (.svg, .png, .jpg, .webp, .gif, .ico)",
    };
    Err(ValidationError {
        line: 0,
        rule: "extension",
        message: format!("`{path}` does not fit its kind. Expected {expected}."),
        found: Some(path.to_string()),
        suggest: None,
    })
}

// ---------------------------------------------------------------------------
// Page fragments
// ---------------------------------------------------------------------------

/// Layout tags banned at page level. Pages compose from registered custom
/// elements (`<app-header>`), which is the whole reuse story; a raw `<header>`
/// in a page is drift by definition.
const BANNED_LAYOUT_TAGS: &[&str] = &["header", "nav", "footer", "aside"];

/// Full-document markers. Agents write BODY FRAGMENTS; the server owns the
/// document shell so headers/tokens/picker cannot drift between pages. The
/// list itself moved into `validate_page_fragment`, which matches on element
/// boundaries so `<head` never fires on `<header>`.

/// Scan all start tags in an HTML fragment, invoking `on_tag(name, attrs,
/// offset)`. Quote-aware enough for machine-generated fragments: a `>` inside a
/// quoted attribute value does not end the tag.
fn for_each_tag(content: &str, mut on_tag: impl FnMut(&str, &str, usize)) {
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' || i + 1 >= bytes.len() {
            i += 1;
            continue;
        }
        // Skip closing tags and comments/PIs — validators below care about
        // opening tags.
        let next = bytes[i + 1];
        if next == b'/' || next == b'!' || next == b'?' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut in_quote: Option<u8> = None;
        while j < bytes.len() {
            let b = bytes[j];
            if let Some(q) = in_quote {
                if b == q {
                    in_quote = None;
                }
            } else if b == b'"' || b == b'\'' {
                in_quote = Some(b);
            } else if b == b'>' {
                break;
            }
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }
        let inner = &content[i + 1..j];
        let name_end = inner
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(inner.len());
        let name = inner[..name_end].to_ascii_lowercase();
        let attrs = inner[name_end..].trim().to_string();
        if !name.is_empty() && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            on_tag(&name, &attrs, i);
        }
        i = j + 1;
    }
}

/// 1-based line number of a byte offset.
fn line_of(content: &str, offset: usize) -> usize {
    content[..offset.min(content.len())].matches('\n').count() + 1
}

/// Is this tag name a custom element? Custom elements MUST contain a hyphen
/// and no stock HTML element does, so the hyphen test is exact.
fn is_custom_element(name: &str) -> bool {
    name.contains('-')
}

/// Public form for callers outside the validator (e.g. the sandbox preview
/// route, which must reject anything that is not a plausible element name
/// before it reaches the DB).
pub fn is_valid_component_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && is_custom_element(name)
}

/// Validate a PAGE fragment (kind='page').
///
/// `registered_components` is the set of component names in the project's
/// registry — any custom element outside it is rejected with instructions to
/// register first, which is what keeps pages composed from shared parts.
pub fn validate_page_fragment(
    path: &str,
    content: &str,
    registered_components: &[String],
) -> Validation {
    let v = Validation::pass();

    // Full documents and remote scripts. Tag-shaped markers must match on an
    // element BOUNDARY — `<head` must not swallow `<header>`.
    const MARKERS: [(&str, bool); 5] = [
        ("<!doctype", false),
        ("<html", true),
        ("<head", true),
        ("<body", true),
        ("<script src", false),
    ];
    let lower_all = content.to_ascii_lowercase();
    for (marker, tag_boundary) in MARKERS {
        let mut scan = 0usize;
        while let Some(rel) = lower_all[scan..].find(marker) {
            let abs = scan + rel;
            let end = abs + marker.len();
            let boundary_ok = !tag_boundary || lower_all[end..].starts_with([' ', '>', '/', '\t', '\n', '\r']);
            if boundary_ok {
                return v.fail(ValidationError {
                    line: line_of(content, abs),
                    rule: "full-document",
                    message: format!(
                        "`{marker}` belongs to the document shell, which the server composes. \
                         Write a body fragment only ({path})."
                    ),
                    found: Some(marker.to_string()),
                    suggest: None,
                });
            }
            scan = end;
        }
    }

    // Inline style blocks — styling goes through Tailwind classes + tokens.
    let lower = content.to_ascii_lowercase();
    if let Some(idx) = lower.find("<style") {
        return v.fail(ValidationError {
            line: line_of(content, idx),
            rule: "inline-style-block",
            message: "Inline <style> blocks are not allowed. Style with Tailwind utility classes \
                      drawn from the token scale, or put shared CSS in styles/tokens.css."
                .into(),
            found: Some("<style".into()),
            suggest: None,
        });
    }

    // Raw layout tags — force composition through the registry.
    for tag in BANNED_LAYOUT_TAGS {
        let mut hits: Vec<usize> = Vec::new();
        for_each_tag(content, |name, _attrs, offset| {
            if name == *tag {
                hits.push(offset);
            }
        });
        if let Some(offset) = hits.first() {
            let camel = format!("{}{}", &tag[..1].to_uppercase(), &tag[1..]);
            return v.fail(ValidationError {
                line: line_of(content, *offset),
                rule: "raw-layout-tag",
                message: format!(
                    "<{tag}> is banned in page fragments. Use the registered custom element \
                     instead (e.g. <app-{tag}>); register one with design_write_component if it \
                     does not exist yet. This is what keeps {camel}s identical across pages."
                ),
                found: Some(format!("<{tag}>")),
                suggest: Some(format!("<app-{tag}></app-{tag}>")),
            });
        }
    }

    // Unknown custom elements.
    let mut unknown: Option<(String, usize)> = None;
    for_each_tag(content, |name, _attrs, offset| {
        if unknown.is_some() {
            return;
        }
        if !is_custom_element(name) {
            return;
        }
        let registered = registered_components.iter().any(|c| c == name);
        if !registered {
            unknown = Some((name.to_string(), offset));
        }
    });
    if let Some((name, offset)) = unknown {
        return v.fail(ValidationError {
            line: line_of(content, offset),
            rule: "unknown-component",
            message: format!(
                "unknown component: {name}; register it with design_write_component first, or \
                 compose from the existing registry (design_list_components)."
            ),
            found: Some(format!("<{name}>")),
            suggest: None,
        });
    }

    // Arbitrary Tailwind colour/spacing values. The bracket syntax itself is
    // fine when it wraps a var() — that is how tokens are consumed.
    if let Some((found, offset)) = find_arbitrary_value(content) {
        let prop = found.split('-').next().unwrap_or("bg").to_string();
        return v.fail(ValidationError {
            line: line_of(content, offset),
            rule: "raw-color",
            message: format!(
                "{found} is not allowed. Raw hex/px values bypass the token scale. Use a token \
                 variable instead, e.g. {prop}-[var(--accent)] — see design_get_tokens for the \
                 full scale."
            ),
            found: Some(found),
            suggest: Some(format!("{prop}-[var(--accent)]")),
        });
    }

    // Raw hex inside style="" attributes.
    if let Some((style, offset)) = find_style_hex(content) {
        return v.fail(ValidationError {
            line: line_of(content, offset),
            rule: "style-hex",
            message: "Raw colour codes in style= attributes bypass the token scale. Use Tailwind \
                      token utilities (e.g. bg-[var(--surface)]) or a var() reference."
                .into(),
            found: Some(style),
            suggest: Some("class=\"bg-[var(--surface)]\"".into()),
        });
    }

    let _ = path;
    v
}

/// Find the arbitrary-value shapes the token scale exists to replace —
/// `[#hex`, `[rgb(`, `[hsl(`, `[Npx` (e.g. `bg-[#3b82f6]`, `p-[13px]`) — and
/// return the whole utility token plus where it starts. `[var(--x)]` is the
/// sanctioned form and never matches.
fn find_arbitrary_value(content: &str) -> Option<(String, usize)> {
    let bytes = content.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            let rest = &content[i..];
            let close = rest.find(']');
            let matched_len = if rest.starts_with("[#")
                || rest.starts_with("[rgb(")
                || rest.starts_with("[rgba(")
                || rest.starts_with("[hsl(")
            {
                close.map(|k| k + 1)
            } else {
                // [13px], [1.5px]: digits/dots then px, nothing else.
                close
                    .map(|k| {
                        let inner = &rest[1..k];
                        let digits = &inner[..inner.len().saturating_sub(2)];
                        if inner.ends_with("px")
                            && !digits.is_empty()
                            && digits
                                .chars()
                                .all(|c| c.is_ascii_digit() || c == '.')
                        {
                            Some(k + 1)
                        } else {
                            None
                        }
                    })
                    .and_then(|x| x)
            };
            if let Some(len) = matched_len {
                // Walk back over the utility prefix so the error can quote the
                // whole class (`bg-[#3b82f6]`, not just `[#3b82f6]`).
                let start = content[..i]
                    .char_indices()
                    .rev()
                    .take_while(|(_, c)| !c.is_whitespace() && *c != '"' && *c != '\'' && *c != '>')
                    .map(|(k, _)| k)
                    .last()
                    .unwrap_or(i);
                return Some((content[start..i + len].to_string(), start));
            }
        }
        i += 1;
    }
    None
}

/// Find a raw `#rrggbb` inside a style="..." attribute.
fn find_style_hex(content: &str) -> Option<(String, usize)> {
    let lower = content.to_ascii_lowercase();
    let mut search = 0;
    while let Some(rel) = lower[search..].find("style=") {
        let style_start = search + rel;
        let after = style_start + "style=".len();
        let (quoted, quote_len) = match lower[after..].chars().next() {
            Some(q @ ('"' | '\'')) => (true, q.len_utf8()),
            _ => (false, 0),
        };
        let value_range = if quoted {
            let close = lower[after + quote_len..]
                .find(|c| c == '"' || c == '\'')
                .map(|k| after + quote_len + k)?;
            after + quote_len..close
        } else {
            after..lower.len()
        };
        let value = &lower[value_range.clone()];
        if let Some(hash_rel) = value.find('#') {
            let hexish = value[hash_rel + 1..]
                .chars()
                .take(6)
                .all(|c| c.is_ascii_hexdigit());
            if hexish {
                let abs = value_range.start + hash_rel;
                return Some((content[abs..(abs + 7).min(content.len())].to_string(), abs));
            }
        }
        search = value_range.end.max(style_start + 1);
    }
    None
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/// JS APIs banned inside components. They are the escape hatches out of the
/// sandbox: exfiltration (`fetch`, `XMLHttpRequest`), dynamic code (`eval`,
/// `new Function`, dynamic `import`) and persistence/cookies.
const BANNED_JS: &[(&str, &str)] = &[
    ("fetch(", "network access from a component"),
    ("XMLHttpRequest", "network access from a component"),
    ("import(", "dynamic imports from a component"),
    ("eval(", "dynamic code evaluation"),
    ("new Function(", "dynamic code evaluation"),
    ("document.cookie", "cookie access"),
    ("localStorage", "persistent storage"),
    ("sessionStorage", "persistent storage"),
    ("attachShadow", "shadow DOM hides markup from the picker and Tailwind's scanner; render into light DOM"),
];

/// Validate a COMPONENT source file. Exactly one `customElements.define`, name
/// matching the filename (minus .js), hyphen present, none of the banned APIs.
pub fn validate_component(path: &str, content: &str) -> Validation {
    let v = Validation::pass();

    // Count defines and capture their names.
    let mut names: Vec<(String, usize)> = Vec::new();
    let mut rest = content;
    while let Some(pos) = rest.find("customElements.define") {
        let abs = content.len() - rest.len() + pos;
        let after = &rest[pos + "customElements.define".len()..];
        let after = after.trim_start().strip_prefix('(').unwrap_or(after.trim_start());
        let after = after.trim_start();
        let name = after
            .strip_prefix('"')
            .or_else(|| after.strip_prefix('\''))
            .and_then(|q| q.split(['"', '\'']).next())
            .unwrap_or("")
            .to_string();
        names.push((name, abs));
        rest = &rest[pos + "customElements.define".len()..];
    }

    if names.len() != 1 {
        return v.fail(ValidationError {
            line: names.get(1).map(|(_, off)| line_of(content, *off)).unwrap_or(0),
            rule: "define-count",
            message: format!(
                "A component file must contain EXACTLY ONE customElements.define (found {}). One \
                 custom element per file.",
                names.len()
            ),
            found: None,
            suggest: None,
        });
    }
    let (name, offset) = names.remove(0);

    let expected = path
        .strip_prefix("components/")
        .and_then(|p| p.strip_suffix(".js"))
        .unwrap_or("");
    if name != expected {
        return v.fail(ValidationError {
            line: line_of(content, offset),
            rule: "define-name",
            message: format!(
                "customElements.define('{name}') must match its filename. Rename the file to \
                 components/{name}.js or define '{expected}'."
            ),
            found: Some(name),
            suggest: Some(expected.to_string()),
        });
    }
    if !is_custom_element(&name) {
        return v.fail(ValidationError {
            line: line_of(content, offset),
            rule: "element-name",
            message: format!(
                "`{name}` is not a valid custom element name: it must contain a hyphen \
                 (custom-elements spec)."
            ),
            found: Some(name),
            suggest: None,
        });
    }

    for (needle, reason) in BANNED_JS {
        if let Some(pos) = content.find(needle) {
            return v.fail(ValidationError {
                line: line_of(content, pos),
                rule: "banned-api",
                message: format!(
                    "{needle} is banned in components: {reason}. Components render static UI from \
                     their attributes."
                ),
                found: Some(needle.to_string()),
                suggest: None,
            });
        }
    }

    if content.len() > COMPONENT_SOFT_SIZE_BYTES {
        return v.warn(ValidationWarning {
            rule: "component-size",
            message: format!(
                "{} is {} KB — over the 6 KB soft cap. Consider splitting it into smaller \
                 components.",
                expected, content.len() / 1024
            ),
        });
    }

    v
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Validate TOKENS css. Must contain a `@theme` block and must not pull remote
/// imports — the token file is served from the sandbox origin and `@import`
/// would give agent-authored CSS a network voice.
pub fn validate_tokens(content: &str) -> Validation {
    let v = Validation::pass();

    let lower = content.to_ascii_lowercase();
    if !lower.contains("@theme") {
        return v.fail(ValidationError {
            line: 0,
            rule: "missing-theme",
            message: "tokens.css must contain an @theme block defining the scale (colors, \
                      spacing, radius, fonts)."
                .into(),
            found: None,
            suggest: Some("@theme { --color-accent: #6366f1; --spacing-*: initial; }".into()),
        });
    }

    {
        let marker = "@import";
        let mut scan = 0usize;
        while let Some(rel) = lower[scan..].find(marker) {
            let abs = scan + rel;
            // Both spellings matter: `@import url(https://…)` and
            // `@import "https://…"`. Anything naming an absolute URL is remote.
            let after = content[abs + marker.len()..]
                .trim_start()
                .trim_start_matches(|c| c == '(' || c == ' ');
            let unwrapped = after
                .strip_prefix("url(")
                .map(|u| u.trim_start())
                .unwrap_or(after);
            let unwrapped = unwrapped.trim_start_matches(['"', '\'']);
            if unwrapped.starts_with("http://") || unwrapped.starts_with("https://") {
                return v.fail(ValidationError {
                    line: line_of(content, abs),
                    rule: "remote-import",
                    message: "@import of a remote URL is not allowed in tokens.css. Fonts and \
                              other assets ship as local files under assets/."
                        .into(),
                    found: Some(content[abs..(abs + 40).min(content.len())].to_string()),
                    suggest: None,
                });
            }
            scan = abs + marker.len();
        }
    }

    v
}

/// Validate TOKENS json (`styles/tokens.json`, the authored source of truth —
/// see `tokens.rs`). Must parse as a [`crate::tokens::TokensDoc`], and no
/// token value may carry a remote URL: like the CSS `@import` ban, the tokens
/// file is served from the sandbox origin and a value such as
/// `url(https://evil.example/x.css)` would give agent-authored tokens a
/// network voice.
pub fn validate_tokens_json(content: &str) -> Validation {
    let v = Validation::pass();

    let doc: crate::tokens::TokensDoc = match serde_json::from_str(content) {
        Ok(doc) => doc,
        Err(err) => {
            return v.fail(ValidationError {
                line: err.line(),
                rule: "invalid-json",
                message: format!(
                    "styles/tokens.json is not valid: {err}. It must match the tokens \
                     document shape: {{\"version\": 1, \"categories\": {{ \"colors\": \
                     {{ \"accent\": {{ \"light\": \"#6366f1\" }} }} }} }}."
                ),
                found: None,
                suggest: Some(
                    r##"{"version":1,"categories":{"colors":{"accent":{"light":"#6366f1"}}}}"##
                        .into(),
                ),
            });
        }
    };

    for (category, tokens) in doc.categories.iter() {
        for (key, value) in tokens.iter() {
            for value in [Some(&value.light), value.dark.as_ref()].into_iter().flatten() {
                if value.contains("http://") || value.contains("https://") {
                    return v.fail(ValidationError {
                        line: 0,
                        rule: "remote-url",
                        message: format!(
                            "Token `{category}.{key}` names a remote URL ({value}). Fonts and \
                             other assets ship as local files under assets/."
                        ),
                        found: Some(value.clone()),
                        suggest: None,
                    });
                }
            }
        }
    }

    v
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Validate a full write (path + content) for its implied kind.
/// `registered_components` feeds the page validator's registry check.
pub fn validate_write(
    path: &str,
    content: &str,
    registered_components: &[String],
) -> Validation {
    use crate::models::DesignFileKind;

    if let Err(err) = validate_path(path) {
        return Validation::pass().fail(err);
    }
    let Some(kind) = DesignFileKind::for_path(path) else {
        return Validation::pass().fail(ValidationError {
            line: 0,
            rule: PATH_RULE,
            message: format!("`{path}` is outside the writable directories."),
            found: Some(path.to_string()),
            suggest: None,
        });
    };
    if content.len() > MAX_FILE_BYTES {
        return Validation::pass().fail(ValidationError {
            line: 0,
            rule: "size-cap",
            message: format!(
                "File is {} KB; the cap is 128 KB per file.",
                content.len() / 1024
            ),
            found: None,
            suggest: None,
        });
    }
    if let Err(err) = check_extension(path, kind) {
        return Validation::pass().fail(err);
    }

    let base = match kind {
        DesignFileKind::Page => validate_page_fragment(path, content, registered_components),
        DesignFileKind::Component => validate_component(path, content),
        DesignFileKind::Token if path == "styles/tokens.json" => validate_tokens_json(content),
        DesignFileKind::Token => validate_tokens(content),
        DesignFileKind::Asset => Validation::pass(),
    };

    // Components get the arbitrary-value ban too: a component template string
    // carrying bg-[#fff] drifts just as hard as a page does.
    if kind == DesignFileKind::Component {
        if let Some((found, offset)) = find_arbitrary_value(content) {
            let prop = found.split('-').next().unwrap_or("bg").to_string();
            return base.fail(ValidationError {
                line: line_of(content, offset),
                rule: "raw-color",
                message: format!(
                    "{found} is not allowed. Raw hex/px values bypass the token scale. Use a \
                     token variable instead, e.g. {prop}-[var(--accent)]."
                ),
                found: Some(found),
                suggest: Some(format!("{prop}-[var(--accent)]")),
            });
        }
    }

    base
}
