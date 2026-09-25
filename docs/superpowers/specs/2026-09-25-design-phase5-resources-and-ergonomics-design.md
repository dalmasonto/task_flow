# Design page Phase 5 — external resource sets + canvas ergonomics

**Date:** 2026-09-25
**Status:** Awaiting review
**Depends on:** Phases 1–4. Phase 4 is complete to 13 of 14 tasks (its final publish step is deliberately held — see "Publish order" below).

## Problem

Six items the user raised while Phase 4 was executing. One of them (item 4) is already fixed and shipped in Phase 4; the rest are new.

| # | Item | Class |
|---|---|---|
| 1 | Rename pages from the UI | New, small |
| 2 | The per-device actions are dead placeholders — make them work | New, medium |
| 3 | A page unloads when scrolled out of view and reloads on return | New, small |
| 4 | Page-content edits don't reach the canvas live | **FIXED in Phase 4** (commit `b855a4d`) |
| 5 | After the Pan tool, returning to Select leaves the page frozen until clicked | **Bug — root cause NOT found** |
| 6 | User-managed external resource sets (fonts + companion links) per project | New, architectural |
| 7 | Navigating **between pages inside one device frame** — links, and back/forward | New, medium |

## Goals

1. **Rename pages** — a display label per page, project-shared.
2. **Per-device actions work** — `rotate`, `duplicate at another device`, `open in new tab`, `reload`, `remove` are real.
3. **Frames stay loaded once seen** — no reload when a page scrolls back into view.
4. *(done)*
5. **Find and fix the scroll-freeze**, by reproduction first.
6. **Resource sets** — named, toggleable groups of external links (fonts and their companion preconnects/JS), per project, applied to every composed page and to the exported `page.html`.

## Non-goals

No change to the arrangement document's shape, the token pipeline, the chat rail, or the component registry. No font *hosting* — only linking. No per-link scheduling/ordering UI beyond set order. §F does not add canvas-level back/forward buttons (the frame's own history is what an agent's page element drives) and does not turn a navigated view into a new board.

## Key decisions (from the user)

1. **Rename = a display label**, not the page's real title. It rides in the shared arrangement document; the page and the real app are untouched.
2. **`remove` removes the page everywhere** from the arrangement — same effect as the existing close control, one meaning, no per-device visibility concept.
3. **Frames stay live once seen.** The user's reason is the deciding one: they compare pages against each other, so a page vanishing mid-comparison defeats the purpose. Memory grows with pages actually scrolled past, and that is accepted.
4. **Resource links are named, toggleable sets**, several of which can be active at once — so a font can be kept around without affecting every page.
5. **Link security: any https origin; dangerous schemes refused.** `https:` works everywhere; non-https is refused; `javascript:`/`data:` are never loaded as scripts.

## The one genuine finding this spec is built on — the CSP

`composer.rs:409-426` carries the sandbox's Content-Security-Policy, and it is **origin-allowlisted to jsDelivr**:

```
script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
style-src  'self' 'unsafe-inline' https://cdn.jsdelivr.net;
font-src   'self' data: https://cdn.jsdelivr.net;
```

The comment beside it records the scar: *"Before this, `style-src 'self'` silently refused every external webfont — the `<link>` stayed in the DOM, the browser dropped the request, and the page fell back."*

**So Google Fonts does not work today, and no UI can fix that.** Item 6 is fundamentally a CSP change, with a storage format and a UI around it. That is why this item is architectural while it looks like a widget.

## Architecture

### §A — Page labels (item 1)

`LayoutDoc` gains `pageLabels: Record<string, string>` — route → display label. It is part of the shared arrangement, so it travels with the layout document and needs **no new storage or endpoints**.

- **Write path:** the existing `PUT /api/design/{project}/layout`. `validate` must reject a label that is empty after trimming or over a length cap (mirroring the group-name rule: 1–40), and must drop labels for routes not in the manifest — same strict-write/forgiving-read asymmetry already established in `layout_doc.rs`.
- **Read path:** `filter_to_known` also drops labels whose route has vanished.
- **Render:** three places show a page name — `PagesPanel` rows, `ArtboardHeader`, and the `rowHeaders` overlay. All three resolve `pageLabels[route] ?? manifest.title ?? route`.
- **Edit:** inline rename in `PagesPanel` (the panel already owns per-row controls; the group picker sits there).

Explicitly **not** done: renaming the page's actual `<title>`. That is a page-content write, shared with the real app, and the user chose the label.

