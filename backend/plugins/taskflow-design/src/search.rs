//! #664: `design_search` — find what the pages SAY, without reading them.
//!
//! The problem this exists for: renaming a term across a design (the owner's
//! example, "AI coach" → "Pulse") otherwise means reading every page. On a
//! large project that is hundreds of calls and a context full of pages that
//! did not contain the term. Search answers "which pages mention this, and
//! where" in one call, so the agent reads and edits ONLY those.
//!
//! ## What is searched, and where matches live
//!
//! - **Pages** are scanned as FRAGMENTS, not raw text: markup is tokenized so
//!   a hit inside a tag name, a class or a URL is not reported as visible
//!   text. `text` matches decoded text runs; `attributes` matches the
//!   accessibility attributes a rename must not miss (`alt`, `title`,
//!   `aria-label`, `placeholder`, `value`); `code` (OFF unless asked for)
//!   matches the raw source, which is what class names, ids and `data-*` need.
//! - **Components** are whole-file matches: a component IS code, so its
//!   template literals and attribute values are one haystack. A component hit
//!   is reported ONCE with the routes that use it, because editing it once
//!   fixes every route — six matches in `app-header` must not read as six
//!   pages to edit.
//! - **Labels** (page titles, panel labels, group names, flow edge labels)
//!   live in the arrangement, not in any file, so they are reported in their
//!   own list with the route or id they belong to.
//!
//! ## Snippets and lines, precisely
//!
//! Matching runs over DECODED text (an `&amp;` matches a query for `&`), so
//! the snippet reads the way the page does. `line` is computed from the RAW
//! source, because that is what an edit lands on. The hit is marked with
//! `<<`/`>>` rather than offsets: the consumer is a JSON client where byte
//! offsets and UTF-16 offsets disagree, and a marker cannot be misread.
//!
//! ## Pagination
//!
//! By FILE, in a deterministic order (pages by path, then components), with
//! `next_cursor` naming the last file of the page — a file path, so the cursor
//! stays meaningful even if the project changes between calls. `total` and the
//! variant summary always describe the WHOLE match set; only `files` pages.

use regex::Regex;
use serde::Deserialize;
use umbral::web::{IntoResponse, Json, Query, Response, StatusCode};

use crate::models::{DesignFile, DesignFileKind};

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/// A compiled query. Literal queries go through the regex engine too — same
/// code path, and the engine's Unicode case folding and word boundaries are
/// exactly what the two flags mean.
pub struct Matcher {
    pattern: Regex,
}

impl Matcher {
    pub fn new(
        query: &str,
        regex: bool,
        case_sensitive: bool,
        whole_word: bool,
    ) -> Result<Self, String> {
        let body = if regex { query.to_string() } else { regex::escape(query) };
        if body.is_empty() {
            return Err("the query is empty".into());
        }
        let mut pattern = String::new();
        if !case_sensitive {
            pattern.push_str("(?i)");
        }
        if whole_word {
            pattern.push_str(r"\b");
        }
        pattern.push_str(&format!("(?:{body})"));
        if whole_word {
            pattern.push_str(r"\b");
        }
        let pattern = Regex::new(&pattern).map_err(|err| format!("invalid pattern: {err}"))?;
        Ok(Self { pattern })
    }

