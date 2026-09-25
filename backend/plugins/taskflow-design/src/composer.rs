//! The shell composer — the thing that guarantees consistency.
//!
//! Agents never write `<html>`, `<head>` or `<body>`; the server generates the
//! document on every request from the manifest + the page fragment. Identical
//! head, identical tokens, identical component definitions, identical picker —
//! there is nothing for an agent to copy-paste and nothing to drift.
//!
//! Also owns source annotation (`data-src="pages/x.html:12"`), sandbox-URL
//! rewriting of internal links, and the overlay `state` hook screenshots use.

use crate::manifest::DesignManifest;
use crate::resources::ResourceLink;

/// The picker runtime, injected verbatim into every composed document. This is
/// SYSTEM-owned: it is never read from a design row, so agents cannot alter or
/// disable selection. Capture-phase listeners so a page's own handlers cannot
/// swallow the click; `stopImmediatePropagation` keeps links dead while picking.
const PICKER_RUNTIME: &str = r#"(() => {
  let on = false;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
    'border:2px solid var(--pick,#6366f1);border-radius:3px;transition:all .06s';
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
    'font:11px ui-monospace;background:#6366f1;color:#fff;padding:1px 5px;border-radius:3px';

  const pathTo = (el) => {
    const parts = [];
    while (el && el !== document.body && parts.length < 8) {
      const i = [...el.parentElement.children].indexOf(el) + 1;
      parts.unshift(el.tagName.toLowerCase() + ':nth-child(' + i + ')');
      if (el.dataset.component) break;
      el = el.parentElement;
    }
    return parts.join(' > ');
  };

  addEventListener('mousemove', (e) => {
    if (!on) return;
    const el = e.target;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px' });
    Object.assign(label.style, { top: Math.max(0, r.top - 18) + 'px', left: r.left + 'px' });
    const host = el.closest('[data-component]');
    label.textContent = host ? host.dataset.component : el.tagName.toLowerCase();
    document.body.append(box, label);
  }, true);

  addEventListener('click', (e) => {
    if (!on) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const el = e.target, host = el.closest('[data-component]');
    const r = el.getBoundingClientRect();
    parent.postMessage({ type: 'design:select',
      component: host && host.dataset.component || null,
      elementPath: pathTo(el),
      src: el.closest('[data-src]') ? el.closest('[data-src]').dataset.src : null,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      snippet: el.outerHTML.slice(0, 600),
      ancestors: (() => { const a = []; let n = el;
        while (n && n !== document.body) { a.unshift((n.dataset && n.dataset.component) || n.tagName.toLowerCase()); n = n.parentElement; }
        return a.slice(-6); })()
    }, '*');
  }, true);

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') parent.postMessage({ type: 'design:deselect' }, '*');
    if (on && e.key !== 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  const ro = new ResizeObserver(() => parent.postMessage(
    { type: 'design:size', h: document.documentElement.scrollHeight }, '*'));
  ro.observe(document.documentElement);

  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'design:mode') { on = !!m.picking;
      document.documentElement.style.cursor = on ? 'crosshair' : '';
      if (!on) { box.remove(); label.remove(); } }
    if (m.type === 'design:theme') document.documentElement.dataset.theme = m.theme;
    if (m.type === 'design:flash') {
      try {
        const target = m.elementPath ? document.querySelector(m.elementPath)
          : (m.selector ? document.querySelector(m.selector) : null);
        if (target) {
          const prev = target.style.outline;
          target.style.outline = '3px solid var(--pick,#6366f1)';
          setTimeout(() => { target.style.outline = prev; }, 900);
          if (target.scrollIntoViewIfNeeded) target.scrollIntoViewIfNeeded();
          else target.scrollIntoView({ block: 'center' });
        }
      } catch (_) {}
    }
  });

  parent.postMessage({ type: 'design:ready',
    h: document.documentElement.scrollHeight }, '*');
})();"#;

