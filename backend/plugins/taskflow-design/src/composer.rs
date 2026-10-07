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
  // NOT verifiable under CDP — a limit of the DRIVER, not a claim about Chrome:
  // driven through CDP, `page.mouse.move` delivered no cross-frame pointer-leave
  // in this harness, so this never fires there and the stale box survives in
  // both the broken and the fixed runtime. Verify with a real pointer move
  // (a real Firefox, or by hand); a real pointer move is expected to clear it,
  // and that expectation is the part that was never measured.
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
    // The fields below are hand-copied in
    // `v2_fe/src/pages/design/design-selection.test.ts` (its `CLICKED` fixture),
    // and NOTHING checks the two against each other: a field added, renamed or
    // reordered here leaves that test passing on a premise this message no
    // longer holds. Edit both — the fixture's comment points back here.
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

  // #507 follow-up: the export's font sources (see `design:capture`).
  // `sheets` are stylesheets whose text the chrome must fetch (cross-origin
  // links this document cannot read, and @imports); `faces` are @font-face
  // rules already readable here whose font files are remote.
  const fontSources = () => {
    const sheets = new Set();
    const faces = [];
    const abs = (url, base) => { try { return new URL(url, base).href; } catch (_) { return null; } };
    const walk = (rules, base) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.IMPORT_RULE) {
          const href = abs(rule.href, base);
          if (href) sheets.add(href);
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          faces.push(rule.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g,
            (raw, q, url) => url.startsWith('data:') ? raw : 'url("' + (abs(url, base) || url) + '")'));
        } else if (rule.cssRules) {
          walk(rule.cssRules, base);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (_) { rules = null; }
      if (rules) walk(rules, sheet.href || location.href);
      else if (sheet.href) sheets.add(sheet.href);
    }
    return { sheets: [...sheets].filter((u) => u.startsWith('https:')), faces };
  };
  const fontWaits = new Map();
  const askForFonts = (id) => {
    const { sheets, faces } = fontSources();
    if (!sheets.length && !faces.length) return Promise.resolve('');
    return new Promise((resolve) => {
      fontWaits.set(id, resolve);
      parent.postMessage({ type: 'design:font-sources', id, sheets, faces }, '*');
      setTimeout(() => { if (fontWaits.has(id)) { fontWaits.delete(id); resolve(''); } }, 15000);
    });
  };

  // The export's external images. The capture draws the page as an SVG
  // image, so every <img> and CSS background has to be INLINED as a data:
  // URL — and this document's `connect-src` refuses the fetch (deliberately:
  // see `sandbox_csp`). The library asks `fetchFn` first for every image it
  // needs; for an https url off this origin the runtime asks the chrome,
  // which fetches it through the server (`/api/design/{project}/fetch-asset`)
  // and answers with the data: URL. `false` means "fetch it yourself" — a
  // same-origin asset or a jsdelivr file the policy already allows — and an
  // answer that never comes, or comes as a refusal, leaves the library to
  // its placeholder, which is what an unfetchable image was drawn as before.
  // What an image the export cannot have is drawn AS: a neutral grey card
  // with a picture glyph, sized by the element's own CSS like the image it
  // stands in for. Visible on purpose — the library's own default is a 1×1
  // transparent gif, which reads as a page with a hole in it, and a blank is
  // indistinguishable from a page that never had an image there.
  const IMAGE_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 120' preserveAspectRatio='xMidYMid slice'>" +
    "<rect width='160' height='120' fill='#e5e7eb'/>" +
    "<path d='M46 86l24-30 16 20 10-12 18 22z' fill='#9ca3af'/>" +
    "<circle cx='106' cy='42' r='8' fill='#9ca3af'/></svg>");
  const imageWaits = new Map();
  let imageSeq = 0;
  const fetchViaChrome = (id) => (url) => {
    if (!/^https:\/\//i.test(url) || url.startsWith(location.origin + '/')) return Promise.resolve(false);
    return new Promise((resolve) => {
      const key = id + ':' + (++imageSeq);
      imageWaits.set(key, resolve);
      parent.postMessage({ type: 'design:fetch-image', id, key, url }, '*');
      setTimeout(() => { if (imageWaits.has(key)) { imageWaits.delete(key); resolve(false); } }, 25000);
    });
  };

  // A <video> is pictured as its poster. The library clones a video and
  // waits for it to load; a `preload="none"` video (the poster-first kind a
  // feed shows) never fires `loadeddata` or `error`, so the capture would
  // hang until the chrome gave up on the screen. The swap is temporary and
  // undone after the capture, so the live page keeps its player.
  const swapVideosForPosters = () => {
    const swapped = [];
    for (const video of document.querySelectorAll('video')) {
      const still = document.createElement('img');
      still.alt = '';
      still.src = video.poster || IMAGE_PLACEHOLDER;
      still.className = video.className;
      still.style.cssText = video.style.cssText;
      video.replaceWith(still);
      swapped.push({ still, video });
    }
    return () => { for (const { still, video } of swapped) still.replaceWith(video); };
  };

  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'design:image-data' && imageWaits.has(m.key)) {
      const ok = typeof m.dataUrl === 'string' && m.dataUrl.startsWith('data:');
      imageWaits.get(m.key)(ok ? m.dataUrl : false);
      imageWaits.delete(m.key);
    }
    if (m.type === 'design:mode') { on = !!m.picking;
      document.documentElement.style.cursor = on ? 'crosshair' : '';
      if (!on) clear(); }
    if (m.type === 'design:theme') document.documentElement.dataset.theme = m.theme;
    // #507: the design export. The chrome asks THIS document to picture itself
    // — rendering happens where the page's own fonts, styles and components
    // resolve, which a cross-origin parent could never read. The library comes
    // from jsdelivr, which the sandbox CSP already allows for scripts. The
    // reply echoes the request id so concurrent exports cannot cross.
    //
    // Webfonts are the one thing this document cannot picture on its own. The
    // capture draws the page as an SVG image, and an image loads nothing, so
    // every font must be INLINED — but a cross-origin stylesheet's rules are
    // unreadable here, and the font files are refused by this document's
    // `connect-src` (deliberately tight: see `sandbox_csp`). So the runtime
    // only DISCOVERS its font sources and asks the chrome, which fetches them
    // outside the sandbox and answers with CSS whose fonts are data: URLs.
    // No answer in time means the capture goes ahead with the fonts it has.
    if (m.type === 'design:font-css' && fontWaits.has(m.id)) {
      fontWaits.get(m.id)(typeof m.cssText === 'string' ? m.cssText : '');
      fontWaits.delete(m.id);
    }
    if (m.type === 'design:capture') {
      const id = m.id;
      (async () => {
        try {
          const lib = await import('https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/+esm');
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          const fontCss = await askForFonts(id);
          const root = document.documentElement;
          const width = innerWidth;
          const height = m.fullPage ? Math.max(root.scrollHeight, innerHeight) : innerHeight;
          const bg = getComputedStyle(document.body).backgroundColor;
          const restoreVideos = swapVideosForPosters();
          let dataUrl;
          try {
            dataUrl = await lib.domToPng(root, {
              width, height,
              scale: Math.min(Math.max(Number(m.scale) || 1, 1), 3),
              backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
              fetchFn: fetchViaChrome(id),
              fetch: { placeholderImage: IMAGE_PLACEHOLDER },
              ...(fontCss ? { font: { cssText: fontCss } } : {}),
            });
          } finally {
            restoreVideos();
          }
          parent.postMessage({ type: 'design:captured', id, dataUrl, width, height }, '*');
        } catch (err) {
          parent.postMessage({ type: 'design:captured', id, error: String(err && err.message || err) }, '*');
        }
      })();
    }
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