### §B — The per-device actions (item 2)

Five actions become real, in the ⋯ menu `ArtboardHeader` already has (`design-canvas.tsx`). Each needs its canvas-level effect defined, and only one needs new state:

| Action | Behaviour |
|---|---|
| **Reload** | Remount just this board's iframe. Needs a per-board epoch: `contentEpoch` today is global, so reloading one board must not reload all of them — a `Map<boardKey, number>` of local bumps layered on the global epoch. |
| **Open in new tab** | `window.open(sandboxUrl(sandboxToken, route))`. No state. |
| **Duplicate at another device** | Add this route at a chosen device. Needs a device submenu; the effect is `deviceIds` gaining that device, so the route then renders in the new column/band. |
| **Rotate** | Render this board at its device's swapped dimensions. **Ruling, because the hard constraint collides with it:** the iframe must stay at true CSS px, so rotating *is* changing the width — which moves the page's breakpoint. Rather than pretend otherwise, a rotated board is a **distinct derived board**, keyed `${route}@${deviceId}:landscape`, with its own header showing that it is rotated, so the breakpoint change is visible rather than silent. Offered for **phone and tablet groups only**; rotating a laptop or a breakpoint is meaningless (a 1280×800 laptop is not a portrait device, and a Tailwind breakpoint is a width, not a device). Override this if you want rotate everywhere. |
| **Remove** | Close the route from the arrangement (`closeRoute`), as decided. |

### §C — Frames stay loaded (item 3)

`LazyFrame`'s `IntersectionObserver` currently sets `near` both ways (`setNear(entry.isIntersecting)`), so leaving ~1.5 viewports unmounts the iframe and shows `PlaceholderSkeleton`. The fix is to **latch**: mount on first intersection, never unmount.

- `setNear(true)` is the only transition; the false branch is removed.
- The placeholder then appears only for frames never yet seen — still lazy on first paint, which is what keeps a large canvas from mounting a dozen documents at once.
- This makes the earlier "zoom pixelation" report more likely to reproduce (more live frames), so item 5's reproduction should be run **after** this change, not before.

### §D — The scroll freeze (item 5)

**No root cause yet, and this spec does not propose a fix.** What is known:

- The user can highlight text inside a page, so the frame **is** receiving pointer events — the `panMode` → `pointer-events: none` latch theory was raised and **falsified** by that answer.
- The canvas still pans when the wheel is over the background, so the surface's wheel handler is behaving as designed.
- What remains: the frame receives clicks but its own document does not scroll on the wheel until it has been clicked into.

**This item is a SPIKE, not a planned task.** Its output is an answer, not code: reproduce it, then come back with the cause and a proposed fix for a separate decision. It gets no task in the plan and no fix is written under this spec. The reason is that its only two considered theories have already been tested against the evidence and one was falsified — speculating further would be guessing, and a guessed fix here would be indistinguishable from a real one until you used it.

**Method:** reproduce on the local stack (Phase 4's Task 14 sets one up), with a page whose content overflows its frame, and observe whether the wheel event reaches the frame's document at all. Candidate directions to test in order: wheel delivery to a never-focused out-of-process iframe; the composed shell's own overflow/scrollbar CSS (§E's resources change touches this area, so re-check it after); and interaction with the latched frames from §C. **Do not propose a fix before the reproduction identifies which.**

### §E — Resource sets (item 6)

**Storage: `styles/resources.json`, a `DesignFile` row.** This reuses the entire existing pipeline rather than inventing one — versioning, the write validator, the operator `PUT /file` endpoint, the agent write path, and the manifest. It is the same shape as `styles/tokens.json`, which the `TokenEditor` already reads and writes. `for_path` maps `styles/` to `DesignFileKind::Token`, so no enum change and no migration.

```json
{ "version": 1,
  "sets": [
    { "id": "set_gfonts_inter", "name": "Inter (Google Fonts)", "enabled": true,
      "links": [
        { "rel": "preconnect", "href": "https://fonts.googleapis.com" },
        { "rel": "preconnect", "href": "https://fonts.gstatic.com", "crossorigin": true },
        { "rel": "stylesheet", "href": "https://fonts.googleapis.com/css2?family=Inter:...&display=swap" }
      ] },
    { "id": "set_gtm", "name": "Analytics snippet", "enabled": false,
      "links": [ { "type": "script", "src": "https://example.com/lib.js", "async": true } ] }
  ] }
```

