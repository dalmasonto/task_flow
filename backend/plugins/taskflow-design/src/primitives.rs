//! Server-side expansion of `<ui-*>` authoring primitives into real
//! Tailwind+token HTML.
//!
//! Agents author `<ui-accordion>`, `<ui-dialog>`, `<ui-sheet>` and `<ui-tabs>`
//! tags in page fragments; `expand_primitives` rewrites each recognized block
//! into native `<details>`/`<dialog>`/CSS-radio markup using only
//! `var(--token)` classes, so the composed document needs no JS runtime for
//! these components (`<dialog>` is opened via the `command`/`commandfor`
//! invoker attributes) and no shadow DOM.
//!
//! This is a hand-rolled, quote-aware, UTF-8-safe byte scanner in the same
//! style as `composer::annotate_sources` — no new crate dependency (no
//! regex, no HTML parser). Primitives do not self-nest in v1, so the first
//! matching close tag for a given primitive is always correct.

/// Escape text for interpolation into an HTML attribute value. Mirrors
/// `composer::esc`'s rules (that function is private to its module, so this
/// is a small local copy rather than a new shared dependency).
fn esc_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Escape a value that is interpolated into element TEXT (not an attribute):
/// only `<` and `>` are neutralized so a `<script>` smuggled through an
/// attribute value like `title`/`trigger`/`label` cannot become a live tag.
/// `&` and quotes are deliberately left untouched so author-written entities
/// (e.g. `&amp;`, `&mdash;`) survive verbatim, consistent with page-content
/// authoring.
fn esc_text(s: &str) -> String {
    s.replace('<', "&lt;").replace('>', "&gt;")
}

/// Deterministic id source: one counter per `expand_primitives` call so
/// output for a given input is stable across runs.
struct Counter(usize);

impl Counter {
    fn new() -> Self {
        Counter(0)
    }

    fn next(&mut self) -> usize {
        let v = self.0;
        self.0 += 1;
        v
    }
}

/// Extract an attribute's value from a start tag's source text (everything
/// from `<` to the matching `>`, inclusive). Quote-aware: only matches an
/// attribute whose `name=` is preceded by whitespace (or tag start), so
/// `data-title=` never matches a lookup for `title`.
fn get_attr(open_tag: &str, name: &str) -> Option<String> {
    let bytes = open_tag.as_bytes();
    let needle = format!("{name}=");
    let mut search_from = 0usize;
    while let Some(rel) = open_tag[search_from..].find(needle.as_str()) {
        let pos = search_from + rel;
        let preceded_ok = pos == 0
            || matches!(bytes[pos - 1], b' ' | b'\t' | b'\n' | b'\r');
        let val_start = pos + needle.len();
        if preceded_ok && val_start < bytes.len() {
            let q = bytes[val_start];
            if q == b'"' || q == b'\'' {
                if let Some(end_rel) = open_tag[val_start + 1..].find(q as char) {
                    let end = val_start + 1 + end_rel;
                    return Some(open_tag[val_start + 1..end].to_string());
                }
            }
        }
        search_from = pos + needle.len();
    }
    None
}

/// Copy the source tag's `data-src="..."` attribute (if present) as a
/// ready-to-splice ` data-src="..."` fragment, so callers can append it
/// directly after a root element's other attributes.
fn get_data_src(open_tag: &str) -> String {
    match get_attr(open_tag, "data-src") {
        Some(v) => format!(" data-src=\"{v}\""),
        None => String::new(),
    }
}

/// Find the quote-aware end (`>`) of a start tag beginning at `start` in
/// `haystack` (where `haystack.as_bytes()[start] == b'<'`). Returns the
/// index of the closing `>`, or `None` if the tag never closes.
fn find_tag_end(haystack: &str, start: usize) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let mut j = start + 1;
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
            return Some(j);
        }
        j += 1;
    }
    None
}