/// #626: what every composed page declares before Tailwind, the tokens and the
/// page, so `var(--safe-top)` / `calc(0.75rem + var(--safe-bottom))` always
/// resolve. #632: nothing raises them any more — a device frame now starts the
/// page's viewport BELOW its status bar on every surface — so they are 0px
/// everywhere; kept so a page written for #626 still composes unchanged.
pub const SAFE_AREA_DEFAULTS: &str = ":root { --safe-top: 0px; --safe-bottom: 0px; }";

/// #626: the device frame's half of the status-bar protocol, SYSTEM-owned like
/// the picker. (#632: the canvas no longer sends `design:safe-area`; the
/// handler stays harmless, and the report now only colours the frame's strip.) It applies `design:safe-area {top, bottom}` as inline style on
/// `<html>`, sets `color-scheme` from `design:theme`'s `appearance`, and
/// reports what the frame needs to colour its status bar:
/// `design:status-bar {mode, background, padsTop, padsBottom}`.
/// * `mode` — `data-status-bar` on the element at the top centre or an
///   ancestor (`light` = white icons), else null.
/// * `background` — the first solid (alpha >= 0.5) background walking up from
///   that element, normalised to `rgb(r, g, b)` through a 1×1 canvas: Chrome
///   computes oklch tokens as `oklch(...)`, and the chrome accepts rgb only.
/// * `padsTop` / `padsBottom` — whether something at that edge pads by the
///   inset (padding >= inset, or fixed/sticky offset by it). False at 0.
/// Reports are coalesced with a timer: rAF is throttled in off-screen
/// cross-origin frames, which is where lazily mounted boards start.
/// Composed BEFORE the picker: the picker posts `design:ready`, and the
/// canvas answers it with `design:safe-area`, so this listener must already
/// exist when ready goes out.
const STATUS_BAR_RUNTIME: &str = r#"(() => {
  const root = document.documentElement;
  let safeTop = 0, safeBottom = 0, pending = false;
  const clampPx = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 200) : 0;
  };
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  const paint = probe.getContext('2d', { willReadFrequently: true });
  const solidRgb = (colour) => {
    if (!paint || !colour) return null;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = 'rgba(0, 0, 0, 0)';
    paint.fillStyle = colour;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return a >= 128 ? 'rgb(' + r + ', ' + g + ', ' + b + ')' : null;
  };
  const padsEdge = (edge) => {
    const inset = edge === 'top' ? safeTop : safeBottom;
    if (!inset) return false;
    const h = innerHeight, x = Math.floor(innerWidth / 2);
    const ys = edge === 'top' ? [1, inset + 1] : [h - 1, h - inset - 1];
    const seen = new Set();
    for (const y of ys) {
      for (const hit of document.elementsFromPoint(x, y)) {
        for (let el = hit; el && el.nodeType === 1 && !seen.has(el); el = el.parentElement) {
          seen.add(el);
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          const pad = parseFloat(edge === 'top' ? cs.paddingTop : cs.paddingBottom) || 0;
          const atEdge = edge === 'top' ? r.top <= 1 : r.bottom >= h - 1;
          if (atEdge && pad >= inset - 1) return true;
          const pinned = cs.position === 'fixed' || cs.position === 'sticky';
          const offset = parseFloat(edge === 'top' ? cs.top : cs.bottom) || 0;
          const gap = edge === 'top' ? r.top : h - r.bottom;
          if (pinned && Math.abs(gap - inset) <= 1 && offset >= inset - 1) return true;
        }
      }
    }
    return false;
  };
  const measure = () => {
    const top = document.elementFromPoint(Math.floor(innerWidth / 2), 1);
    const marked = top && top.closest ? top.closest('[data-status-bar]') : null;
    const declared = marked ? String(marked.getAttribute('data-status-bar')).toLowerCase() : '';
    const mode = declared === 'light' || declared === 'dark' ? declared : null;
    let background = null;
    for (let el = top || root; el && el.nodeType === 1 && !background; el = el.parentElement) {
      background = solidRgb(getComputedStyle(el).backgroundColor);
    }
    if (!background) background = solidRgb(getComputedStyle(root).backgroundColor);
    return { mode, background, padsTop: padsEdge('top'), padsBottom: padsEdge('bottom') };
  };
  const report = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try {
        const m = measure();
        parent.postMessage({ type: 'design:status-bar', mode: m.mode, background: m.background,
          padsTop: m.padsTop, padsBottom: m.padsBottom }, '*');
      } catch (_) {}
    }, 0);
  };
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'design:safe-area') {
      safeTop = clampPx(m.top);
      safeBottom = clampPx(m.bottom);
      root.style.setProperty('--safe-top', safeTop + 'px');
      root.style.setProperty('--safe-bottom', safeBottom + 'px');
      report();
    }
    if (m.type === 'design:theme') {
      root.style.colorScheme = m.appearance === 'light' || m.appearance === 'dark' ? m.appearance : '';
      report();
    }
  });
  // #632: the same measure, for the renderer (design-render.mjs evaluates it
  // in-page before it dresses a device frame), plus what the canvas and the
  // export know from the manifest: the active theme's appearance (from
  // `__tfAppearances`, composed by the server per page) and its
  // `--background`, normalised to rgb() like the top colour.
  window.__tfStatusBar = () => {
    const m = measure();
    const map = window.__tfAppearances || {};
    const a = Object.prototype.hasOwnProperty.call(map, root.dataset.theme || 'light') ? map[root.dataset.theme || 'light'] : null;
    return { mode: m.mode, background: m.background,
      appearance: a === 'light' || a === 'dark' ? a : null,
      themeBackground: solidRgb(getComputedStyle(root).getPropertyValue('--background').trim()) };
  };
  addEventListener('load', report);
  addEventListener('resize', report);
})();"#;

