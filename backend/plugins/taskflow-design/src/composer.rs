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

  // Nothing else ever takes the cue down, so leaving the frame has to: a
  // pointer that moves to the next artboard (or out to the chrome) otherwise
  // leaves the last box drawn in THIS document, and the previous screen keeps
  // showing a highlight for an element nobody is over.
  const clear = () => { box.remove(); label.remove(); };

  addEventListener('mousemove', (e) => {
    if (!on) return;
    const el = e.target;
    const r = el.getBoundingClientRect();
    // Hide rather than draw when the target describes nothing but the frame
    // itself: the body/documentElement, a rect with no area, or a container
    // that fills the viewport — a page shell like `min-h-screen main`, whose
    // box would cover the whole artboard and read as a bug rather than a cue.
    // clientWidth/clientHeight, not innerWidth/innerHeight: the latter include
    // the scrollbar, which a full-bleed container's width does not.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (el === document.body || el === document.documentElement
        || !r.width || !r.height
        || (r.width >= vw - 1 && r.height >= vh - 1)) {
      clear();
      return;
    }
    Object.assign(box.style, { top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px' });
    Object.assign(label.style, { top: Math.max(0, r.top - 18) + 'px', left: r.left + 'px' });
    const host = el.closest('[data-component]');
    label.textContent = host ? host.dataset.component : el.tagName.toLowerCase();
    document.body.append(box, label);
  }, true);

  // The pointer left this document. Cross-origin frames report the element it
  // entered as null — it is in another document — which is exactly the signal
  // `relatedTarget` gives us. Capture phase, like the listeners above, so a
  // page's own handler cannot swallow it.
  //
  // NOT verifiable under CDP: Chrome delivers no cross-frame pointer-leave, so
  // this never fires there and the stale box survives in both the broken and
  // fixed runtime — verify with a real pointer move (Firefox, or by hand).
  addEventListener('mouseout', (e) => { if (!e.relatedTarget) clear(); }, true);

  addEventListener('click', (e) => {
    if (!on) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const el = e.target, host = el.closest('[data-component]');
    const r = el.getBoundingClientRect();
    // The crumb chain: el upward to the body, of which the chrome keeps the
    // nearest six. All THREE arrays are slices of that one window, so index i
    // names the same element in each — the chrome's breadcrumb widens a
    // selection BY INDEX and never re-derives the chain. `ancestors` is each
    // element's label (`dataset.component || tagName`), `ancestorPaths` its
    // `pathTo` (what `elementPath` would have been), and `ancestorComponents`
    // the nearest `[data-component]` host at or above it (what `component`
    // would have been) — a label alone cannot be turned back into an element,
    // and a component label does not carry the element's tag.
    const chain = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) chain.unshift(n);
    const kept = chain.slice(-6);
    const hostOf = (n) => { const h = n.closest('[data-component]');
      return h && h.dataset.component || null; };
    parent.postMessage({ type: 'design:select',
      component: host && host.dataset.component || null,
      elementPath: pathTo(el),
      src: el.closest('[data-src]') ? el.closest('[data-src]').dataset.src : null,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      snippet: el.outerHTML.slice(0, 600),
      ancestors: kept.map((n) => (n.dataset && n.dataset.component) || n.tagName.toLowerCase()),
      ancestorPaths: kept.map(pathTo),
      ancestorComponents: kept.map(hostOf)
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
      if (!on) clear(); }
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

  // Report where this frame actually IS. A page navigated by its own links is
  // showing a DIFFERENT page than the board was created for, and the chrome
  // must not keep claiming the old one.
  //
  // The path crosses the wire exactly as the sandbox serves it — `/s/{token}`
  // plus the page's own route, UNSTRIPPED: the chrome turns it into an app
  // route, where that rule is a pure function with a test on it
  // (`v2_fe/src/pages/design/design-route.ts`). A conversion written into this
  // string could not be unit-tested from either side — see the plan's own note
  // on this runtime (Task 15, Step 3) — and the frame's message is untrusted
  // input however it is spelled, so parsing it one hop later costs nothing.
  const announce = () => parent.postMessage(
    { type: 'design:route', path: location.pathname }, '*');
  // `pageshow`, NOT `load`. A Back or Forward the browser satisfies from the
  // back/forward cache restores the document WITHOUT firing `load` — and a Back
  // is precisely the interaction this exists for, so `load` would leave the
  // header claiming the old route at the one moment it matters. `pageshow`
  // fires on a normal load as well (with `persisted: false`), so it subsumes
  // `load` rather than supplementing it.
  addEventListener('pageshow', announce);
  // `popstate` fires on a history TRAVERSAL — a Back or Forward between two
  // same-document entries — which fires neither of the above and loads nothing.
  //
  // It does NOT fire when a page CALLS pushState/replaceState: only the
  // traversal does. A page that routes entirely in JS is therefore unreported
  // until its first Back, and that limit is deliberate: announcing from inside
  // those calls would mean wrapping `history` in the one runtime every composed
  // page inherits, for a page shape no project here has written. A Back control
  // (`history.back()`) IS a traversal, so that much works.
  addEventListener('popstate', announce);
})();"#;

/// Escape text for interpolation into HTML.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Does this href carry a `scheme:` prefix — `http:`, `mailto:`, `tel:`, and by
/// construction `javascript:`/`data:`/`blob:`? Matches RFC 3986's scheme
/// grammar (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), so a path or query
/// that merely CONTAINS a colon is not mistaken for one.
///
/// BELT-AND-BRACES, and it is only fair to say so: as the caller uses it this
/// can never change the outcome. A scheme cannot begin with `/`, so it cannot
/// apply to a site-absolute href; and a route path can never contain a `:`
/// (`manifest::page_path_for_route` admits alphanumerics, `-` and `_` only), so
/// it cannot apply to a relative one either. The route-membership test is what
/// actually refuses `mailto:`. It is kept, and kept as a conjunct rather than a
/// branch, for two reasons: the rule it states is the one the brief names, and
/// a conjunct can only ever turn a would-be rewrite into a leave-alone — so if
/// the route-membership rule is ever relaxed, this cannot resurrect the
/// `mailto:` bug from the other direction.
fn has_scheme(href: &str) -> bool {
    match href.split_once(':') {
        Some((scheme, _)) => {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

/// Does the tag this href sits in ask for a new tab?
///
/// A real attribute read, not a substring search, because EVERY spelling that
/// is legal HTML for the same instruction has to be recognised: the attribute
/// name is case-insensitive, whitespace may surround the `=`, and the value may
/// be double-quoted, single-quoted or BARE (`target=_blank`). A fixed
/// `target="_blank"` substring missed the last three and silently hijacked
/// those links into the frame — the exact thing this check exists to prevent.
///
/// `tag` is the element's text from its `<` to just before its `>`.
fn opens_new_tab(tag: &str) -> bool {
    // `to_ascii_lowercase` rewrites only ASCII bytes in place, so it never
    // shifts an offset: every byte position found in the lowered copy is a
    // valid position in `tag` too.
    let lower = tag.to_ascii_lowercase();
    let b = lower.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // A quoted VALUE is never an attribute: skip it whole, so a `target=`
        // written inside another attribute's value (`href="/target=_blank"`)
        // cannot be mistaken for one. Quote bytes are ASCII, so they can never
        // occur inside a multi-byte sequence and the offsets stay on
        // boundaries.
        if b[i] == b'"' || b[i] == b'\'' {
            let quote = b[i];
            i += 1;
            while i < b.len() && b[i] != quote {
                i += 1;
            }
            i += 1;
            continue;
        }
        // The NAME has to be a whole token — `data-target=` is a different
        // attribute and must not count.
        if !b[i..].starts_with(b"target")
            || (i > 0
                && (b[i - 1].is_ascii_alphanumeric() || matches!(b[i - 1], b'-' | b'_' | b':')))
        {
            i += 1;
            continue;
        }
        let mut j = i + "target".len();
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if b.get(j) != Some(&b'=') {
            // `targets=`, or a bare `target` with no value at all.
            i += 1;
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let value = match b.get(j) {
            Some(q) if *q == b'"' || *q == b'\'' => {
                let start = j + 1;
                let len = b[start..]
                    .iter()
                    .position(|c| c == q)
                    .unwrap_or(b.len() - start);
                &lower[start..start + len]
            }
            Some(_) => {
                // Unquoted: ends at whitespace, `>`, or a quote. `=` is the
                // HTML rule too, and keeps `target=_blank=` from reading as
                // `_blank`.
                let end = b[j..]
                    .iter()
                    .position(|c| {
                        c.is_ascii_whitespace() || matches!(c, b'>' | b'"' | b'\'' | b'=')
                    })
                    .map_or(b.len(), |n| j + n);
                &lower[j..end]
            }
            None => return false,
        };
        // First match wins, like a browser: a tag cannot legally carry the
        // attribute twice.
        return value == "_blank";
    }
    false
}

/// Rewrite a sandbox-relative href to a tokenized URL so a click navigates
/// natively inside the frame — no router needed.
///
/// That is the whole mechanism behind in-device navigation: because the click
/// becomes a real navigation inside the iframe, the frame gets its own session
/// history, and back/forward — and an agent-written `history.back()` — work with
/// nothing further built.
///
/// Deliberately conservative, because a rewrite that is wrong turns a link that
/// works into one that does not:
///   * an href is rewritten only when it NAMES A MANIFEST ROUTE, compared on
///     the href's PATH — everything before a `?` or a `#`. `/not-a-page` is
///     left alone, since a 404 under a plausible URL is worse than the dead
///     link the author wrote;
///   * the query and the fragment RIDE ALONG with a rewrite: `href="/app?tab=2"`
///     names the `/app` route and becomes `/s/{token}/app?tab=2`, which serves.
///     Comparing the href as written instead left it alone, to resolve on the
///     sandbox origin's bare `/app` — a 404;
///   * a trailing slash is not part of a route path, so it is normalized away:
///     `/app/` becomes `/s/{token}/app`. Only the ROOT is served in both shapes
///     (`/s/{token}` and `/s/{token}/` both 200); `/s/{token}/app/` 404s, so a
///     rewrite that appended `/app/` verbatim would only move the 404 inside
///     the namespace;
///   * a plain relative path is rewritten on the ROOT page and nowhere else,
///     because the root frame's document URL is the bare `/s/{token}` with NO
///     trailing slash (`serve_page_root` is registered without one, and the
///     request is served, not redirected, so a browser's base path is `/s/`):
///     `href="app"` there resolves to `/s/app` — outside the namespace, and a
///     404 — and is rewritten to `/s/{token}/app`. On every other route the
///     same href already resolves inside the namespace
///     (`/s/{token}/settings` + `app` = `/s/{token}/app`), so it is left
///     byte-identical. A dot-segment relative (`./app`, `../app`) names no
///     route and is left as written: resolving dot segments is a different
///     job, and a guess there is a rewrite that is wrong;
///   * an empty href, `#fragment`, `?query`, `//protocol-relative`, anything
///     with a `scheme:` prefix (`http:`, `mailto:`, `tel:`, and by
///     construction `javascript:`/`data:`), and an already-tokenized `/s/…`
///     href are all returned byte-identical;
///   * a `target="_blank"` link is left alone: the markup asked for a new tab.
///
/// `routes` is the manifest's route list, the only paths a link in the frame
/// can reach. `is_root` says whether the page being composed IS the root route,
/// which is the one case where a relative href needs a hand.
fn rewrite_hrefs(html: &str, base: &str, routes: &[String], is_root: bool) -> String {
    // `/s/{token}` and `/s/{token}/` both serve, so the base never carries a
    // trailing slash — the rewrite below appends the route's own path, and the
    // root route appends nothing.
    let base = base.trim_end_matches('/');
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(pos) = rest.find("href=\"") {
        out.push_str(&rest[..pos]);
        let value_start = pos + "href=\"".len();
        let after = &rest[value_start..];
        let end = after.find('"').unwrap_or(after.len());
        let href = &after[..end];

        // The whole tag this href belongs to — from its `<` to its `>` — so
        // the new-tab check below can read a SECOND attribute off the same
        // element. `end` is where the closing quote sits, or the end of input
        // for an unterminated value.
        let tag_start = rest[..pos].rfind('<').map_or(0, |i| i + 1);
        let tag_end = rest[value_start + end..]
            .find('>')
            .map_or(rest.len(), |i| value_start + end + i);

        // The href's PATH — everything before its query or fragment. The route
        // a link names is decided by the path alone: `/app?tab=2` is the `/app`
        // page with a query, and both serve as `/s/{token}/app?tab=2`.
        let path_end = href.find(['?', '#']).unwrap_or(href.len());
        let path = &href[..path_end];
        let suffix = &href[path_end..];

        // A trailing slash is not a route. Only the ROOT is registered in both
        // shapes; for a child route, `/s/{token}/app/` 404s where
        // `/s/{token}/app` serves, so the match is made on the slashless path
        // and the rewrite emits the route's own spelling.
        let route_path = if path == "/" {
            "/"
        } else {
            path.trim_end_matches('/')
        };

        // Which route this href names, if any. ONE rule, three shapes, and each
        // shape is fully handled by its own arm — none of them falls through to
        // the next, because a guard that hands an excluded href to a more
        // permissive branch is how `//cdn.example/x` came to be rewritten to
        // `/s/tok///cdn.example/x` while an unreachable `!starts_with("//")`
        // guard sat two lines above it.
        let route: Option<&String> = if href.is_empty()
            // A bare `#fragment` or `?query` names THIS page, not another
            // route: their path is empty, and both resolve against the
            // document's own URL wherever it is.
            || path.is_empty()
            // A `scheme:` URL belongs to another protocol entirely. Inert as
            // the rule now stands — membership already refuses them — and kept
            // as a conjunct, see `has_scheme`.
            || has_scheme(href)
            || opens_new_tab(&rest[tag_start..tag_end])
        {
            None
        } else if path.starts_with('/') {
            if path.starts_with("//") || path.starts_with("/s/") {
                // `//host/path` is protocol-relative — another origin — and
                // `/s/…` is already tokenized (a pasted composed URL); rewriting
                // either would nest the prefix.
                None
            } else {
                routes.iter().find(|r| r.as_str() == route_path)
            }
        } else if is_root {
            // Relative, on the root page: see the doc comment. Resolved the way
            // a browser would — against the sandbox root — and rewritten only
            // if what it resolves to is a route.
            let resolved = format!("/{route_path}");
            routes.iter().find(|r| r.as_str() == resolved)
        } else {
            // Relative on any other page: resolves correctly inside the
            // namespace on its own, so it is left alone.
            None
        };

        let rewritten = match route {
            // "/" is the frame's root and maps to the BARE base: the client's
            // `sandboxUrl` drops the path for it, and both forms serve. Every
            // other route is emitted as the manifest spells it, with the href's
            // own query/fragment re-attached.
            Some(r) if r == "/" => format!("{base}{suffix}"),
            Some(r) => format!("{base}{r}{suffix}"),
            None => href.to_string(),
        };
        out.push_str(&format!("href=\"{rewritten}\""));
        // `end + 1` skips the closing quote, which is not consumed by the
        // `href="…"` written above and would otherwise be emitted twice.
        rest = after.get(end + 1..).unwrap_or("");
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

/// The body-fragment pipeline for the sandbox: rewrite sandbox-relative hrefs,
/// stamp `data-src`, then expand `<ui-*>` primitives into real markup.
///
/// The chrome-facing `page.html` export does NOT share this pipeline — it calls
/// [`compose_export_body`], which expands primitives and nothing else, so a
/// portable export carries neither `/s/<token>/` hrefs nor `data-src`.
///
/// `route` is the route this page IS (`/`, `/settings`, …), and `routes` the
/// manifest's route list; both go straight through to [`rewrite_hrefs`]: only
/// those paths are reachable inside the frame, a link to anything else is left
/// as the author wrote it, and `route` is what tells a relative href which page
/// it is resolving against.
pub fn compose_body_fragment(
    token: &str,
    route: &str,
    page_path: &str,
    fragment: &str,
    routes: &[String],
) -> String {
    let base = format!("/s/{token}");
    let is_root = route.is_empty() || route == "/";
    let annotated = annotate_sources(&rewrite_hrefs(fragment, &base, routes, is_root), page_path);
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
    route: &str,
    page_path: &str,
    fragment: &str,
    theme: &str,
    state: Option<&str>,
) -> String {
    // The route list the pages were built from — the only paths a link inside
    // the frame can navigate to. Computed once, here, and passed down.
    let routes: Vec<String> = manifest.routes.iter().map(|r| r.path.clone()).collect();
    // `route` is not only for diagnostics: which page this IS decides how a
    // RELATIVE href resolves (see [`rewrite_hrefs`]), because the root frame's
    // document URL has no trailing slash.
    let annotated = compose_body_fragment(token, route, page_path, fragment, &routes);

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
/// `img-src`: a page fragment cannot name a remote script statically in its
/// markup (the validator refuses the literal `<script src` marker), and a
/// Lottie player `fetch()`es its animation JSON, which lands under
/// `connect-src`. It is deliverable anyway WITHOUT touching this directive —
/// the player wiring belongs in a COMPONENT, which the sandbox loads as a
/// SAME-ORIGIN script: `compose_document` emits
/// `<script src="/s/{token}/f/components/{name}.js">` per registered component,
/// and `script-src 'self'` permits it. The player `<script src="https://…">`
/// that component appends is permitted by `script-src https:`. What the
/// component cannot do is fetch the animation from a file of its own, because
/// the sandbox has no file kind for one: `assets/` admits image extensions
/// only, and `styles/` admits `styles/tokens.css`, `styles/tokens.json` and
/// `styles/resources.json` (`validation::check_extension`, reached by every
/// write through `store::write_file`). So the animation travels INLINE in the
/// component — an object, which is what the player's `animationData` input is
/// for, rather than a `path` it would have to fetch — and the 128 KiB per-file
/// cap applies either way. Widening this one would buy Lottie nothing and would
/// hand agent-authored JS a channel to POST the operator's localhost and
/// intranet to any https host.
///
/// `form-action`, `base-uri` and `frame-ancestors` stay as they were.
///
/// The widening is bounded by three things together, and each is load-bearing.
/// The sandbox is a separate origin with no cookies behind a short-lived
/// read-only token, so a page that misbehaves with what it loads reaches
/// nothing of the operator's beyond the project it is already rendering. Every
/// value in play is written by the project's own members through the normal
/// write path — the manifest's links, and the urls a page writes into its own
/// markup for an image or a video, alike — and a page cannot name a remote
/// script STATICALLY in its own markup: the validator refuses the literal
/// `<script src` marker. (A markup rule, not a runtime one: an inline
/// `<script>` passes validation, and inline JS can append a
/// `<script src="https://…">` at runtime, which `'unsafe-inline'` plus the
/// `https:` scheme source permit. What a page cannot do is put that url in the
/// markup it hands the validator.) And the scheme
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
