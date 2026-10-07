//! The design guide agents read on demand through `design_guide(topic?)`.
//! Lives in the backend so a deploy updates it without waiting for every
//! machine's global MCP install (same reason the old AUTHORING_GUIDE lived here).

pub const TOPICS: &[&str] = &["tokens", "fonts", "flow", "primitives", "pages"];

const INDEX: &str = "Design guide — call design_guide with a topic:\n\
- tokens: the shadcn colour names, light/dark and named themes, radius, the classes to write (bg-primary…), what is rejected. Read before your first design write.\n\
- fonts: adding a webfont (a token plus styles/resources.json).\n\
- flow: groups, page order and links between screens; design_arrange vs single operations.\n\
- primitives: the built-in <ui-accordion|dialog|sheet|tabs> components with examples.\n\
- pages: page rules, links between pages, back buttons, images and motion.";

const TOKENS: &str = r#"# Tokens — shadcn vocabulary

Every project renders with shadcn's semantic colour tokens. Names the project does not define come from built-in defaults (shadcn neutral), so they ALWAYS exist; design_get_tokens lists which are defaults under `defaults`.

## Names (each has light + dark defaults)
background / foreground — the page
card / card-foreground — raised surfaces
popover / popover-foreground — menus, dialogs, sheets
primary / primary-foreground — the main action
secondary / secondary-foreground — the quieter action
muted / muted-foreground — subdued surfaces and secondary text
accent / accent-foreground — hover and selected states
destructive — danger
border, input, ring — lines, field borders, focus rings
chart-1 … chart-5 — data series
sidebar, sidebar-foreground, sidebar-primary(-foreground), sidebar-accent(-foreground), sidebar-border, sidebar-ring
radius — ONE base radius, stored as custom.radius (e.g. 0.625rem); rounded-sm…rounded-4xl derive from it.

## Write classes exactly like a shadcn app
bg-background text-foreground · bg-card text-card-foreground · bg-primary text-primary-foreground hover:bg-primary/90 · bg-secondary · bg-muted text-muted-foreground · hover:bg-accent hover:text-accent-foreground · border border-border · border-input · ring-ring · text-destructive · rounded-md / rounded-lg / rounded-xl.
Opacity modifiers work: bg-primary/10, border-border/60.