/// The status runtime, escaped for an inline `<script>` (see [`STATUS_BAR_RUNTIME`]).
pub fn status_bar_script() -> String {
    escape_for_inline_script(STATUS_BAR_RUNTIME)
}

/// #632: `window.__tfAppearances = {"light":"light","ocean":"dark",…};` — each
/// declared theme's appearance (null = automatic), which the status runtime's
/// `__tfStatusBar` reads for the theme the page is in. The renderer has only
/// the theme's NAME (`?theme=`); this is how its device frame inks the status
/// bar by the same rule the canvas and the export use.
pub fn theme_appearances_script(themes: &[crate::manifest::ThemeInfo]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = themes
        .iter()
        .map(|t| {
            let a = t.appearance.as_deref().filter(|a| *a == "light" || *a == "dark");
            (t.name.clone(), a.map_or(serde_json::Value::Null, |a| serde_json::Value::String(a.into())))
        })
        .collect();
    let json = serde_json::Value::Object(map).to_string();
    escape_for_inline_script(&format!("window.__tfAppearances = {json};"))
}

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
/// It SCANS the tag rather than parsing it, which is all one attribute question
/// needs: the rules for what counts as a name — a token boundary before it, a
/// quoted value skipped whole, an unquoted one running to whitespace — are
/// written out below, each because some real markup made it necessary.
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
        // The NAME has to be a whole token, so the byte before it rules it out
        // when it could have been part of a longer name (`data-target=`,
        // `x-target=`) — and `=` rules it out for a different reason: an UNQUOTED
        // value runs to the next whitespace, `>` or quote, so the text of one can
        // contain `target=_blank` (`data-x=target=_blank`). Reading that as the
        // attribute left the href alone, and the link then 404s on the sandbox
        // origin. Whitespace and a quote stay legal predecessors, because they
        // are what separates a real `target` from the attribute before it
        // (`href="x"target="_blank"`).
        if !b[i..].starts_with(b"target")
            || (i > 0
                && (b[i - 1].is_ascii_alphanumeric()
                    || matches!(b[i - 1], b'-' | b'_' | b':' | b'=')))
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
/// A mechanism, not a guarantee, and the same condition the agent-facing guide
/// states (`AUTHORING_GUIDE`, `agent_views.rs`): the history is built by clicks
/// INSIDE the frame, so a frame opened directly at a route has a single entry
/// and `back()` there is inert until one of these rewrites is followed. Two
/// documents describing one behaviour is how they come to disagree, so this one
/// says what the guide says.
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
///     byte-identical. ONE leading `./` is stripped, and only on the root page:
///     `./app` resolves to `/s/app` against the same bare base — the same dead
///     link `app` gives — so it is handed to the route match like any other
///     relative and rewritten when it names one. `../` is the different job
///     this deliberately does not do: it always resolves OUTSIDE the namespace
///     (`../app` is `/app` from the root and `/s/app` from a child page), so
///     handling it means resolving dot segments against the base's depth, where
///     one `..` is not one strip — and a guess there is a rewrite that is wrong.
///     `.//app` is left alone too: it resolves to `/s//app`, not `/s/app`;
///   * the walk is TEXTUAL — it looks for `href="` in the fragment — so
///     href-shaped text is rewritten wherever it appears, inside a `<script>`
///     body or an HTML comment included. A site-absolute `/app` written there
///     has been rewritten since this pass existed; what the root arm above
///     newly reaches is a RELATIVE one (`<script>const s = 'href="app"'</script>`
///     composes to `href="/s/{token}/app"` inside the JS string). It is noted
///     rather than fixed: a page that does not spell an href in a script or a
///     comment cannot tell the difference, and telling the two apart means
///     parsing the fragment instead of scanning it;
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
            //
            // One leading `./` goes first, and it is a strip rather than a
            // resolution: `./app` and `app` are the SAME resolution against this
            // base (`/s/app`, a 404), so the two are given the same treatment.
            // Only when what follows is a plain path — not empty, and not
            // starting with `/` or another `.` — because `.//app` resolves to
            // `/s//app` and `./../app` to `/app`, and neither is what a strip
            // would produce.
            let bare = match route_path.strip_prefix("./") {
                Some(rest) if !rest.is_empty() && !rest.starts_with(['/', '.']) => rest,
                _ => route_path,
            };
            let resolved = format!("/{bare}");
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