    /// Byte ranges in `haystack`, left to right, non-overlapping.
    pub fn find(&self, haystack: &str) -> Vec<std::ops::Range<usize>> {
        self.pattern
            .find_iter(haystack)
            .map(|m| m.start()..m.end())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Fragment scanning
// ---------------------------------------------------------------------------

/// One searchable run of a page fragment: the decoded text the reader sees,
/// plus a map from each decoded byte back to its byte in the RAW source (for
/// line numbers). `raw_map[i]` is the raw offset of decoded byte `i`; its last
/// entry is the raw offset just past the decoded run.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub decoded: String,
    pub raw_map: Vec<usize>,
    /// `None` for a text run; the attribute's name for an attribute value.
    pub attribute: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FragmentIndex {
    pub segments: Vec<Segment>,
}

/// The attributes a rename must not miss — the ones that carry words a reader
/// (or a screen reader) sees.
pub const TEXT_ATTRIBUTES: &[&str] = &["alt", "title", "aria-label", "placeholder", "value"];

const ENTITIES: [(&str, &str); 5] = [
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", "\""),
    ("&#39;", "'"),
];

/// Decode the five common entities (plus numeric ones) while remembering where
/// each decoded byte came from. An entity that is not recognized is copied
/// verbatim, so offsets stay exact.
fn decode_with_map(raw: &str, base: usize) -> Segment {
    let mut decoded = String::with_capacity(raw.len());
    let mut raw_map = Vec::with_capacity(raw.len() + 1);
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        let mut handled = false;
        if bytes[i] == b'&' {
            let end = raw[i..].find(';').map(|rel| i + rel + 1).filter(|end| *end - i <= 12);
            if let Some(end) = end {
                let entity = &raw[i..end];
                let replacement = ENTITIES
                    .iter()
                    .find(|(name, _)| *name == entity)
                    .map(|(_, value)| value.to_string())
                    .or_else(|| numeric_entity(entity));
                if let Some(replacement) = replacement {
                    for _ in replacement.bytes() {
                        raw_map.push(base + i);
                    }
                    decoded.push_str(&replacement);
                    i = end;
                    handled = true;
                }
            }
        }
        if !handled {
            let ch = raw[i..].chars().next().expect("a char boundary");
            for _ in 0..ch.len_utf8() {
                raw_map.push(base + i);
            }
            decoded.push(ch);
            i += ch.len_utf8();
        }
    }
    raw_map.push(base + raw.len());
    Segment { decoded, raw_map, attribute: None }
}

fn numeric_entity(entity: &str) -> Option<String> {
    let body = entity.strip_prefix("&#")?.strip_suffix(';')?;
    let code = if let Some(hex) = body.strip_prefix(['x', 'X']) {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        body.parse::<u32>().ok()?
    };
    char::from_u32(code).map(|c| c.to_string())
}

/// Tokenize a page fragment into the searchable runs. Handles the cases that
/// make naive `>text<` scanning wrong: comments, `<script>`/`<style>` contents
/// (code, never text), quoted attribute values containing `>`, and entities.
pub fn scan_fragment(fragment: &str) -> FragmentIndex {
    let mut index = FragmentIndex::default();
    let bytes = fragment.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    while i < fragment.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // A text run ends here.
        if i > text_start {
            index.segments.push(decode_with_map(&fragment[text_start..i], text_start));
        }
        if fragment[i..].starts_with("<!--") {
            i = fragment[i..].find("-->").map(|rel| i + rel + 3).unwrap_or(fragment.len());
            text_start = i;
            continue;
        }
        if fragment[i..].starts_with("</") {
            i = fragment[i..].find('>').map(|rel| i + rel + 1).unwrap_or(fragment.len());
            text_start = i;
            continue;
        }
        // A start tag: read it to its '>', collecting interesting attributes.
        let lower = fragment[i..].to_ascii_lowercase();
        let tag_end = find_tag_end(fragment, i);
        let tag = &fragment[i..tag_end];
        let is_raw_text = lower.starts_with("<script") || lower.starts_with("<style");
        for (name, value, value_start) in attributes_of(tag, i) {
            if TEXT_ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str()) {
                let mut segment = decode_with_map(value, value_start);
                segment.attribute = Some(name.to_ascii_lowercase());
                index.segments.push(segment);
            }
        }
        if is_raw_text {
            // Skip the element's contents: code, not text.
            let closer = if lower.starts_with("<script") { "</script" } else { "</style" };
            let after = tag_end;
            let end = fragment[after..]
                .to_ascii_lowercase()
                .find(closer)
                .map(|rel| after + rel)
                .unwrap_or(fragment.len());
            i = fragment[end..].find('>').map(|rel| end + rel + 1).unwrap_or(fragment.len());
            text_start = i;
        } else {
            i = tag_end;
            text_start = tag_end;
        }
    }
    if text_start < fragment.len() {
        index.segments.push(decode_with_map(&fragment[text_start..], text_start));
    }
    index
}