## Rejected
Hex/rgb/hsl or px in brackets (bg-[#3b82f6], p-[13px]) and Tailwind's raw palette (bg-blue-500, text-zinc-400) — they ignore the theme and do not port to a shadcn app. bg-black/50 and text-white are fine (overlays).

## Changing the theme
Restyle with design_write_tokens and a patch — pages need no edits:
{"colors":{"primary":{"light":"oklch(0.55 0.2 250)","dark":"oklch(0.7 0.17 250)"}}}
{"custom":{"radius":{"light":"0.5rem"}}}
Prefer oklch values. A project-only colour (e.g. colors.brand) becomes bg-brand / text-brand automatically; use it sparingly — prefer the shadcn names.
Check dark mode: design_screenshot with theme "dark". Compare options with design_compare before writing.

## Themes
light is the base. Every other theme (dark, or a named one like "ocean") sets only the tokens it changes and inherits the rest from light. design_get_tokens lists them in `themes`. A design made before named themes has light and an implicit dark.
To try a palette, add a theme with design_write_tokens and compare themes. Don't overwrite light.
- Add: {"themes":[{"name":"dark"},{"name":"ocean","label":"Ocean"}],"colors":{"primary":{"ocean":"oklch(0.62 0.14 220)"}}} — `themes` is the FULL ordered list besides light: a theme you leave out is deleted with its values (keep dark).
- Rename: {"themes":[{"name":"dark"},{"name":"sea","rename_from":"ocean"}]}. Renaming onto a theme that already exists is refused — rename it in this same patch, or delete it in an earlier patch.
- Edit one theme: {"colors":{"primary":{"ocean":"oklch(0.7 0.12 220)"}}}; {"ocean": null} drops that value (back to light's).
- The write reply lists `themes_removed` and `themes_renamed` so you can confirm what changed.
- Look: design_screenshot theme "<name>", theme "all" (one image per theme) or theme "both" (light + dark); design_compare themes ["light","dark","ocean"].
Names: a name starts with a lowercase letter, then lowercase letters, digits or dashes, up to 32 characters; light, both and all are reserved; at most 8 themes including light.

## Device safe areas
In the Design view's phone frames the page draws under the status bar. Pad the top bar with pt-[var(--safe-top)] and the tab bar or sticky footer with pb-[calc(0.75rem+var(--safe-bottom))]; both are 0px in screenshots and exports, so nothing shifts there.
Status-bar icons: data-status-bar="light" (white icons) or "dark" on the page's top element wins; else the theme's appearance ({"themes":[{"name":"dark"},{"name":"forest","appearance":"dark"}]}, "light"|"dark"; omit to keep, null for automatic); else the colour at the top of the page decides.

## Porting
The served tokens.css IS a shadcn globals.css (:root, .dark, @theme inline): paste it into the app and the classes in these pages work unchanged."#;

const FLOW: &str = r#"# Flow — groups, order and links

Pages sit in named groups that read as the screens of one journey (e.g. "Onboarding", "Settings"). Order matters: groups left→right, pages top→bottom, numbered in the panel.

- design_read_layout — the current groups, order, labels and links. Read it first.
- design_arrange — the whole arrangement in ONE call (groups, membership, order, links). Use it when setting up or reorganising a flow.
- Single operations for small edits: design_create_group, design_update_group (rename), design_reorder_group, design_reorder_page, design_delete_group (pages move to Ungrouped), design_link_pages / design_unlink_pages (arrows between screens, with an optional label like "Sign in").
- Pass base_version from design_read_layout so a concurrent edit conflicts instead of being overwritten.
- Group names are unique (case-insensitive), at most 40 characters."#;

const PAGES_RULES: &str = r#"# Pages

A page is a BODY FRAGMENT: no <html>/<head>/<body>, no <style> blocks, no raw <header>/<nav>/<footer>/<aside> — register a component (design_write_component) and use it, so every page shares it. Repeat UI once as a component, not five times as markup. Use the ui-* primitives (topic "primitives") for accordions, dialogs, sheets and tabs.
"#;

/// Moved verbatim from the old `AUTHORING_GUIDE`: links, back, media.
const PAGES: &str = r#"Links between pages
  Use a plain <a href="/route"> for any route in the manifest — e.g.
  <a href="/app">. The composer rewrites it to the sandbox URL, so the click
  navigates the preview frame and the browser's back/forward work.

  A back control is just:
      <button onclick="history.back()">Back</button>
  The frame keeps its own history, so this works with no extra wiring — but
  only once the frame HAS history: opened directly at one route it has a
  single entry, and Back there does nothing. A link to a known route always
  works, so do not let Back be the only way off a page.

  Do NOT hand-write sandbox URLs, and do not use target="_blank" for
  in-project links — a new tab leaves the frame and loses its history.

Images, video and motion
  External https images and media work:
      <img src="https://cdn.example/hero.png" alt="…">
      <video src="https://cdn.example/clip.mp4" controls></video>
  That covers sprite sheets and CSS background-image from an https origin.
  Plain http is refused, and inline data:/blob: URIs still work for small
  assets. Motion no longer has to be CSS/SVG/inline — a video is a real
  option — though CSS and SVG animation are still the default for interface
  motion.

  A Lottie animation works, but NOT by putting <script src> in a page: page
  fragments may not contain one, and the server refuses that markup. Write a
  COMPONENT instead — in the sandbox a component is a same-origin script, and
  the player it appends from a CDN is allowed by script-src.

  Pass the animation data INLINE in that component (lottie's animationData),
  because there is nowhere to store it as a file: assets/ accepts image
  extensions only, and styles/ accepts only tokens.css, tokens.json and
  resources.json. That data counts against the 128 KB per-file cap on the
  component itself, so keep the animation small: a larger one is refused
  outright (rule `size-cap`), and there is nowhere else to put it.
"#;

/// Moved verbatim from the old `AUTHORING_GUIDE`: webfonts.
const FONTS: &str = r#"Web fonts (one global change, never per page)
  The page font is the `typography.font-sans` token (design_write_tokens):
  it becomes --font-sans, the whole document's default family. The font FILE
  is loaded ONCE for every page from styles/resources.json, which the server
  emits into the head of every page, before the tokens. Write it with
  design_write_asset (path "styles/resources.json"), e.g. for Inter:
      {"version":1,"sets":[{"id":"font","name":"Font","enabled":true,
        "links":[
          {"rel":"preconnect","href":"https://cdn.jsdelivr.net","crossorigin":true},
          {"rel":"stylesheet","href":"https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5/index.css"}
        ]}]}
  Links must be https, with rel stylesheet, preconnect or dns-prefetch.
  The `resources` field of design_get_tokens shows the current document and
  its version (pass it as base_version when you replace it).
  The operator often manages these sets from the panel (enable, disable, add).
  If the document already exists, change only what you need, typically the
  `enabled` flags, and keep every other set exactly as it is.

  Do NOT put a webfont <link> (or its preconnect) in a page fragment: it
  loads for that one page only, so changing the typeface becomes an edit per
  page. A page write that carries one is accepted with a warning (rule
  `page-resource-link`). To switch typeface: change font-sans in the tokens
  and the stylesheet href in resources.json — two writes, zero page edits.
"#;

/// The guide text for `topic`, or the index when `None`.
pub fn text(topic: Option<&str>) -> Result<String, ()> {
    match topic {
        None | Some("") => Ok(INDEX.to_string()),
        Some("tokens") => Ok(TOKENS.to_string()),
        Some("fonts") => Ok(FONTS.to_string()),
        Some("flow") => Ok(FLOW.to_string()),
        Some("pages") => Ok(format!("{PAGES_RULES}\n{PAGES}")),
        Some("primitives") => Ok(format!(
            "# Primitives\n\nBuilt-in components the server expands — use them instead of hand-building these widgets. They are styled with the shadcn tokens.\n\n{}",
            serde_json::to_string_pretty(&crate::primitives::catalog()).unwrap_or_default()
        )),
        Some(_) => Err(()),
    }
}