- A link is either a `link` (rel + href, optional `crossorigin`) or a `script` (src + optional async/defer). The two shapes cover the user's Google Fonts triple and a companion JS file.
- **Validation, strict on write:** `https:` only; `javascript:`/`data:` refused for both shapes; `rel` restricted to a named allowlist — `preconnect`, `dns-prefetch`, `stylesheet` — since those are what font loading needs and each is inert (none of them executes or mutates the document); set names unique and length-capped; a cap on sets and on links per set. Refusals name the offending URL.

> **Correction (2026-09-25, from Task 7's review).** The allowlist here originally also carried `preload`, and this spec's own justification for the list — *"each is inert"* — is what hides why that was wrong. `preload` is inert in the sense that it **does nothing at all**: per HTML, a preload without an `as` attribute does not fetch, and `ResourceLink` has no `as` field. So the entry produced a `<link>` that sat in the DOM fetching nothing, which is the same shape as the CSP bug this feature exists to fix, recorded in the composer's own comment (*"the `<link>` stayed in the DOM, the browser dropped the request, and the page fell back with nothing visible in the page to say so"*). Rather than ship a second instance of that in the feature that removes the first, `preload` is out. Re-adding it means adding `as` to the model, not just the name back to the list. The user's actual case — the Google Fonts triple of two `preconnect`s and a `stylesheet` — is unaffected.
>
> The lesson worth keeping beyond this entry: "inert" is not one property. A `rel` that cannot execute is safe; a `rel` that cannot do its job is a silent no-op, and silent no-ops are what this phase is for.
- **Composition:** `composer.rs` emits the enabled sets' tags into the shell `<head>`, in set order, **before** the page's own stylesheet so a page can override. The same emission feeds the `page.html` export, so a downloaded page carries its fonts.
- **CSP:** widen the sandbox policy to `script-src`/`style-src`/`font-src` gaining `https:` (scheme source) alongside the existing jsDelivr entries. Rationale to record in the code: the sandbox is a **separate origin with no cookies**, its token is short-lived and read-only for one project's design pages, and the links are supplied by the project's own members — so the marginal capability is bounded, while `javascript:`/`data:` stay refused.
- **UI:** a section in the existing **Tokens** tab (the project-look surface), not a new tab: list sets, toggle each, edit a set's links, add from a pasted block. A "paste Google Fonts `<link>` tags" affordance is worth having — the user's own example is three tags, and parsing them is the difference between a five-second action and a fiddly one.

### §F — Navigating inside a device (item 7)

**The problem is narrower than it looks.** Every frame already loads through a sandbox URL of the form `/s/{token}{route}`, so the renderer can already serve any page at any route.

> **Correction (2026-09-25, found while executing Task 10).** The text here originally read: *"What fails is that a plain `<a href="/app">` inside a frame resolves against the **sandbox origin**, producing `{sandbox}/app` — not a valid sandbox URL. So a page's own links go nowhere."* **That is false, and has been since an earlier phase.** `compose_body_fragment` (`composer.rs:212-216`) already runs `rewrite_hrefs(fragment, "/s/{token}")` over every page body, and its doc comment says as much — so `<a href="/app">` already becomes `/s/{token}/app`, the click is already a real navigation, and the frame already has the session history that makes `history.back()` work. The mechanism this section describes as missing already exists.
>
> What Task 10 actually fixes are the three defects that pass does have: it rewrites **any** path-shaped href (so `/not-a-page` becomes a 404 wearing a plausible URL), it **breaks `mailto:` and `tel:`** by pushing them down its relative branch, and it ignores `target="_blank"`. Because the pass already handles route-shaped hrefs, a newly added parallel pass would have been dead code whose tests passed while the served page was unchanged — so Task 10 extends `rewrite_hrefs` in place and tests through `compose_body_fragment`, the function the server calls.
>
> The export keeps its current behaviour: `compose_export_body` deliberately does not rewrite hrefs (*"a portable export must carry no sandbox-only cruft"*), and rewriting there would stamp the short-lived sandbox token into a file the user downloads and may share.

**The fix is a compose-time rewrite**, and the precedent already exists: `composer.rs` has a `rewrite_hrefs` pass doing exactly this kind of rewriting for styles, components and assets. Extend it so an href naming a **known route** becomes the sandbox URL for that route.

**Back and forward then come free, which is the whole point.** That rewrite turns the click into a real navigation *inside the frame*, and an iframe has its own session history — so the browser's back/forward work and an agent-written `history.back()` simply functions. No new machinery, no interception runtime. This is why the user's own guess ("enabling back and forward navigation in the render devices") was right.

Rules, because a blanket rewrite would break pages:

- Rewrite only hrefs that **match a route in the manifest**. A path-shaped href that is not a page is left alone — rewriting it would turn a dead link into a differently-dead one.
- Leave `http(s)://`, protocol-relative `//`, `mailto:`, `tel:`, `#fragment` and `target="_blank"` untouched. Only same-origin site paths are in scope.
- The rewrite carries the sandbox token, so it must run where the token is known — the same place the existing rewrite already runs.

**Navigation is transient view state, never arrangement state** (the user's choice):

- The frame reports its current route to the parent on load and on navigation; a board whose frame has navigated **shows the route it is actually displaying** in its header, with a reset control that returns it to the board's own route.
- **The canvas layout never reflows.** Boards stay keyed `route@device`; clicking a link must not add, remove or move anything.
- Comment pins stay anchored to the board's own `pagePath`. A pin is a note about a page, and the board is still that page's board — but this is exactly why the header must not silently keep claiming the old route while a different page is displayed.

**Agents must be told.** The user asked for this explicitly: the agent-facing context should document that a plain `<a href="/route">` is the correct way to link between pages, and that `history.back()` works for a back control. Without that, an agent will keep avoiding cross-page links because they did not work.

### §G — External images and media (added 2026-09-25, while Phase 5 was executing)

The user's ask, verbatim: *"while working, also allow external urls for images, videos as we did for google fonts"* — with the observation that `img-src 'self' data: blob:` means *"no external images, no Lottie from a CDN, no sprite sheets. Motion must be CSS/SVG/inline"*, and that this *"limits the full design view"*, because a design layer built only from static SVGs is not a real preview.

**This looks like §E and is not.** The fonts work needed a storage format, a validator, an editor and an emitter because a font is *declared* in the head by a `<link>`. An image or a video is *referenced* in the body by the page's own `<img>`/`<video>`, so there is nothing to declare, nothing to store and nothing to toggle — the sole blocker is the policy. Verified rather than assumed: `validate_page_fragment` (`validation.rs:318-474`) has no attribute-level URL rules at all, so `<img src="https://…">` and `<video src="https://…">` already pass validation today; the CSP is what refuses them.

**So the change is two directives and one header:**

- `img-src 'self' data: blob:` → **add `https:`**. Covers `<img>`, CSS `background-image`, and sprite sheets.
- **Add `media-src 'self' data: blob: https:`.** It does not exist today, so `default-src 'self'` governs `<video>` and `<audio>` and every external source is refused.
- **Add `Referrer-Policy: no-referrer` to sandbox responses.** The sandbox URL *is* the credential (`/s/{token}/…`), so a response should not leave that secret's safety to whatever default a framework or browser happens to apply.

> **Correction (2026-09-25, from Task 13's re-review — the first version of this bullet over-claimed, and the controller wrote it.)** It read: *"every external subresource request carries it in `Referer`. The font widening already leaks the token to the font origins; widening images would leak it to every image host any page references."* **Both halves are wrong.** The framework's default security-headers layer (`vendor/umbral-core/src/app.rs:1925-1945`, applied to the whole router and never disabled here) had already set `Referrer-Policy: strict-origin-when-cross-origin` with `set_if_absent` — and under that default a cross-origin request carries the **origin only**, never the path, so **the token was not travelling**. A token-bearing cross-origin `Referer` needs an engine whose default is `no-referrer-when-downgrade`, or a future `unsafe-url`. The sandbox's explicit header is an *override* of that framework default, not the introduction of a policy where there was none.
>
> The header is still right, for a smaller and more durable reason: `no-referrer` is strictly stronger than the default, and it removes a secret-in-URL's safety from the list of things a browser or framework default decides. What it is **not** is a fix for a leak that fires today — and the code comment (`views.rs:697-707`) already says exactly that, so this bullet now agrees with the code instead of contradicting it.
- `connect-src` stays tight, deliberately — see below.

Both `https:` additions are scheme sources, not `*`: plain `http:` stays refused (mixed content would block it anyway), and the existing `data:`/`blob:` entries remain for inline content. The rationale recorded for the font widening carries over unchanged — separate origin, no cookies, short-lived read-only token, values supplied by the project's own members.

**What this deliberately does not do — Lottie.** The user named "no Lottie from a CDN" as a symptom, and it is worth being exact about why the above does not fix it: there are two independent blockers, and neither is `img-src`. (a) `<script src` is a **banned marker** in a page fragment (`validation.rs:332`) — a page cannot declare a CDN script at all. (b) A Lottie player fetches its animation JSON, which is `connect-src` — the one directive with a deliberate tightness rationale, documented in the composer: it is what stops agent-authored JS from `fetch()`ing the operator's localhost and internal network from their browser. Widening it would trade a load-bearing boundary for a nice-to-have.

**And Lottie still works without touching it, which is the path agents should be told about.** (The first version of this paragraph was wrong in two of its three mechanisms — the controller wrote it, Task 13's review caught it, and it is corrected here because the same text ships to agents as guidance.)

> **Correction (2026-09-25, from Task 13's review).** The original claimed *"the composer inlines component JS as an inline script"* and *"the animation JSON goes in `assets/` … `connect-src 'self'` covers the fetch"*. Neither holds in the sandbox. `compose_document` emits components as `<script src="/s/{token}/f/components/{name}.js">` (`composer.rs:284-288`) — inlining happens only in the *export* document — so a sandbox component is a same-origin **linked** script under `script-src 'self'`. And `check_extension` (`validation.rs:180-190`) admits `assets/` only for `svg/png/jpg/jpeg/webp/gif/ico`, while `styles/` admits only `tokens.css`, `tokens.json` and `resources.json`, so **no JSON file can be stored for an animation at all**; the 128 KiB per-file cap applies regardless.
>
> What actually works, and still needs no `connect-src`: a **component** carries the wiring (same-origin under `script-src 'self'`), the player it appends from a CDN is permitted by `script-src https:`, and the animation data is passed **inline** in that component (lottie's `animationData`) rather than fetched.
>
> The conclusion this section exists to defend is unchanged — **do not widen `connect-src` for Lottie** — but the reasoning now points at mechanisms a reader can check, which the first version did not. That is the third over-claiming rationale this phase has had to correct, and the pattern is worth naming: a plausible mechanism written from memory instead of read off the code.

**Motion.** CSS, SVG and inline animation are unaffected; video is newly possible. What changes is that "motion must be CSS/SVG/inline" stops being a constraint agents must design around and becomes one option among several.

## Publish order (unchanged, and now wider)

Measured, not theoretical: the deployed backend answers **403** to a realtime group it does not know, and the realtime layer refuses the **entire** handshake when any one group fails policy. So a frontend built from this code, served before the backend, kills realtime app-wide. **The backend must be deployed before the frontend** — and Phase 5's CSP change is likewise backend-first, since a frontend expecting fonts to load would show them missing against an old backend.

The user's decision stands: deploy the backend, then build the frontend.

## Testing

- **Backend** (`cargo test --workspace`): `layout_doc` label validation and read-filtering; the resource document's parse/validate/refuse cases (each scheme-refusal rule, each cap); composer tests asserting enabled sets' tags appear in the shell head in order and that **disabled sets do not**; a CSP test asserting the widened directives are present and that `javascript:` never appears in an emitted tag. Extend `tests/realtime_bulk_bridge.rs` only if a new writer path is added — none is planned.
- **Frontend** (`npm test`, `npm run build`): pure helpers only — label resolution (`pageLabels[route] ?? title ?? route`), the resource document's tolerant parse mirroring `normalizeLayout`, and the set-toggle reducer. The canvas interactions remain visually verified, as the repo has no RTL/jsdom.
- **Item 5 is verified by reproduction**, not by a test, and its fix gets a test only if the root cause turns out to be pure logic.

## Rulings carried in from Phase 4 (for continuity)

- The realtime **suffix drift guard was declined by the user** previously; this spec does not re-add it, but records that the failure is worse than assumed (whole-handshake 403, not one silent group).
- Phase 4's final `npm run build` is **held** pending the backend deploy.

## Affected files (reference)

**Backend:** `plugins/taskflow-design/src/layout_doc.rs` (+`page_labels`), `src/composer.rs` (head emission + CSP), `src/validation.rs` (resource document rules), `tests/` (+label and resource tests). No new migrations — reusing `design_file`.
**Frontend:** `src/lib/design-layout.ts` (+label helpers), `src/pages/design/pages-panel.tsx` (rename + resolution), `src/pages/design/design-canvas.tsx` (ArtboardHeader actions, rowHeaders label, `LazyFrame` latch, per-board epoch), `src/pages/design/DesignSurfacePage.tsx` (action wiring, `rotatedBoards`/device state), `src/pages/design/token-editor.tsx` or a sibling (resource-set editor).