/// The byte just past the tag's `>`, respecting quoted attribute values (a `>`
/// inside `alt="a > b"` does not end the tag).
fn find_tag_end(fragment: &str, start: usize) -> usize {
    let bytes = fragment.as_bytes();
    let mut i = start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let byte = bytes[i];
        match quote {
            Some(q) if byte == q => quote = None,
            Some(_) => {}
            None if byte == b'"' || byte == b'\'' => quote = Some(byte),
            None if byte == b'>' => return i + 1,
            None => {}
        }
        i += 1;
    }
    bytes.len()
}

/// `(name, value, value_start)` for each attribute in one start tag. Bare
/// attributes (`disabled`) carry an empty value and are skipped by callers
/// because their name is not in [`TEXT_ATTRIBUTES`].
fn attributes_of(tag: &str, tag_start: usize) -> Vec<(String, &str, usize)> {
    let mut out = Vec::new();
    let bytes = tag.as_bytes();
    let mut i = 1; // past '<'
    // Skip the tag name.
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
        i += 1;
    }
    while i < tag.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= tag.len() || bytes[i] == b'>' {
            break;
        }
        let name_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b'>' {
            i += 1;
        }
        let name = tag[name_start..i].to_string();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                out.push((name, &tag[value_start..i], tag_start + value_start));
                i += 1; // past the closing quote
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                out.push((name, &tag[value_start..i], tag_start + value_start));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Text,
    Attributes,
    Code,
    PageNames,
    Groups,
    FlowLabels,
}

impl Scope {
    fn parse(name: &str) -> Option<Self> {
        match name.trim() {
            "text" => Some(Self::Text),
            "attributes" => Some(Self::Attributes),
            "code" => Some(Self::Code),
            "page_names" => Some(Self::PageNames),
            "groups" => Some(Self::Groups),
            "flow_labels" => Some(Self::FlowLabels),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub project: i64,
    /// The term to find. The tool's own name for it in most clients; `q` is
    /// accepted too (see `query_text`).
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    /// Default TRUE: a rename for "coach" should not sweep up "coaching".
    #[serde(default = "default_true")]
    pub whole_word: bool,
    /// Comma-separated; default `text`.
    #[serde(default)]
    pub scope: Option<String>,
    /// `pages`, `components` or `both` (default).
    #[serde(default)]
    pub r#in: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn default_true() -> bool {
    true
}

impl SearchQuery {
    pub fn query_text(&self) -> Result<&str, String> {
        self.query
            .as_deref()
            .or(self.q.as_deref())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "pass the term to find as `query`".to_string())
    }

    pub fn scopes(&self) -> Result<Vec<Scope>, String> {
        let raw = self.scope.as_deref().unwrap_or("text");
        let mut scopes = Vec::new();
        for name in raw.split(',') {
            if name.trim().is_empty() {
                continue;
            }
            let scope = Scope::parse(name)
                .ok_or_else(|| format!("unknown scope `{name}` (text, attributes, code, page_names, groups, flow_labels)"))?;
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        }
        if scopes.is_empty() {
            scopes.push(Scope::Text);
        }
        Ok(scopes)
    }
}

// ---------------------------------------------------------------------------
// Searching a project
// ---------------------------------------------------------------------------

/// How many matched characters of context a snippet keeps on each side.
const SNIPPET_CONTEXT: usize = 48;
/// Files per page unless the caller says otherwise.
pub const DEFAULT_LIMIT: usize = 25;
pub const MAX_LIMIT: usize = 100;

/// Which side of the project to search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum In {
    Both,
    Pages,
    Components,
}