/// Byte after `<{tag}` (or `</{tag}`) that confirms the tag NAME ends there,
/// rather than this being a longer tag that merely shares the prefix (so
/// `ui-tab` never matches `ui-tabs`).
fn name_boundary(b: Option<&u8>) -> bool {
    b.is_none_or(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/'))
}

/// Find the byte index (of the `<`) of the `</{tag}>` close tag that MATCHES
/// the already-opened `<{tag}>` whose inner content starts at `content_start`,
/// counting nested same-name opens so self-nesting (e.g. a `ui-tabs` inside a
/// `ui-tabs`) resolves to the correct close. Returns `None` if unbalanced.
fn find_matching_close(haystack: &str, tag: &str, content_start: usize) -> Option<usize> {
    let open_needle = format!("<{tag}");
    let close_needle = format!("</{tag}>");
    let bytes = haystack.as_bytes();
    let mut depth = 1usize;
    let mut i = content_start;
    while i < haystack.len() {
        let rest = &haystack[i..];
        let next_close = rest.find(close_needle.as_str()).map(|r| i + r);
        let next_open = rest.find(open_needle.as_str()).map(|r| i + r);
        let close_pos = next_close?;
        if let Some(open_pos) = next_open {
            if open_pos < close_pos {
                let ends = name_boundary(bytes.get(open_pos + open_needle.len()));
                // Advance past this token either way; only a real, boundary-
                // terminated open increases depth (a prefix like `<ui-tabs`
                // when scanning for `ui-tab` is skipped without nesting).
                i = open_pos + open_needle.len();
                if ends {
                    depth += 1;
                }
                continue;
            }
        }
        depth -= 1;
        if depth == 0 {
            return Some(close_pos);
        }
        i = close_pos + close_needle.len();
    }
    None
}

fn is_known_primitive(name: &str) -> bool {
    matches!(name, "ui-accordion" | "ui-dialog" | "ui-sheet" | "ui-tabs")
}

/// Extract the raw inner content of the first `<tag>...</tag>` occurrence in
/// `inner`. Slot tags (`ui-dialog-title`, `ui-sheet-body`, ...) carry no
/// attributes of their own, so this is a plain (non quote-aware) substring
/// search rather than the full tag-scanning machinery.
fn extract_slot(inner: &str, tag: &str) -> String {
    let open_needle = format!("<{tag}");
    let Some(start) = inner.find(open_needle.as_str()) else {
        return String::new();
    };
    let Some(gt_rel) = inner[start..].find('>') else {
        return String::new();
    };
    let open_end = start + gt_rel + 1;
    // Depth-aware so an outer slot whose content contains a nested primitive
    // with a same-named slot (e.g. a ui-dialog inside a ui-dialog-body) is
    // captured whole, not truncated at the inner close tag.
    match find_matching_close(inner, tag, open_end) {
        Some(close_pos) => inner[open_end..close_pos].to_string(),
        None => String::new(),
    }
}

/// Extract each `<ui-tab label="...">PANEL</ui-tab>` child of a `<ui-tabs>`
/// block, in document order, as `(label, panel)` pairs.
fn extract_tabs(inner: &str) -> Vec<(String, String)> {
    let mut tabs = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0usize;
    while let Some(rel) = inner[i..].find("<ui-tab") {
        let start = i + rel;
        let after_name = start + "<ui-tab".len();
        // Require the next byte to end the tag name here (not "ui-tabs" or
        // some other "ui-tab*" tag).
        if after_name >= bytes.len()
            || !matches!(bytes[after_name], b' ' | b'\t' | b'\n' | b'\r' | b'>')
        {
            i = start + 1;
            continue;
        }
        let Some(end) = find_tag_end(inner, start) else {
            break;
        };
        let open_tag = &inner[start..=end];
        let label = get_attr(open_tag, "label").unwrap_or_default();
        let close = "</ui-tab>";
        // Depth-aware so a tab panel that contains a nested ui-tabs (whose
        // own ui-tab children close first) is captured whole.
        match find_matching_close(inner, "ui-tab", end + 1) {
            Some(content_end) => {
                let content_start = end + 1;
                let panel = inner[content_start..content_end].to_string();
                tabs.push((label, panel));
                i = content_end + close.len();
            }
            None => break,
        }
    }
    tabs
}

fn render_accordion(open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    let title = esc_text(&get_attr(open_tag, "title").unwrap_or_default());
    let data_src = get_data_src(open_tag);
    // Recurse so a primitive nested inside the accordion body (e.g. another
    // ui-accordion, or a ui-dialog) is fully expanded before splicing. Uses
    // the SAME counter so nested primitives get unique ids across the tree.
    // Terminates because this level's outer <ui-accordion>...</ui-accordion>
    // has already been consumed by the caller.
    let inner = expand_with(inner, counter);
    format!(
        r#"<details class="group border-b border-[var(--border)]"{data_src}>
  <summary class="flex cursor-pointer list-none items-center justify-between py-4 font-medium text-[var(--foreground)] marker:content-['']">{title}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-4 shrink-0 text-[var(--muted-foreground)] transition-transform group-open:rotate-180"><path d="m6 9 6 6 6-6"/></svg></summary>
  <div class="pb-4 text-[var(--muted-foreground)]">{inner}</div>
</details>"#
    )
}

fn render_dialog(open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    let n = counter.next();
    let id = format!("dialog-{n}");
    let trigger = esc_text(&get_attr(open_tag, "trigger").unwrap_or_else(|| "Open".to_string()));
    let name = get_attr(open_tag, "name").unwrap_or_else(|| id.clone());
    let name = esc_attr(&name);
    let data_src = get_data_src(open_tag);
    // Recurse into each slot so a nested primitive (e.g. a ui-accordion
    // inside ui-dialog-body) is fully expanded before splicing. Uses the SAME
    // counter so nested primitives get unique ids across the tree.
    let title = expand_with(&extract_slot(inner, "ui-dialog-title"), counter);
    let body = expand_with(&extract_slot(inner, "ui-dialog-body"), counter);
    format!(
        r#"<button type="button" command="show-modal" commandfor="{id}" class="inline-flex items-center rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]">{trigger}</button>
<dialog id="{id}" data-state="{name}" class="m-auto w-full max-w-lg rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-lg backdrop:bg-black/50"{data_src}>
  <h2 class="text-lg font-semibold">{title}</h2>
  <div class="mt-2 text-sm text-[var(--muted-foreground)]">{body}</div>
  <form method="dialog" class="mt-6 flex justify-end"><button class="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium">Close</button></form>
</dialog>"#
    )
}

const SHEET_CLASSES_RIGHT: &str = "fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-sm rounded-none border-l border-[var(--border)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-lg backdrop:bg-black/50";
const SHEET_CLASSES_LEFT: &str = "fixed inset-y-0 left-0 right-auto m-0 h-full max-h-none w-full max-w-sm rounded-none border-r border-l-0 border-[var(--border)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-lg backdrop:bg-black/50";

fn render_sheet(open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    let n = counter.next();
    let id = format!("sheet-{n}");
    let trigger = esc_text(&get_attr(open_tag, "trigger").unwrap_or_else(|| "Open".to_string()));
    let name = get_attr(open_tag, "name").unwrap_or_else(|| id.clone());
    let name = esc_attr(&name);
    let data_src = get_data_src(open_tag);
    let side = get_attr(open_tag, "side").unwrap_or_else(|| "right".to_string());
    let classes = if side == "left" {
        SHEET_CLASSES_LEFT
    } else {
        SHEET_CLASSES_RIGHT
    };
    let title = expand_with(&extract_slot(inner, "ui-sheet-title"), counter);
    let body = expand_with(&extract_slot(inner, "ui-sheet-body"), counter);
    format!(
        r#"<button type="button" command="show-modal" commandfor="{id}" class="inline-flex items-center rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]">{trigger}</button>
<dialog id="{id}" data-state="{name}" class="{classes}"{data_src}>
  <h2 class="text-lg font-semibold">{title}</h2>
  <div class="mt-2 text-sm text-[var(--muted-foreground)]">{body}</div>
  <form method="dialog" class="mt-6 flex justify-end"><button class="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium">Close</button></form>
</dialog>"#
    )
}

fn render_tabs(open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    let g = counter.next();
    let data_src = get_data_src(open_tag);
    let tabs = extract_tabs(inner);
    let mut inputs = String::new();
    let mut labels = String::new();
    let mut panels = String::new();
    for (k, (label, panel)) in tabs.iter().enumerate() {
        let checked = if k == 0 { " checked" } else { "" };
        // Recurse so a primitive nested inside a tab's panel (e.g. a
        // ui-dialog inside a ui-tab) is fully expanded before splicing. Uses
        // the SAME counter so nested primitives get unique ids/group names.
        let panel = expand_with(panel, counter);
        let label = esc_text(label);
        inputs.push_str(&format!(
            "<input type=\"radio\" name=\"tabs-{g}\" id=\"{g}-t{k}\" class=\"peer/t{k} sr-only\"{checked}>"
        ));
        labels.push_str(&format!(
            "<label for=\"{g}-t{k}\" class=\"cursor-pointer px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] border-b-2 border-transparent peer-checked/t{k}:border-[var(--primary)] peer-checked/t{k}:text-[var(--foreground)]\">{label}</label>"
        ));
        panels.push_str(&format!(
            "<div class=\"order-last hidden w-full py-4 text-[var(--foreground)] peer-checked/t{k}:block\">{panel}</div>"
        ));
    }
    // Radios, labels, a full-width divider and panels are ALL direct children
    // of one flex-wrap container so the labels/panels are LATER SIBLINGS of
    // each `peer/tK` radio — otherwise `peer-checked/tK:*` can never reach
    // them and panels stay hidden. The divider (order-1 w-full) wraps below
    // the default-order labels, and panels (order-last w-full) below that.
    format!(
        r#"<div class="flex w-full flex-wrap items-end"{data_src}>{inputs}{labels}<div class="order-1 w-full border-b border-[var(--border)]"></div>{panels}</div>"#
    )
}

fn render_primitive(tag_name: &str, open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    match tag_name {
        "ui-accordion" => render_accordion(open_tag, inner, counter),
        "ui-dialog" => render_dialog(open_tag, inner, counter),
        "ui-sheet" => render_sheet(open_tag, inner, counter),
        "ui-tabs" => render_tabs(open_tag, inner, counter),
        _ => unreachable!("dispatch only reached for known primitives"),
    }
}

/// Known slot/child tags: expanded only when inside their container, so a
/// stray standalone one would otherwise leak raw `<ui-...>` into the output.
const SLOT_TAGS: [&str; 5] = [
    "ui-dialog-title",
    "ui-dialog-body",
    "ui-sheet-title",
    "ui-sheet-body",
    "ui-tab",
];

/// Expand every recognized `<ui-*>` primitive block in `fragment` into real
/// Tailwind+token HTML. Non-primitive markup is left byte-identical; unknown
/// `<ui-foo>` tags are left untouched.
///
/// One `Counter` is threaded through the ENTIRE tree (all nested recursion
/// goes through `expand_with(.., &mut counter)`), so ids/group names are
/// unique across nesting. A final safety pass unwraps any residual known
/// slot/child tags (a stray `<ui-sheet-body>` outside its container) so the
/// hard "no `<ui-` in output" invariant always holds.
pub fn expand_primitives(fragment: &str) -> String {
    let mut counter = Counter::new();
    let expanded = expand_with(fragment, &mut counter);
    unwrap_stray_slots(&expanded)
}

/// Remove just the start/end tag tokens of any known slot/child tag left in
/// `s`, keeping their inner content. Leaves unknown `<ui-foo>` and the four
/// container tags (already expanded) untouched.
fn unwrap_stray_slots(s: &str) -> String {
    let mut out = s.to_string();
    for tag in SLOT_TAGS {
        // Remove close tags first (fixed form), then open tags (which may
        // carry attributes and so need quote-aware end-finding).
        out = out.replace(&format!("</{tag}>"), "");
        loop {
            let open_needle = format!("<{tag}");
            let Some(start) = out.find(open_needle.as_str()) else {
                break;
            };
            // Confirm the tag name ends here (not e.g. "ui-tab" matching
            // "ui-tabs") before stripping the token.
            let after = start + open_needle.len();
            let ends_name = out.as_bytes().get(after).is_none_or(|b| {
                matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
            });
            let Some(end) = find_tag_end(&out, start) else {
                break;
            };
            if ends_name {
                out.replace_range(start..=end, "");
            } else {
                // Not this tag (e.g. ui-tabs): can't easily skip in a
                // replace loop, so leave the whole string as-is for this tag.
                break;
            }
        }
    }
    out
}

fn expand_with(fragment: &str, counter: &mut Counter) -> String {
    let bytes = fragment.as_bytes();
    let mut out = String::with_capacity(fragment.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' && fragment[i..].starts_with("<ui-") {
            let name_start = i + 1;
            let mut k = name_start;
            while k < bytes.len()
                && (bytes[k].is_ascii_alphanumeric() || bytes[k] == b'-')
            {
                k += 1;
            }
            let tag_name = &fragment[name_start..k];

            let Some(j) = find_tag_end(fragment, i) else {
                // Unterminated tag: copy the rest through unchanged, matching
                // composer::annotate_sources's fallback for malformed input.
                out.push_str(&fragment[i..]);
                break;
            };
            let open_tag = &fragment[i..=j];
            let self_closing = open_tag.trim_end().ends_with("/>");

            if is_known_primitive(tag_name) && !self_closing {
                let close_tag = format!("</{tag_name}>");
                // Depth-aware so a self-nested container (e.g. ui-tabs inside
                // ui-tabs) matches its OWN close, not the inner one.
                if let Some(inner_end) = find_matching_close(fragment, tag_name, j + 1) {
                    let inner_start = j + 1;
                    let inner = &fragment[inner_start..inner_end];
                    let expanded = render_primitive(tag_name, open_tag, inner, counter);
                    out.push_str(&expanded);
                    i = inner_end + close_tag.len();
                    continue;
                }
            }

            // Unknown tag, self-closing primitive, or no matching close
            // found: copy the open tag through unchanged and keep scanning
            // — its "inner content" (if any) then passes through as plain
            // text via the default branch below.
            out.push_str(open_tag);
            i = j + 1;
            continue;
        }

        let ch = fragment[i..].chars().next().unwrap_or('<');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// A static, agent-facing catalog of the authorable `<ui-*>` primitives:
/// one entry per primitive an agent may WRITE (the slot sub-tags, like
/// `ui-dialog-title`, are documented inside their parent's `slots` array
/// rather than getting their own top-level entry, since they are never
/// authored standalone).
pub fn catalog() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "ui-accordion",
            "attrs": ["title"],
            "slots": [],
            "usage": "<ui-accordion title=\"Shipping\">Free over $50.</ui-accordion>"
        },
        {
            "name": "ui-dialog",
            "attrs": ["trigger", "name"],
            "slots": ["ui-dialog-title", "ui-dialog-body"],
            "usage": "<ui-dialog trigger=\"Delete\" name=\"confirm\"><ui-dialog-title>Sure?</ui-dialog-title><ui-dialog-body>No undo.</ui-dialog-body></ui-dialog>"
        },
        {
            "name": "ui-sheet",
            "attrs": ["trigger", "name", "side"],
            "slots": ["ui-sheet-title", "ui-sheet-body"],
            "usage": "<ui-sheet trigger=\"Menu\" name=\"nav\" side=\"right\"><ui-sheet-title>Menu</ui-sheet-title><ui-sheet-body>Links here.</ui-sheet-body></ui-sheet>"
        },
        {
            "name": "ui-tabs",
            "attrs": [],
            "slots": ["ui-tab (label attr)"],
            "usage": "<ui-tabs><ui-tab label=\"One\">First panel.</ui-tab><ui-tab label=\"Two\">Second panel.</ui-tab></ui-tabs>"
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accordion_expands_to_details() {
        let out = expand_primitives(r#"<ui-accordion title="Ship &amp; pay">Free.</ui-accordion>"#);
        assert!(out.contains("<details"), "{out}");
        assert!(out.contains("<summary"));
        assert!(out.contains("Ship &amp; pay"));
        assert!(out.contains(">Free.</div>") || out.contains("Free."));
        assert!(!out.contains("<ui-"), "no primitive tags survive: {out}");
    }

    #[test]
    fn non_primitive_markup_is_untouched() {
        let src = r#"<section class="p-4"><p>hi</p></section>"#;
        assert_eq!(expand_primitives(src), src);
    }

    #[test]
    fn unknown_ui_tag_left_intact() {
        let src = "<ui-nope>x</ui-nope>";
        assert_eq!(expand_primitives(src), src);
    }

    #[test]
    fn dialog_expands_with_native_dialog_and_invoker() {
        let out = expand_primitives(
            r#"<ui-dialog trigger="Delete" name="confirm"><ui-dialog-title>Sure?</ui-dialog-title><ui-dialog-body>No undo.</ui-dialog-body></ui-dialog>"#,
        );
        assert!(out.contains(r#"command="show-modal""#) && out.contains("commandfor="));
        assert!(out.contains("<dialog") && out.contains(r#"data-state="confirm""#));
        assert!(out.contains("Sure?") && out.contains("No undo.") && out.contains(">Delete<"));
        assert!(!out.contains("<ui-"));
    }

    #[test]
    fn sheet_pins_to_side() {
        let out = expand_primitives(
            r#"<ui-sheet side="left"><ui-sheet-title>Menu</ui-sheet-title><ui-sheet-body>x</ui-sheet-body></ui-sheet>"#,
        );
        assert!(out.contains("<dialog") && out.contains("left-0"));
        assert!(!out.contains("<ui-"));
    }

    #[test]
    fn tabs_expand_css_only() {
        let out = expand_primitives(
            r#"<ui-tabs><ui-tab label="One">first</ui-tab><ui-tab label="Two">second</ui-tab></ui-tabs>"#,
        );
        // Flattened structure: no wrapper divs that would break peer-checked
        // sibling reach.
        assert!(!out.contains(r#"<div role="tablist">"#), "{out}");
        assert!(!out.contains(r#"<div class="py-4">"#), "{out}");
        assert!(out.matches("type=\"radio\"").count() == 2);
        // First radio carries ` checked`.
        let first_radio = out.find("type=\"radio\"").expect("has a radio");
        let first_tag_end = out[first_radio..].find('>').expect("radio tag closes") + first_radio;
        assert!(out[first_radio..=first_tag_end].contains(" checked"), "{out}");
        assert!(out.contains("peer-checked/t0:block") && out.contains("peer-checked/t1:block"));
        assert!(out.contains("One") && out.contains("second"));
        assert!(!out.contains("<ui-") && !out.contains("<script"));
    }

    // --- Extra edge cases ---

    #[test]
    fn data_src_copied_onto_root_only() {
        let src = r#"<ui-accordion title="Q" data-src="pages/index.html:5">A</ui-accordion>"#;
        let out = expand_primitives(src);
        assert!(out.contains(r#"data-src="pages/index.html:5""#), "{out}");
        assert_eq!(out.matches("data-src=").count(), 1, "{out}");
    }

    #[test]
    fn primitive_surrounded_by_other_markup_preserves_siblings() {
        let src = r#"<p>before</p><ui-accordion title="Q">A</ui-accordion><p>after</p>"#;
        let out = expand_primitives(src);
        assert!(out.starts_with("<p>before</p>"), "{out}");
        assert!(out.ends_with("<p>after</p>"), "{out}");
        assert!(out.contains("<details"));
        assert!(!out.contains("<ui-"));
    }

    #[test]
    fn get_attr_handles_single_quoted_values() {
        let out = expand_primitives(r#"<ui-accordion title='Single quoted'>Body</ui-accordion>"#);
        assert!(out.contains("Single quoted"), "{out}");
        assert!(!out.contains("<ui-"));
    }

    #[test]
    fn similarly_named_attribute_is_not_confused_with_title() {
        // `data-title` must not be picked up by a lookup for `title`.
        let out = expand_primitives(
            r#"<ui-accordion data-title="wrong" title="Right">Body</ui-accordion>"#,
        );
        assert!(out.contains(">Right<"), "{out}");
        assert!(!out.contains(">wrong<"));
    }

    #[test]
    fn dialog_defaults_trigger_and_name_when_absent() {
        let out = expand_primitives(
            r#"<ui-dialog><ui-dialog-title>T</ui-dialog-title><ui-dialog-body>B</ui-dialog-body></ui-dialog>"#,
        );
        assert!(out.contains(">Open<"), "{out}");
        assert!(out.contains(r#"data-state="dialog-0""#), "{out}");
    }

    #[test]
    fn sheet_defaults_to_right_side() {
        let out = expand_primitives(
            r#"<ui-sheet><ui-sheet-title>T</ui-sheet-title><ui-sheet-body>B</ui-sheet-body></ui-sheet>"#,
        );
        assert!(out.contains("right-0") && out.contains("left-auto"), "{out}");
        assert!(!out.contains("<ui-"));
    }

    #[test]
    fn counter_increments_across_multiple_dialogs() {
        let out = expand_primitives(
            r#"<ui-dialog><ui-dialog-title>A</ui-dialog-title><ui-dialog-body>a</ui-dialog-body></ui-dialog><ui-dialog><ui-dialog-title>B</ui-dialog-title><ui-dialog-body>b</ui-dialog-body></ui-dialog>"#,
        );
        assert!(out.contains("dialog-0"), "{out}");
        assert!(out.contains("dialog-1"), "{out}");
    }

    #[test]
    fn unknown_tag_alongside_known_primitive() {
        let src = r#"<ui-bogus>keep me</ui-bogus><ui-accordion title="Q">A</ui-accordion>"#;
        let out = expand_primitives(src);
        assert!(out.contains("<ui-bogus>keep me</ui-bogus>"), "{out}");
        assert!(out.contains("<details"));
    }

    #[test]
    fn tabs_root_carries_data_src() {
        let src = r#"<ui-tabs data-src="pages/x.html:9"><ui-tab label="A">a</ui-tab></ui-tabs>"#;
        let out = expand_primitives(src);
        assert!(out.contains(r#"data-src="pages/x.html:9""#), "{out}");
    }

    #[test]
    fn nested_accordion_inside_dialog_body_is_expanded() {
        let out = expand_primitives(
            r#"<ui-dialog><ui-dialog-title>T</ui-dialog-title><ui-dialog-body><ui-accordion title="Q">A</ui-accordion></ui-dialog-body></ui-dialog>"#,
        );
        assert!(out.contains("<details"), "{out}");
        assert!(!out.contains("<ui-"), "{out}");
    }

    #[test]
    fn nested_accordion_inside_tab_panel_is_expanded() {
        let out = expand_primitives(
            r#"<ui-tabs><ui-tab label="One"><ui-accordion title="Q">A</ui-accordion></ui-tab></ui-tabs>"#,
        );
        assert!(out.contains("<details"), "{out}");
        assert!(!out.contains("<ui-"), "{out}");
    }

    #[test]
    fn nested_dialogs_get_distinct_ids_across_nesting() {
        // A top-level dialog AND a dialog nested in an accordion body must not
        // share `id="dialog-0"` — one counter is threaded through the tree.
        let out = expand_primitives(
            r#"<ui-dialog><ui-dialog-title>A</ui-dialog-title><ui-dialog-body>a</ui-dialog-body></ui-dialog><ui-accordion title="More"><ui-dialog><ui-dialog-title>B</ui-dialog-title><ui-dialog-body>b</ui-dialog-body></ui-dialog></ui-accordion>"#,
        );
        assert!(out.contains("dialog-0"), "{out}");
        assert!(out.contains("dialog-1"), "{out}");
        assert!(!out.contains("<ui-"), "{out}");
    }

    #[test]
    fn nested_tabs_get_distinct_group_names() {
        let out = expand_primitives(
            r#"<ui-tabs><ui-tab label="Outer"><ui-tabs><ui-tab label="Inner">x</ui-tab></ui-tabs></ui-tab></ui-tabs>"#,
        );
        assert!(out.contains(r#"name="tabs-0""#), "{out}");
        assert!(out.contains(r#"name="tabs-1""#), "{out}");
        assert!(!out.contains("<ui-"), "{out}");
    }

    #[test]
    fn primitive_text_attrs_are_escaped() {
        let out = expand_primitives(
            r#"<ui-accordion title="</summary><script>alert(1)</script>">x</ui-accordion>"#,
        );
        assert!(!out.contains("<script>"), "{out}");
        assert!(!out.contains("</summary>x"), "{out}");
        assert!(out.contains("&lt;script&gt;"), "{out}");
        assert!(out.contains("&lt;/summary&gt;"), "{out}");
    }

    #[test]
    fn stray_slot_tag_is_unwrapped() {
        let out = expand_primitives("<ui-sheet-body>hello</ui-sheet-body>");
        assert!(out.contains("hello"), "{out}");
        assert!(!out.contains("<ui-"), "{out}");
    }

    #[test]
    fn catalog_contains_ui_dialog_with_usage() {
        let cat = catalog();
        let entries = cat.as_array().expect("catalog is a json array");
        let dialog = entries
            .iter()
            .find(|e| e["name"] == "ui-dialog")
            .expect("catalog has a ui-dialog entry");
        assert!(
            dialog["usage"].as_str().is_some_and(|s| !s.is_empty()),
            "{dialog}"
        );
    }

    #[test]
    fn catalog_contains_ui_tabs_with_usage() {
        let cat = catalog();
        let entries = cat.as_array().expect("catalog is a json array");
        let tabs = entries
            .iter()
            .find(|e| e["name"] == "ui-tabs")
            .expect("catalog has a ui-tabs entry");
        assert!(
            tabs["usage"].as_str().is_some_and(|s| !s.is_empty()),
            "{tabs}"
        );
    }
}