/// Escape text for interpolation into HTML.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Rewrite sandbox-relative hrefs to tokenized URLs so `<a href="/settings">`
/// navigates natively inside the frame — no router needed.
fn rewrite_hrefs(html: &str, base: &str) -> String {
    // Match href="/..." and href="./..." and href="#..."; only path-form hrefs
    // need the prefix. Anchors pass through untouched.
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(pos) = rest.find("href=\"") {
        let abs = pos;
        out.push_str(&rest[..abs]);
        let after = &rest[abs + "href=\"".len()..];
        let end = after.find('"').unwrap_or(after.len());
        let href = &after[..end];
        let rewritten = if href.starts_with('/') && !href.starts_with("/s/") && !href.starts_with("//")
        {
            format!("{}{}", base.trim_end_matches('/'), href)
        } else if href.starts_with('#') || href.is_empty() || href.starts_with("http") {
            href.to_string()
        } else {
            // Relative like "settings" → sibling route.
            format!("{}/{}", base.trim_end_matches('/'), href)
        };
        out.push_str(&format!("href=\"{rewritten}\""));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Stamp `data-src="{file}:{line}"` on every element that does not already
/// carry one. Line numbers come from counting newlines up to each start tag —
/// exactly what an agent needs to land an edit on `pages/settings.html:41`.
pub fn annotate_sources(fragment: &str, file: &str) -> String {
    let bytes = fragment.as_bytes();
    let mut out = String::with_capacity(fragment.len() + fragment.len() / 8);
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' || i + 1 >= bytes.len() {
            out.push(bytes[i] as char);
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        if !next.is_ascii_alphabetic() {
            // Closing tags, comments, doctypes: copy through byte-wise to stay
            // UTF-8 safe on multibyte content.
            let ch = fragment[i..].chars().next().unwrap_or('<');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        // Find the real end of the start tag (quote-aware).
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
            out.push_str(&fragment[i..]);
            break;
        }
        let tag_src = &fragment[i..=j];
        if tag_src.contains("data-src=") {
            out.push_str(tag_src);
        } else {
            let line = fragment[..i].matches('\n').count() + 1;
            // Insert just before the closing `>` (or `/>`).
            let trimmed = tag_src.trim_end();
            let self_closing = trimmed.ends_with("/>");
            let head = if self_closing {
                trimmed.strip_suffix("/>").expect("checked")
            } else {
                trimmed.strip_suffix('>').expect("checked")
            };
            out.push_str(head);
            out.push_str(&format!(" data-src=\"{}:{}\"", file, line));
            if self_closing {
                out.push_str("/>");
            } else {
                out.push('>');
            }
        }
        i = j + 1;
    }
    out
}

/// The body-fragment pipeline shared by [`compose_document`] and the
/// chrome-facing `page.html` export (`fragment=1`): rewrite sandbox-relative
/// hrefs, stamp `data-src`, then expand `<ui-*>` primitives into real markup.
/// Kept as one function so the two callers can never drift apart.
pub fn compose_body_fragment(token: &str, page_path: &str, fragment: &str) -> String {
    let base = format!("/s/{token}");
    let annotated = annotate_sources(&rewrite_hrefs(fragment, &base), page_path);
    crate::primitives::expand_primitives(&annotated)
}

/// The project's enabled external resources as tags for the document head.
/// Emitted BEFORE the page's own stylesheet so a page can override a webfont,
/// and only for enabled sets — a disabled set contributes nothing.
///
/// Takes the slice rather than the manifest so it stays pure: the caller (the
/// manifest, or a test) supplies exactly the links to emit.
///
/// ESCAPING IS LOAD-BEARING HERE, not hygiene. `resources::validate` treats a
/// url as opaque, so it accepts one containing a quote, and this document runs
/// scripts — an unescaped `href="https://ok.example/x" onload="…"` would close
/// the attribute and execute. Every interpolated value goes through [`esc`],
/// and EVERY ATTRIBUTE IS DOUBLE-QUOTED because `esc` escapes `"` but NOT `'`:
/// a single-quoted attribute here would let a quote in a url break out with
/// `esc` powerless to stop it. The scheme refusal that keeps `javascript:` out
/// of these values is [`crate::resources::validate`]'s, which the manifest runs
/// before this ever sees a link.
pub fn resources_tags(links: &[(bool, ResourceLink)]) -> String {
    let mut out = String::new();
    for (is_script, link) in links {
        if *is_script {
            if let Some(src) = &link.script {
                out.push_str(&format!(
                    "<script src=\"{}\"{}></script>\n",
                    esc(src),
                    if link.is_async { " async" } else { "" }
                ));
            }
        } else if let (Some(rel), Some(href)) = (&link.rel, &link.href) {
            out.push_str(&format!(
                "<link rel=\"{}\" href=\"{}\"{}>\n",
                esc(rel),
                esc(href),
                if link.crossorigin { " crossorigin" } else { "" }
            ));
        }
    }
    out
}

/// Compose the full document for one route.
///
/// * `token`     — the sandbox read token for this project
/// * `manifest`  — the current derived manifest
/// * `route`     — `/`, `/settings`, …
/// * `page_path` — `pages/settings.html` (must map back to `route`)
/// * `fragment`  — the raw body fragment
/// * `state`     — optional overlay state (`dialog:confirm-delete`) the
///   composer wires to open on load so screenshot review can reach UI that
///   only exists after a click.
pub fn compose_document(
    token: &str,
    manifest: &DesignManifest,
    _route: &str,
    page_path: &str,
    fragment: &str,
    theme: &str,
    state: Option<&str>,
) -> String {
    let annotated = compose_body_fragment(token, page_path, fragment);

    // The project's external resources (a webfont and its companion links) land
    // in the head before the page's own stylesheet, so a page can override a
    // webfont. Empty — and so invisible — for a project that has none.
    let resources = resources_tags(&manifest.resources);

    let mut component_tags = String::new();
    for c in &manifest.components {
        component_tags
            .push_str(&format!("<script src=\"/s/{token}/f/components/{}.js\"></script>\n", esc(&c.name)));
    }

    // Overlay state hook: a tiny system-owned script mapping `?state=` names to
    // elements. Convention: `state="dialog:<name>"` opens `[data-state=<name>]`
    // (removing [hidden], adding open) on load. Components opt in by stamping
    // data-state on their overlays; pages that name no such element simply
    // render normally.
    let state_script = match state {
        Some(s) if !s.is_empty() => {
            let kind = s.split(':').next().unwrap_or("");
            let name = s.split_once(':').map(|x| x.1).unwrap_or("");
            if (kind == "dialog" || kind == "overlay") && !name.is_empty() {
                format!(
                    r#"<script>
document.addEventListener('DOMContentLoaded', () => {{
  const el = document.querySelector('[data-state="{}"], dialog[name="{}"]');
  if (!el) return;
  if (el instanceof HTMLDialogElement) {{ try {{ el.showModal(); }} catch (_) {{}} }}
  else {{ el.removeAttribute('hidden'); el.setAttribute('open', ''); }}
}});
</script>"#,
                    esc(name),
                    esc(name)
                )
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };

    format!(
        r#"<!doctype html>
<html lang="en" data-theme="{theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* Sandbox-only thin scrollbar so laptop/tablet previews scroll with a slim
       track instead of the ~16px OS desktop scrollbar inside the fixed device
       width. The iframe is ALWAYS its true CSS width, so this media query sees
       the emulated device width directly. */
    ::-webkit-scrollbar {{ width: 6px; height: 6px; }}
    ::-webkit-scrollbar-track {{ background: transparent; }}
    ::-webkit-scrollbar-thumb {{ background: rgba(128,128,128,.4); border-radius: 3px; }}
    html {{ scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.4) transparent; }}
    /* Phone-width previews (widest phone preset is 440px; the next size up is a
       640px breakpoint): no visible track at all — real phones use overlay
       scrollbars that reserve no layout width. */
    @media (max-width: 500px) {{
      ::-webkit-scrollbar {{ width: 0; height: 0; }}
      html {{ scrollbar-width: none; }}
    }}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  {resources}<link rel="stylesheet" href="/s/{token}/f/styles/tokens.css">
  {component_tags}<script>{PICKER_RUNTIME}</script>
  {state_script}
</head>
<body class="bg-[var(--background)] text-[var(--foreground)] antialiased">
{annotated}
</body>
</html>"#,
    )
}

/// Case-insensitive replace of `needle` with `replacement` throughout
/// `haystack`. `needle` must be ASCII — that guarantees byte offsets found in
/// an ASCII-lowercased copy of `haystack` line up with `haystack` itself
/// (`to_ascii_lowercase` only ever rewrites ASCII bytes in place, so it never
/// changes length or shifts any byte, ASCII or not), so slicing the original
/// string at those offsets always lands on valid UTF-8 boundaries.
fn replace_ascii_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    debug_assert!(needle.is_ascii());
    let lower_hay = haystack.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut rest = haystack;
    let mut lower_rest = lower_hay.as_str();
    while let Some(pos) = lower_rest.find(&lower_needle) {
        out.push_str(&rest[..pos]);
        out.push_str(replacement);
        rest = &rest[pos + needle.len()..];
        lower_rest = &lower_rest[pos + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// Neutralize `</script` (any case) inside text about to be inlined into a
/// `<script>...</script>` block, so component JS containing that literal
/// (e.g. a template string with a `</script>` example) cannot terminate the
/// tag early. `<\/script` is valid, semantically identical JS — an escaped
/// `/` is a no-op outside a regex literal and how a `/` is written inside
/// one — but the HTML tokenizer no longer reads it as a close tag.
fn escape_for_inline_script(s: &str) -> String {
    replace_ascii_ci(s, "</script", "<\\/script")
}

/// Same idea for text inlined into a `<style>...</style>` block: neutralize
/// `</style` (any case) so generated tokens CSS can never early-close the tag.
fn escape_for_inline_style(s: &str) -> String {
    replace_ascii_ci(s, "</style", "<\\/style")
}

/// The export-document body pipeline: expand `<ui-*>` primitives ONLY. Unlike
/// [`compose_body_fragment`] (the sandbox/picker pipeline), this does NOT
/// rewrite hrefs to sandbox-relative `/s/<token>/...` URLs and does NOT stamp
/// `data-src` — a portable export must carry no sandbox-only cruft.
pub fn compose_export_body(fragment: &str) -> String {
    crate::primitives::expand_primitives(fragment)
}

/// Compose a SELF-CONTAINED document for one route: tokens CSS and component
/// JS are inlined (not linked/`src=`'d to a sandbox origin), and the picker
/// runtime is omitted entirely. This is what `page.html` downloads — it must
/// render correctly opened straight off disk, with no server behind it.
///
/// * `page_path`    — kept for signature symmetry with [`compose_document`]
///   and any future export-time diagnostics; the export body pipeline itself
///   needs no file/line context (no `data-src` is stamped).
/// * `tokens_css`   — the GENERATED tokens stylesheet content (same generator
///   the `/api/design/{project}/tokens.css` export uses), inlined verbatim
///   (escaped) rather than linked.
/// * `components`   — `(name, js_source)` pairs; each is inlined as its own
///   `<script>` (escaped) rather than `src=`'d.
/// * `resources`    — the manifest's `resources` pairs, the project's external
///   links. Passed as the slice (not the manifest) to keep this function pure.
///   They travel with the download on purpose: a font that renders in the
///   artboard but is missing from `page.html` would be a silent surprise.
pub fn compose_export_document(
    page_path: &str,
    fragment: &str,
    theme: &str,
    tokens_css: &str,
    components: &[(String, String)],
    resources: &[(bool, ResourceLink)],
) -> String {
    let _ = page_path;
    let body = compose_export_body(fragment);

    let mut component_scripts = String::new();
    for (_name, js) in components {
        component_scripts.push_str("<script>");
        component_scripts.push_str(&escape_for_inline_script(js));
        component_scripts.push_str("</script>\n");
    }

    let safe_tokens_css = escape_for_inline_style(tokens_css);
    let resource_tags = resources_tags(resources);

    format!(
        r#"<!doctype html>
<html lang="en" data-theme="{theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  {resource_tags}<style>{safe_tokens_css}</style>
  {component_scripts}</head>
<body class="bg-[var(--background)] text-[var(--foreground)] antialiased">
{body}
</body>
</html>"#,
    )
}

/// CSP for the sandbox origin. Tight `connect-src` (self + Tailwind CDN only):
/// without it, agent-authored JS could `fetch()` the operator's localhost and
/// internal network from inside their browser. Inline scripts are allowed
/// because the composer's own picker/state scripts are inline by design.
///
/// `script-src`, `style-src`, `font-src`, `img-src` and `media-src` allow any
/// `https:` origin — those five and no others. They are the directives a
/// project's external resources need, because such a resource is fetched by the
/// RENDERER and never by `fetch()`: a stylesheet arrives under `style-src`, the
/// font file it names under `font-src`, a companion script under `script-src`,
/// an `<img>` (or a CSS `background-image`, or a sprite sheet) under `img-src`,
/// and a `<video>`/`<audio>` source under `media-src`.
///
/// `https:` here is a SCHEME SOURCE, not `*`: plain `http:` stays refused, and
/// `data:` and `blob:` stay because inline content is what the design layer
/// already had. `media-src` is new here and is seeded with those same three for
/// the same reason. Unlike a font, an image or a video is DECLARED nowhere —
/// the page's own markup names it, and `validate_page_fragment` has no
/// attribute-level url rules at all — so such a url reaches the browser with no
/// manifest entry, no editor and no scheme check behind it. This policy is the
/// whole of its boundary, which is exactly why it names the scheme and not `*`.
///
/// `connect-src` is deliberately NOT widened, and Lottie is not a reason to
/// widen it. A Lottie animation has two independent blockers, and neither is
/// `img-src`: a page fragment may not contain `<script src` at all (the
/// validator refuses that marker), and a Lottie player `fetch()`es its
/// animation JSON, which lands under `connect-src`. It is deliverable anyway
/// WITHOUT touching this directive — the player loads inside a COMPONENT, whose
/// JS the composer inlines as an inline script and which `script-src https:`
/// already permits from any https origin, and the animation JSON lives under
/// `assets/`, which the sandbox serves same-origin, so `connect-src 'self'`
/// covers that fetch. Widening this one would buy Lottie nothing and would hand
/// agent-authored JS a channel to POST the operator's localhost and intranet to
/// any https host.
///
/// `form-action`, `base-uri` and `frame-ancestors` stay as they were.
///
/// The widening is bounded by three things together, and each is load-bearing.
/// The sandbox is a separate origin with no cookies behind a short-lived
/// read-only token, so a page that misbehaves with what it loads reaches
/// nothing of the operator's beyond the project it is already rendering. Every
/// value in play is written by the project's own members through the normal
/// write path — the manifest's links, and the urls a page writes into its own
/// markup for an image or a video, alike — and a page cannot add a resource
/// DECLARATION for itself: the validator refuses `<script src`. And the scheme
/// is what bounds those values: `resources::validate` refuses any manifest url
/// that is not `https:`, so `javascript:` and a `data:` document can never
/// reach an emitted attribute in the first place, while a url written straight
/// into page markup is not scheme-checked by anything — for those, the scheme
/// source named here is the only thing refusing plain `http:`.
///
/// `style-src` and `font-src` also still allow jsdelivr explicitly. That adds no
/// new host to the trust boundary: jsdelivr is already permitted for
/// `script-src`, the strongest capability here, so allowing a stylesheet and a
/// font from that same origin grants nothing an agent could not already do.
///
/// Before the `https:` widening, `style-src 'self'` silently refused every
/// external webfont — the `<link>` stayed in the DOM, the browser dropped the
/// request, and the page fell back to the system stack with nothing visible in
/// the page to say so. `media-src` is spelled out here for the same reason it
/// did not exist before: until it does, `default-src 'self'` governs a
/// `<video>`, so an external source is refused the same silent way.
pub fn sandbox_csp(token: &str) -> String {
    let _ = token;
    format!(
        "default-src 'self'; \
         script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; \
         style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https:; \
         img-src 'self' data: blob: https:; \
         media-src 'self' data: blob: https:; \
         font-src 'self' data: https://cdn.jsdelivr.net https:; \
         connect-src 'self' https://cdn.jsdelivr.net; \
         form-action 'none'; \
         base-uri 'none'; \
         frame-ancestors *"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_for_inline_script_neutralizes_every_case_variant() {
        let js = "const s = '</script>'; const t = '</SCRIPT>'; const u = '</ScRiPt data-x>';";
        let escaped = escape_for_inline_script(js);
        assert!(
            !escaped.to_ascii_lowercase().contains("</script"),
            "a literal </script (any case) must not survive escaping: {escaped}"
        );
        assert!(
            escaped.contains("<\\/script"),
            "escaping should neutralize via a backslash before the slash: {escaped}"
        );
    }

    #[test]
    fn escape_for_inline_script_leaves_unrelated_text_untouched() {
        let js = "customElements.define('x', class extends HTMLElement {});";
        assert_eq!(escape_for_inline_script(js), js);
    }

    #[test]
    fn escape_for_inline_style_neutralizes_close_tag() {
        let css = ":root { --note: '</style> injected'; }";
        let escaped = escape_for_inline_style(css);
        assert!(!escaped.to_ascii_lowercase().contains("</style"));
        assert!(escaped.contains("<\\/style"));
    }

    #[test]
    fn compose_export_document_inlines_tokens_and_components_with_no_picker() {
        let doc = compose_export_document(
            "pages/index.html",
            r#"<app-header title="Hi"></app-header>"#,
            "light",
            ":root { --accent: #6366f1; }",
            &[("app-header".to_string(), "customElements.define('app-header', class {});".to_string())],
            &[],
        );
        assert!(doc.contains("<style>:root { --accent: #6366f1; }</style>"));
        assert!(!doc.contains("href=\"/s/"));
        assert!(doc.contains("customElements.define('app-header'"));
        assert!(!doc.contains("<script src=\"/s/"));
        assert!(!doc.contains("design:select"), "picker runtime must not be present in an export");
        assert!(!doc.contains("data-src="));
    }
}