impl In {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim) {
            None | Some("") | Some("both") => Ok(Self::Both),
            Some("pages") => Ok(Self::Pages),
            Some("components") => Ok(Self::Components),
            Some(other) => Err(format!("unknown `in` value `{other}` (pages, components, both)")),
        }
    }

    fn pages(self) -> bool {
        matches!(self, Self::Both | Self::Pages)
    }

    fn components(self) -> bool {
        matches!(self, Self::Both | Self::Components)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Hit {
    /// Where the text sits: `text`, `attr:alt`, `code`, `component`.
    pub what: String,
    pub line: usize,
    /// The surrounding text with the hit wrapped in `<<`/`>>`.
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileHits {
    pub kind: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub version: i64,
    /// Components only: the routes whose pages use this component — the reason
    /// one edit here fixes all of them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub used_by_routes: Vec<String>,
    pub count: usize,
    pub matches: Vec<Hit>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LabelHit {
    /// `page_title`, `page_label`, `group` or `flow_label`.
    pub what: String,
    /// The matched name itself (page title, label, group name, edge label).
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// Flow labels only: the two routes the arrow joins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routes: Option<Vec<String>>,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResponse {
    /// Matches across the WHOLE project, not just this page of files.
    pub total: usize,
    pub file_count: usize,
    /// The distinct surface forms matched, each with its count — `{"AI coach":
    /// 41, "AI Coach": 12}`. A rename that ignores a variant leaves it behind.
    pub variants: std::collections::BTreeMap<String, usize>,
    pub files: Vec<FileHits>,
    pub labels: Vec<LabelHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A snippet around `range` in `text`, with the hit marked `<<like this>>`.
/// The window is counted in CHARACTERS so it never lands mid-codepoint on a
/// multi-byte page.
fn snippet(text: &str, range: std::ops::Range<usize>) -> String {
    let start = floor_char_boundary(text, range.start.saturating_sub(SNIPPET_CONTEXT));
    let end = ceil_char_boundary(text, (range.end + SNIPPET_CONTEXT).min(text.len()));
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&text[start..range.start]);
    out.push_str("<<");
    out.push_str(&text[range.start..range.end]);
    out.push_str(">>");
    out.push_str(&text[range.end..end]);
    if end < text.len() {
        out.push('…');
    }
    out
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// 1-based line of a raw byte offset.
fn line_of(raw: &str, offset: usize) -> usize {
    1 + raw[..offset.min(raw.len())].bytes().filter(|b| *b == b'\n').count()
}

/// The content matches inside one page fragment.
fn page_hits(file: &DesignFile, matcher: &Matcher, scopes: &[Scope]) -> Vec<Hit> {
    let mut hits = Vec::new();
    let wants_text = scopes.contains(&Scope::Text);
    let wants_attributes = scopes.contains(&Scope::Attributes);
    if wants_text || wants_attributes {
        for segment in scan_fragment(&file.content).segments {
            let is_attribute = segment.attribute.is_some();
            if is_attribute != wants_attributes || (!is_attribute && !wants_text) {
                continue;
            }
            for range in matcher.find(&segment.decoded) {
                let raw_offset = segment.raw_map.get(range.start).copied().unwrap_or(0);
                hits.push(Hit {
                    what: segment
                        .attribute
                        .as_ref()
                        .map(|name| format!("attr:{name}"))
                        .unwrap_or_else(|| "text".to_string()),
                    line: line_of(&file.content, raw_offset),
                    snippet: snippet(&segment.decoded, range),
                });
            }
        }
    }
    if scopes.contains(&Scope::Code) {
        for range in matcher.find(&file.content) {
            hits.push(Hit {
                what: "code".to_string(),
                line: line_of(&file.content, range.start),
                snippet: snippet(&file.content, range),
            });
        }
    }
    hits
}

/// A whole-component search. A component IS code: its template literals and
/// its attribute strings are one haystack, so every content scope reads the
/// same way. Reported once, with the routes that use it — editing it once
/// fixes every one of them.
fn component_hits(file: &DesignFile, matcher: &Matcher) -> Vec<Hit> {
    matcher
        .find(&file.content)
        .into_iter()
        .map(|range| Hit {
            what: "component".to_string(),
            line: line_of(&file.content, range.start),
            snippet: snippet(&file.content, range),
        })
        .collect()
}

/// Run a search over an already-loaded project. `layout` feeds the label
/// scopes; `manifest` the page titles.
pub fn search_project(
    files: &[DesignFile],
    layout: &crate::layout_doc::LayoutDoc,
    matcher: &Matcher,
    scopes: &[Scope],
    in_: In,
    limit: usize,
    cursor: Option<&str>,
) -> SearchResponse {
    let manifest = crate::manifest::build(0, files, 0);

    // Content: one entry per file that matched, in a deterministic order —
    // pages by path, then components by path.
    let mut matching: Vec<FileHits> = Vec::new();
    if in_.pages() {
        for file in files.iter().filter(|f| f.kind == DesignFileKind::Page) {
            let hits = page_hits(file, matcher, scopes);
            if hits.is_empty() {
                continue;
            }
            matching.push(FileHits {
                kind: "page".to_string(),
                route: crate::manifest::route_for_page(&file.path),
                file: file.path.clone(),
                name: None,
                version: file.version,
                used_by_routes: Vec::new(),
                count: hits.len(),
                matches: hits,
            });
        }
    }
    if in_.components() && scopes.iter().any(|s| matches!(s, Scope::Text | Scope::Attributes | Scope::Code)) {
        for file in files.iter().filter(|f| f.kind == DesignFileKind::Component) {
            let name = file
                .path
                .strip_prefix("components/")
                .and_then(|p| p.strip_suffix(".js"))
                .map(str::to_string);
            let hits = component_hits(file, matcher);
            if hits.is_empty() {
                continue;
            }
            let used_by_routes = name
                .as_deref()
                .and_then(|n| manifest.components.iter().find(|c| c.name == n))
                .map(|c| c.used_on.clone())
                .unwrap_or_default();
            matching.push(FileHits {
                kind: "component".to_string(),
                file: file.path.clone(),
                route: None,
                name,
                version: file.version,
                used_by_routes,
                count: hits.len(),
                matches: hits,
            });
        }
    }
    matching.sort_by(|a, b| {
        (a.kind.as_str(), a.file.as_str()).cmp(&(b.kind.as_str(), b.file.as_str()))
    });

    // Labels: names that live in the arrangement, not in any file.
    let mut labels: Vec<LabelHit> = Vec::new();
    let mut label_match = |name: &str, what: &str, route: Option<String>, group_id: Option<String>, routes: Option<Vec<String>>| {
        for range in matcher.find(name) {
            labels.push(LabelHit {
                what: what.to_string(),
                name: name.to_string(),
                route: route.clone(),
                group_id: group_id.clone(),
                routes: routes.clone(),
                snippet: snippet(name, range),
            });
        }
    };
    if scopes.contains(&Scope::PageNames) {
        for entry in &manifest.routes {
            label_match(&entry.title, "page_title", Some(entry.path.clone()), None, None);
        }
        for (route, label) in &layout.page_labels {
            label_match(label, "page_label", Some(route.clone()), None, None);
        }
    }
    if scopes.contains(&Scope::Groups) {
        for group in &layout.groups {
            label_match(&group.name, "group", None, Some(group.id.clone()), None);
        }
    }
    if scopes.contains(&Scope::FlowLabels) {
        for edge in &layout.edges {
            if let Some(label) = edge.label.as_deref() {
                label_match(
                    label,
                    "flow_label",
                    None,
                    None,
                    Some(vec![edge.from.clone(), edge.to.clone()]),
                );
            }
        }
    }

    // The variant summary describes EVERY match, before pagination.
    let mut variants: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for file in &matching {
        for hit in &file.matches {
            if let Some(marked) = variant_of(&hit.snippet) {
                *variants.entry(marked).or_insert(0) += 1;
            }
        }
    }
    for label in &labels {
        if let Some(marked) = variant_of(&label.snippet) {
            *variants.entry(marked).or_insert(0) += 1;
        }
    }

    let content_total: usize = matching.iter().map(|f| f.count).sum();
    let total = content_total + labels.len();
    let file_count = matching.len();

    // Pagination is by FILE, after the cursor path (exclusive). The cursor is
    // a file path, so it stays meaningful even if the project changed between
    // calls — the worst case is a page of overlap, never a skipped file.
    let start = cursor
        .map(|c| matching.partition_point(|f| f.file.as_str() <= c))
        .unwrap_or(0);
    let end = (start + limit).min(matching.len());
    let page: Vec<FileHits> = matching[start..end].to_vec();
    let next_cursor = if end < matching.len() {
        page.last().map(|f| f.file.clone())
    } else {
        None
    };

    SearchResponse { total, file_count, variants, files: page, labels, next_cursor }
}

/// The matched text as it appears in a snippet — the `<<…>>` marker peeled
/// back off. `None` for a snippet without a marker (impossible for our own
/// output, but this function must not invent a variant if it ever happens).
fn variant_of(snippet: &str) -> Option<String> {
    let start = snippet.find("<<")? + 2;
    let end = snippet[start..].find(">>")? + start;
    Some(snippet[start..end].to_string())
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

/// `GET /api/taskflow/agents/design/search` — the design's search tool.
pub async fn search(
    taskflow_agents::agent_auth::RequireAgent(agent): taskflow_agents::agent_auth::RequireAgent,
    Query(q): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    if agent.project_id != q.project {
        return Err(StatusCode::FORBIDDEN.into_response());
    }
    let json = run_search(agent.project_id, &q).await?;
    Ok(Json(json))
}

/// The search itself, split from the handler so tests (and a future operator
/// route) can call it without an agent identity.
pub async fn run_search(
    project_id: i64,
    q: &SearchQuery,
) -> Result<serde_json::Value, Response> {
    let query_text = q.query_text().map_err(bad_query)?;
    let scopes = q.scopes().map_err(bad_query)?;
    let in_ = In::parse(q.r#in.as_deref()).map_err(bad_query)?;
    let matcher = Matcher::new(query_text, q.regex, q.case_sensitive, q.whole_word)
        .map_err(bad_query)?;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let files = crate::store::list_files(project_id).await;
    let (doc, _, _) = crate::views::load_layout(project_id)
        .await
        .map_err(|code| code.into_response())?;
    let response = search_project(&files, &doc, &matcher, &scopes, in_, limit, q.cursor.as_deref());
    Ok(serde_json::to_value(response).unwrap_or(serde_json::Value::Null))
}

/// A malformed query is the caller's to fix, and the message says how.
fn bad_query(message: String) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(serde_json::json!({
            "ok": false,
            "error": "bad_query",
            "detail": message,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn matcher(query: &str, whole_word: bool) -> Matcher {
        Matcher::new(query, false, false, whole_word).expect("a valid matcher")
    }

    #[test]
    fn whole_word_does_not_match_inside_a_longer_word() {
        let m = matcher("coach", true);
        assert_eq!(m.find("the coach is here").len(), 1);
        assert_eq!(m.find("coaching the team").len(), 0);
        assert_eq!(m.find("coach's hat").len(), 1, "possessive is a boundary");
    }

    #[test]
    fn substring_mode_finds_inside_words() {
        let m = matcher("coach", false);
        assert_eq!(m.find("coaching the team").len(), 1);
    }

    #[test]
    fn case_insensitive_by_default_and_sensitive_on_request() {
        let loose = matcher("AI coach", true);
        assert_eq!(loose.find("our AI Coach shipped").len(), 1);
        let strict = Matcher::new("AI coach", false, true, true).unwrap();
        assert_eq!(strict.find("our AI Coach shipped").len(), 0);
        assert_eq!(strict.find("our AI coach shipped").len(), 1);
    }

    #[test]
    fn regex_mode_uses_the_pattern_as_given() {
        let m = Matcher::new(r"AI[ -]coach", true, false, false).unwrap();
        assert_eq!(m.find("AI-coach and AI coach").len(), 2);
    }

    #[test]
    fn an_invalid_pattern_is_an_error_not_a_panic() {
        assert!(Matcher::new("([unclosed", true, false, false).is_err());
    }

    #[test]
    fn scan_reads_text_runs_and_skips_script_contents() {
        let index = scan_fragment("<main>Hello <b>coach</b><script>var coach = 1;</script></main>");
        let texts: Vec<&str> = index
            .segments
            .iter()
            .filter(|s| s.attribute.is_none())
            .map(|s| s.decoded.as_str())
            .collect();
        assert_eq!(
            texts,
            ["Hello ", "coach"],
            "text runs only — no empty runs between tags, and never the script body: {texts:?}"
        );
        assert!(texts.iter().all(|t| !t.contains("var")));
    }

    #[test]
    fn scan_reads_the_text_attributes() {
        let index = scan_fragment(r#"<img src="a.png" alt="AI coach logo" title='Start coaching'>"#);
        let attrs: Vec<(String, String)> = index
            .segments
            .iter()
            .filter_map(|s| s.attribute.clone().map(|name| (name, s.decoded.clone())))
            .collect();
        assert_eq!(
            attrs,
            [
                ("alt".to_string(), "AI coach logo".to_string()),
                ("title".to_string(), "Start coaching".to_string())
            ]
        );
        // src is not one of them: a class or file name is not copy.
        assert!(!attrs.iter().any(|(name, _)| name == "src"));
    }

    #[test]
    fn scan_handles_comments_and_quoted_angles() {
        let index = scan_fragment(r#"<!-- coach > not text --><p title="a > b">x</p>"#);
        let values: Vec<&str> = index.segments.iter().map(|s| s.decoded.as_str()).collect();
        assert!(values.contains(&"a > b"), "the quoted > did not end the tag: {values:?}");
        // A comment is not text — including one that CONTAINS a '>', which is
        // the case a parser that just skips to the next '>' would leak.
        assert!(
            !values.iter().any(|v| v.contains("coach") || v.contains("not text")),
            "comment text leaked into the haystack: {values:?}"
        );
    }

    #[test]
    fn scan_decodes_entities_and_remembers_raw_offsets() {
        let raw = "<p>R&amp;D coach</p>";
        let index = scan_fragment(raw);
        let segment = index
            .segments
            .iter()
            .find(|s| s.decoded.contains("R&D"))
            .expect("the decoded text run");
        assert_eq!(segment.decoded, "R&D coach");
        // The 'R' is at raw offset 3, and the byte after the run maps to the
        // '<' of </p> — the map a line number is computed from.
        assert_eq!(segment.raw_map[0], 3);
        assert_eq!(*segment.raw_map.last().unwrap(), raw.find("</p>").unwrap());
    }

    #[test]
    fn scan_keeps_numeric_entities() {
        let index = scan_fragment("<p>caf&#233;</p>");
        assert!(index.segments.iter().any(|s| s.decoded.contains("café")));
    }

    #[test]
    fn scan_of_plain_text_has_one_segment() {
        let index = scan_fragment("just words");
        assert_eq!(index.segments.len(), 1);
        assert_eq!(index.segments[0].decoded, "just words");
    }

    #[test]
    fn search_query_defaults_and_parsing() {
        let q: SearchQuery = serde_json::from_value(json!({ "project": 1, "query": " x " })).unwrap();
        assert_eq!(q.query_text().unwrap(), "x");
        assert!(q.whole_word, "whole word defaults ON");
        assert!(!q.regex);
        assert_eq!(q.scopes().unwrap(), vec![Scope::Text]);

        let q: SearchQuery = serde_json::from_value(json!({
            "project": 1, "q": "y", "scope": "text, code,code", "in": "pages"
        })).unwrap();
        assert_eq!(q.query_text().unwrap(), "y");
        assert_eq!(q.scopes().unwrap(), vec![Scope::Text, Scope::Code]);

        let q: SearchQuery = serde_json::from_value(json!({ "project": 1, "scope": "bogus" })).unwrap();
        assert!(q.scopes().is_err());
        let q: SearchQuery = serde_json::from_value(json!({ "project": 1 })).unwrap();
        assert!(q.query_text().is_err());
    }
}
