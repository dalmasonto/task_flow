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
    let close_tag = format!("</{tag}>");
    match inner[open_end..].find(close_tag.as_str()) {
        Some(close_rel) => inner[open_end..open_end + close_rel].to_string(),
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
        match inner[end + 1..].find(close) {
            Some(close_rel) => {
                let content_start = end + 1;
                let content_end = content_start + close_rel;
                let panel = inner[content_start..content_end].to_string();
                tabs.push((label, panel));
                i = content_end + close.len();
            }
            None => break,
        }
    }
    tabs
}

fn render_accordion(open_tag: &str, inner: &str) -> String {
    let title = get_attr(open_tag, "title").unwrap_or_default();
    let data_src = get_data_src(open_tag);
    // Recurse so a primitive nested inside the accordion body (e.g. another
    // ui-accordion, or a ui-dialog) is fully expanded before splicing.
    // Terminates because this level's outer <ui-accordion>...</ui-accordion>
    // has already been consumed by the caller.
    let inner = expand_primitives(inner);
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
    let trigger = get_attr(open_tag, "trigger").unwrap_or_else(|| "Open".to_string());
    let name = get_attr(open_tag, "name").unwrap_or_else(|| id.clone());
    let name = esc_attr(&name);
    let data_src = get_data_src(open_tag);
    // Recurse into each slot so a nested primitive (e.g. a ui-accordion
    // inside ui-dialog-body) is fully expanded before splicing.
    let title = expand_primitives(&extract_slot(inner, "ui-dialog-title"));
    let body = expand_primitives(&extract_slot(inner, "ui-dialog-body"));
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
    let trigger = get_attr(open_tag, "trigger").unwrap_or_else(|| "Open".to_string());
    let name = get_attr(open_tag, "name").unwrap_or_else(|| id.clone());
    let name = esc_attr(&name);
    let data_src = get_data_src(open_tag);
    let side = get_attr(open_tag, "side").unwrap_or_else(|| "right".to_string());
    let classes = if side == "left" {
        SHEET_CLASSES_LEFT
    } else {
        SHEET_CLASSES_RIGHT
    };
    let title = expand_primitives(&extract_slot(inner, "ui-sheet-title"));
    let body = expand_primitives(&extract_slot(inner, "ui-sheet-body"));
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
        // ui-dialog inside a ui-tab) is fully expanded before splicing.
        let panel = expand_primitives(panel);
        inputs.push_str(&format!(
            "<input type=\"radio\" name=\"tabs-{g}\" id=\"{g}-t{k}\" class=\"peer/t{k} sr-only\"{checked}>\n"
        ));
        labels.push_str(&format!(
            "<label for=\"{g}-t{k}\" class=\"cursor-pointer px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] peer-checked/t{k}:border-b-2 peer-checked/t{k}:border-[var(--primary)] peer-checked/t{k}:text-[var(--foreground)]\">{label}</label>\n"
        ));
        panels.push_str(&format!(
            "<div class=\"hidden peer-checked/t{k}:block text-[var(--foreground)]\">{panel}</div>\n"
        ));
    }
    format!(
        r#"<div class="w-full"{data_src}>
  {inputs}  <div role="tablist" class="flex gap-1 border-b border-[var(--border)]">
    {labels}  </div>
  <div class="py-4">
    {panels}  </div>
</div>"#
    )
}

fn render_primitive(tag_name: &str, open_tag: &str, inner: &str, counter: &mut Counter) -> String {
    match tag_name {
        "ui-accordion" => render_accordion(open_tag, inner),
        "ui-dialog" => render_dialog(open_tag, inner, counter),
        "ui-sheet" => render_sheet(open_tag, inner, counter),
        "ui-tabs" => render_tabs(open_tag, inner, counter),
        _ => unreachable!("dispatch only reached for known primitives"),
    }
}

/// Expand every recognized `<ui-*>` primitive block in `fragment` into real
/// Tailwind+token HTML. Non-primitive markup is left byte-identical; unknown
/// `<ui-foo>` tags (including primitive slot tags encountered outside their
/// parent, like a stray `<ui-dialog-title>`) are left untouched.
pub fn expand_primitives(fragment: &str) -> String {
    let mut counter = Counter::new();
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
                if let Some(close_rel) = fragment[j + 1..].find(close_tag.as_str()) {
                    let inner_start = j + 1;
                    let inner_end = inner_start + close_rel;
                    let inner = &fragment[inner_start..inner_end];
                    let expanded = render_primitive(tag_name, open_tag, inner, &mut counter);
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
        assert!(out.matches("type=\"radio\"").count() == 2);
        assert!(out.contains("peer-checked/t0:block") && out.contains("peer-checked/t1:block"));
        assert!(out.contains(" checked")); // first tab
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
}