/// The runtime navigation guard every served sandbox page carries (#625).
///
/// [`rewrite_hrefs`] keeps `href="/route"` inside `/s/{token}` — but only for
/// links IN the page fragment at compose time. A link a component renders at
/// runtime (a tab bar building `<a href="/together">` in JS), or a link to a
/// route with no page, reached the browser unrewritten, resolved against the
/// API host's root, 404'd, and the frame showed X-Frame-Options' "refused to
/// connect". This listener catches a same-origin link click that would leave
/// the sandbox: a known route navigates inside it, anything else stays put with
/// an in-frame notice and a `design:missing-route` message to the chrome.
///
/// It is added AFTER the picker runtime, whose click handler swallows clicks
/// while picking (`stopImmediatePropagation`), and it reads the anchor through
/// `composedPath()` so links inside a component's shadow root are seen too.
pub fn nav_guard_script(token: &str, routes: &[String]) -> String {
    let base = serde_json::to_string(&format!("/s/{token}")).unwrap_or_else(|_| "\"\"".into());
    let routes = serde_json::to_string(routes).unwrap_or_else(|_| "[]".into());
    let js = format!(
        r#"(() => {{
  const BASE = {base}, ROUTES = {routes};
  const norm = (p) => (p === '/' ? p : p.replace(/\/+$/, '') || '/');
  const notice = (msg) => {{
    let t = document.getElementById('__tf_nav_notice');
    if (!t) {{
      t = document.createElement('div');
      t.id = '__tf_nav_notice';
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;max-width:90%;padding:8px 12px;border-radius:8px;background:rgba(17,17,17,.9);color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none';
      document.documentElement.appendChild(t);
    }}
    t.textContent = msg;
    clearTimeout(t.__h);
    t.__h = setTimeout(() => t.remove(), 3000);
  }};
  addEventListener('click', (e) => {{
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const a = path.find((n) => n instanceof Element && n.localName === 'a' && n.hasAttribute('href'));
    if (!a) return;
    const target = (a.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self') return;
    let url;
    try {{ url = new URL(a.getAttribute('href'), location.href); }} catch (_) {{ return; }}
    if (url.origin !== location.origin) return;
    if (url.pathname === BASE || url.pathname.startsWith(BASE + '/')) return;
    e.preventDefault();
    const route = norm(url.pathname);
    if (ROUTES.includes(route)) {{
      location.assign((route === '/' ? BASE : BASE + route) + url.search + url.hash);
      return;
    }}
    parent.postMessage({{ type: 'design:missing-route', path: route }}, '*');
    notice('No ' + route + ' page in this design yet');
  }});
}})();"#
    );
    escape_for_inline_script(&js)
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

/// The version of the design file at `path`, or `None` when the project has no
/// such row.
///
/// Every sandbox subresource URL carries one of these as `?v=`, so a URL names
/// the exact revision it serves. That is what lets `serve_file` mark the
/// response cacheable without ever handing a stale edit back: a changed file
/// changes its own version, which changes its URL, which is a miss. A coarse
/// key (the manifest's global revision) would be correct but would throw away
/// every component's cache entry on any page edit — the common case in a
/// design session — which is why the per-file version is what travels.
fn rev_of(versions: &[(String, i64)], path: &str) -> Option<i64> {
    versions
        .iter()
        .find(|(p, _)| p == path)
        .map(|(_, v)| *v)
}

/// Compose the full document for one route.
///
/// * `token`     — the sandbox read token for this project
/// * `manifest`  — the current derived manifest
/// * `route`     — `/`, `/settings`, …
/// * `page_path` — `pages/settings.html` (must map back to `route`)
/// * `fragment`  — the raw body fragment
/// * `versions`  — `(design-file path, version)` for the project's rows. Used
///   only to stamp each subresource URL with the revision it serves; an empty
///   slice is valid and falls back to the manifest revision.
/// * `state`     — optional overlay state (`dialog:confirm-delete`) the
///   composer wires to open on load so screenshot review can reach UI that
///   only exists after a click.
pub fn compose_document(
    token: &str,
    manifest: &DesignManifest,
    route: &str,
    page_path: &str,
    fragment: &str,
    versions: &[(String, i64)],
    theme: &str,
    state: Option<&str>,
) -> String {
    // #619: callers only pass a validated theme slug, but it lands in an HTML
    // attribute, so escape it anyway (defence in depth).
    let theme = esc(theme);
    // The route list the pages were built from — the only paths a link inside
    // the frame can navigate to. Computed once, here, and passed down.
    let routes: Vec<String> = manifest.routes.iter().map(|r| r.path.clone()).collect();
    let nav_guard = nav_guard_script(token, &routes);
    let status_runtime = format!("{}\n{}", theme_appearances_script(&manifest.themes), status_bar_script());
    // `route` is not only for diagnostics: which page this IS decides how a
    // RELATIVE href resolves (see [`rewrite_hrefs`]), because the root frame's
    // document URL has no trailing slash.
    let annotated = compose_body_fragment(token, route, page_path, fragment, &routes);

    // The project's external resources (a webfont and its companion links) land
    // in the head before the page's own stylesheet, so a page can override a
    // webfont. Empty — and so invisible — for a project that has none.
    let resources = resources_tags(&manifest.resources);
    let bridge = escape_for_inline_style(&manifest.tokens_bridge);

    // `tokens.css` is GENERATED from the stored tokens (the json row, else the
    // legacy css row imported) plus the built-in defaults, so its
    // revision is whichever of the two backs it — the same precedence
    // `views::effective_tokens_css` resolves on the serve side.
    let tokens_rev = rev_of(versions, "styles/tokens.json")
        .or_else(|| rev_of(versions, "styles/tokens.css"))
        .unwrap_or(manifest.revision);

    let mut component_tags = String::new();
    for c in &manifest.components {
        let v = rev_of(versions, &format!("components/{}.js", c.name)).unwrap_or(manifest.revision);
        component_tags.push_str(&format!(
            "<script src=\"/s/{token}/f/components/{}.js?v={v}\"></script>\n",
            esc(&c.name)
        ));
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
            if (kind == "dialog" || kind == "overlay") && !css_ident(name).is_empty() {
                // Components often build their overlay AFTER DOMContentLoaded
                // (a bottom sheet moves its children into a <dialog> it creates
                // in its own DOMContentLoaded handler, registered after this
                // one), so the lookup retries across frames for up to 2s. The
                // outcome is published as `window.__tfState` /
                // `__tfStateReady` so a screenshot can say when nothing
                // matched instead of silently showing the closed page.
                format!(
                    r#"<script>
window.__tfStateReady = new Promise((settle) => {{
  const want = {state_json};
  const find = () => {{
    try {{ return document.querySelector('[data-state="{name}"], dialog[name="{name}"], #{name}'); }}
    catch (_) {{ return document.querySelector('[data-state="{name}"], dialog[name="{name}"]'); }}
  }};
  const open = (el) => {{
    if (el instanceof HTMLDialogElement) {{ try {{ if (!el.open) el.showModal(); }} catch (_) {{}} }}
    else {{ el.removeAttribute('hidden'); el.setAttribute('open', ''); }}
  }};
  const start = () => {{
    const t0 = performance.now();
    const attempt = () => {{
      const el = find();
      if (el) {{ open(el); window.__tfState = {{ state: want, matched: true }}; return settle(window.__tfState); }}
      if (performance.now() - t0 > 2000) {{ window.__tfState = {{ state: want, matched: false }}; return settle(window.__tfState); }}
      requestAnimationFrame(attempt);
    }};
    attempt();
  }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0), {{ once: true }});
  else start();
}});
</script>"#,
                    state_json = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()).replace('<', "\\u003c"),
                    name = css_ident(name),
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
  <style>{SAFE_AREA_DEFAULTS}</style>
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
  <style type="text/tailwindcss">{bridge}</style>
  {resources}<link rel="stylesheet" href="/s/{token}/f/styles/tokens.css?v={tokens_rev}">
  {component_tags}<script>{status_runtime}</script>
  <script>{PICKER_RUNTIME}</script>
  <script>{nav_guard}</script>
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
    bridge: &str,
    components: &[(String, String)],
    resources: &[(bool, ResourceLink)],
) -> String {
    let _ = page_path;
    // #619: defence in depth — the theme lands in an HTML attribute.
    let theme = esc(theme);
    let body = compose_export_body(fragment);

    let mut component_scripts = String::new();
    for (_name, js) in components {
        component_scripts.push_str("<script>");
        component_scripts.push_str(&escape_for_inline_script(js));
        component_scripts.push_str("</script>\n");
    }

    let safe_tokens_css = escape_for_inline_style(tokens_css);
    let safe_bridge = escape_for_inline_style(bridge);
    let resource_tags = resources_tags(resources);

    format!(
        r#"<!doctype html>
<html lang="en" data-theme="{theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>{SAFE_AREA_DEFAULTS}</style>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style type="text/tailwindcss">{safe_bridge}</style>
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
/// widen it: a Lottie player `fetch()`es its animation JSON, and that fetch is
/// what lands under `connect-src`.
///
/// The validator's `<script src` marker is NOT a second blocker, though a pair
/// of them used to be written here as two. It is a SHELL-OWNERSHIP rule — a page
/// fragment may not claim the document's own `<script>`, `<head>` or `<body>`
/// slots, which the server composes — and its literal-substring form is a PROXY
/// for that rule, not a bound on what a page can load: one extra attribute
/// defeats the proxy, because `<script type="module" src="https://…">` passes
/// validation (pinned in `phase1_storage_composer.rs`) and then loads under the
/// `https:` scheme source below. What refuses that load, if anything does, is
/// this policy rather than the validator.
///
/// Lottie is deliverable anyway WITHOUT touching this directive —
/// the player wiring belongs in a COMPONENT, which the sandbox loads as a
/// SAME-ORIGIN script: `compose_document` emits
/// `<script src="/s/{token}/f/components/{name}.js?v={revision}">` per
/// registered component, and `script-src 'self'` permits it — a query string
/// does not change an origin. The player `<script src="https://…">`
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
/// The widening is bounded by two things together, and each is load-bearing.
/// The sandbox is a separate origin with no cookies behind a short-lived
/// read-only token, so a page that misbehaves with what it loads reaches
/// nothing of the operator's beyond the project it is already rendering. And
/// every value in play is written by the project's own members through the
/// normal write path — the manifest's links, and the urls a page writes into its
/// own markup for an image or a video, alike — with the scheme as the bound on
/// them: `resources::validate` refuses any manifest url that is not `https:`, so
/// `javascript:` and a `data:` document can never reach an emitted attribute in
/// the first place, while a url written straight into page markup is not
/// scheme-checked by anything — for those, the scheme source named here is the
/// only thing refusing plain `http:`.
///
/// The validator is NOT a third bound, which is the mistake this paragraph used
/// to make. Its one rule about script markup is the shell-ownership proxy above,
/// and a proxy is not a bound: the marker is the literal substring
/// `<script src`, so `<script type="module" src="https://…">` passes it — and so
/// does an inline `<script>` that appends one at runtime, which `'unsafe-inline'`
/// plus the `https:` scheme source permit. What bounds the loading is this
/// policy, applied by the browser to whatever the document ends up with, static
/// or appended.
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

/// A state name usable inside a CSS selector (`[data-state="…"]`, `#…`):
/// only letters, digits, `-` and `_` survive, so a crafted `?state=` cannot
/// break out of the selector or the script around it.
fn css_ident(name: &str) -> String {
    name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_theme_attribute_is_html_escaped() {
        let html = compose_export_document("pages/x.html", "<p>x</p>", "x\"><script>alert(1)</script>", "", "", &[], &[]);
        assert!(html.contains(r#"data-theme="x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;""#), "{html}");
        assert!(!html.contains("<script>alert(1)"));
    }

    #[test]
    fn the_sandbox_document_escapes_the_theme_attribute() {
        let manifest = crate::manifest::DesignManifest {
            project: 1,
            routes: vec![],
            components: vec![],
            tokens: vec![],
            revision: 1,
            resources: vec![],
            tokens_bridge: String::new(),
            themes: vec![],
        };
        let html = compose_document("tok", &manifest, "/", "pages/index.html", "<p>x</p>", &[], "a\"b", None);
        assert!(html.contains(r#"data-theme="a&quot;b""#), "theme not escaped");
    }

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
    fn the_page_runtime_answers_an_export_capture() {
        // #507: the chrome's exporter posts `design:capture` and waits for a
        // `design:captured` carrying the same id. Pinned so a runtime edit
        // cannot silently drop the export's only way to picture a page.
        assert!(PICKER_RUNTIME.contains("m.type === 'design:capture'"));
        assert!(PICKER_RUNTIME.contains("type: 'design:captured', id, dataUrl"));
        // The export's fonts: the runtime asks the chrome for its font
        // sources and captures with the CSS it gets back, because this
        // document's `connect-src` cannot fetch a remote font itself.
        assert!(PICKER_RUNTIME.contains("type: 'design:font-sources', id, sheets, faces"));
        assert!(PICKER_RUNTIME.contains("m.type === 'design:font-css'"));
        assert!(PICKER_RUNTIME.contains("font: { cssText: fontCss }"));
        assert!(PICKER_RUNTIME.contains("cdn.jsdelivr.net/npm/modern-screenshot@"));
        // The export's external images: the runtime hands every https image
        // fetch to the chrome (which fetches through the server), because
        // this document's `connect-src` refuses it and the capture would
        // otherwise draw a placeholder.
        assert!(PICKER_RUNTIME.contains("type: 'design:fetch-image', id, key, url"));
        assert!(PICKER_RUNTIME.contains("m.type === 'design:image-data'"));
        assert!(PICKER_RUNTIME.contains("fetchFn: fetchViaChrome(id)"));
        // ...and an image it still cannot have is drawn as a VISIBLE
        // placeholder card, never the library's invisible 1×1 default.
        assert!(PICKER_RUNTIME.contains("fetch: { placeholderImage: IMAGE_PLACEHOLDER }"));
        assert!(PICKER_RUNTIME.contains("data:image/svg+xml;charset=utf-8,"));
        // A `<video>` is pictured as its poster. The library waits on a video
        // it clones to load, and one with `preload=\"none\"` never does — the
        // capture would hang until the chrome's timeout and the screen would
        // be lost.
        assert!(PICKER_RUNTIME.contains("querySelectorAll('video')"));
        assert!(PICKER_RUNTIME.contains("still.replaceWith(video)"));
        assert!(PICKER_RUNTIME.contains("still.src = video.poster || IMAGE_PLACEHOLDER"));
        assert!(!PICKER_RUNTIME.to_ascii_lowercase().contains("</script"));
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
            "@theme inline { --color-accent: var(--accent); }",
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

    fn empty_manifest() -> crate::manifest::DesignManifest {
        crate::manifest::DesignManifest {
            project: 1,
            routes: vec![],
            components: vec![],
            tokens: vec![],
            revision: 1,
            resources: vec![],
            tokens_bridge: String::new(),
            themes: vec![],
        }
    }

    #[test]
    fn every_composed_page_declares_zero_safe_areas_before_the_tokens() {
        let html = compose_document("tok", &empty_manifest(), "/", "pages/index.html", "<p>x</p>", &[], "light", None);
        let defaults = html.find(SAFE_AREA_DEFAULTS).expect("the defaults are declared");
        assert!(defaults < html.find("@tailwindcss/browser").expect("tailwind"), "before Tailwind");
        assert!(defaults < html.find("/f/styles/tokens.css").expect("tokens"), "before the tokens");
        assert!(html.contains("type: 'design:status-bar'"), "the sandbox page carries the status runtime");
        let status = html.find("type: 'design:status-bar'").expect("status runtime");
        let ready = html.find("type: 'design:ready'").expect("the picker posts ready");
        assert!(status < ready, "the status runtime listens before the picker posts design:ready");
        let export = compose_export_document("pages/index.html", "<p>x</p>", "light", ":root{}", "", &[], &[]);
        let defaults = export.find(SAFE_AREA_DEFAULTS).expect("the export declares them too");
        assert!(defaults < export.find("<style>:root{}</style>").expect("inlined tokens"));
        assert!(!export.contains("design:status-bar"), "an export carries no runtime");
    }

    #[test]
    fn the_status_bar_runtime_applies_safe_areas_and_reports_back() {
        let js = status_bar_script();
        // In: the device's insets, clamped, as inline style on <html>.
        assert!(js.contains("m.type === 'design:safe-area'"));
        assert!(js.contains("Math.min(Math.max(Math.round(n), 0), 200)"));
        assert!(js.contains("root.style.setProperty('--safe-top', safeTop + 'px')"));
        assert!(js.contains("root.style.setProperty('--safe-bottom', safeBottom + 'px')"));
        // In: the theme's appearance drives color-scheme; anything else clears it.
        assert!(js.contains("m.type === 'design:theme'"));
        assert!(js.contains("root.style.colorScheme = m.appearance === 'light' || m.appearance === 'dark' ? m.appearance : ''"));
        // Out: the report, and when it is sent.
        assert!(js.contains("type: 'design:status-bar'"));
        assert!(js.contains("closest('[data-status-bar]')"));
        assert!(js.contains("getImageData(0, 0, 1, 1)"), "backgrounds are normalised to rgb() through a canvas");
        assert!(js.contains("addEventListener('load', report)"));
        assert!(js.contains("addEventListener('resize', report)"));
        assert!(js.contains("setTimeout("), "coalesced with a timer, not rAF (throttled off-screen)");
        assert!(!js.contains("requestAnimationFrame"));
        assert!(!js.to_ascii_lowercase().contains("</script"));
        // #632: the renderer's in-page read of the same measure.
        assert!(js.contains("window.__tfStatusBar = () =>"));
        assert!(js.contains("getPropertyValue('--background')"));
    }

    #[test]
    fn composed_pages_carry_each_themes_appearance_for_the_renderer() {
        use crate::manifest::{ThemeInfo, ThemeSwatch};
        let info = |name: &str, appearance: Option<&str>| ThemeInfo {
            name: name.into(),
            label: name.into(),
            appearance: appearance.map(str::to_string),
            swatch: ThemeSwatch { primary: None, background: None },
        };
        let themes = vec![info("light", Some("light")), info("ocean-dark", Some("dark")), info("auto", None), info("odd", Some("dim"))];
        let js = theme_appearances_script(&themes);
        assert_eq!(
            js,
            r#"window.__tfAppearances = {"auto":null,"light":"light","ocean-dark":"dark","odd":null};"#
        );
        let mut manifest = empty_manifest();
        manifest.themes = themes;
        let html = compose_document("tok", &manifest, "/", "pages/index.html", "<p>x</p>", &[], "ocean-dark", None);
        let map = html.find("window.__tfAppearances = ").expect("the appearance map is composed");
        assert!(map < html.find("window.__tfStatusBar").expect("runtime"), "declared before the runtime reads it");
    }
}
