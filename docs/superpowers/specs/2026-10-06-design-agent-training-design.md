# Design agent training: shadcn tokens, a Tailwind bridge, and an on-demand guide

TaskFlow task **#613**. Brainstormed with dalmas 2026-10-06.

## Goal

Designs that agents build on the Design surface should **port to code**: the
markup reads like a real shadcn app (`bg-primary text-primary-foreground`,
`text-muted-foreground`, `border-border`, `rounded-lg`), and the project's
tokens drop into a shadcn `globals.css` unchanged. Agents learn this on demand
from one tool, without growing the always-loaded instructions.

### What dalmas decided

| Question | Decision |
|---|---|
| What "use shadcn variables" is for | Designs port to code |
| How strict the validator is about colour classes | Semantic only: Tailwind's raw palette is rejected like hex |
| New projects and old invented names (`--bg`, `--accent`) | Seed + fill gaps: shadcn defaults sit under every project's tokens; nothing stored is rewritten |
| Shape of the learn-more tool | Topics: `design_guide(topic?)`, served by the backend |
| How `bg-primary` reaches Tailwind | Option A: a generated `@theme inline` bridge in the page shell |

### Facts this design rests on (verified 2026-10-06)

- Colour tokens already emit bare names: `colors.primary` → `--primary`
  (`tokens.rs:152-173`). shadcn naming needs **no rename or migration**.
- The page shell and the four `ui-*` primitives already read shadcn names:
  `--background --foreground --muted-foreground --primary --primary-foreground
  --popover --popover-foreground --border --radius` (`composer.rs:922`,
  `primitives.rs`). Nothing guarantees they exist: a fresh project has an empty
  token doc (`tokens.rs:125-132`), and a legacy project with `--bg/--accent`
  renders its primitives and body unstyled.
- Tokens reach Tailwind only through arbitrary values (`bg-[var(--primary)]`).
  The sandbox uses the Tailwind browser build (`composer.rs:917`), which compiles
  only `<style type="text/tailwindcss">`; `tokens.css` is a plain stylesheet, so
  its `@theme {}` block is ignored and `bg-primary` cannot work today.
- `--radius` (shadcn's single radius) cannot come from the `radius` category,
  which always emits `--radius-<key>`.
- Dark values emit under `:root[data-theme="dark"]` only (`tokens.rs:243`); the
  sandbox toggles `data-theme` (`composer.rs:232`). shadcn apps use `.dark`.
- `tokens.css` is generated per request from `styles/tokens.json`, else served
  from a legacy `styles/tokens.css` row (`views.rs:1261-1308`); the composed page
  stamps it with a revision (`composer.rs:823-828, 918`).
- The validator rejects hex/rgb/hsl and px arbitrary values (`validation.rs:442-566`)
  but lets Tailwind's palette through (`bg-blue-500`).
- `AGENT_INSTRUCTIONS` (6,399 chars, `mcp/src/instructions.ts`) never mentions
  design. All design teaching is in tool descriptions and a 3.4k-char
  `AUTHORING_GUIDE` that `design_get_tokens` returns on **every** call
  (`agent_views.rs:91-196`), alongside the `primitives` catalogue.
- Agents can already create, rename, reorder and link groups (`PUT
  /api/taskflow/agents/design/layout`). The dashboard cannot rename a group: the
  header is a static `<h4>` (`pages-panel.tsx:502-504`).

## Design

### 1. Tokens and rendering (backend, `taskflow-design`)

**1a. The shadcn defaults overlay.** A new module `defaults.rs` holds the stock
shadcn **neutral** theme as a `TokensDoc`:

- `colors`: `background foreground card card-foreground popover popover-foreground
  primary primary-foreground secondary secondary-foreground muted muted-foreground
  accent accent-foreground destructive border input ring chart-1…chart-5 sidebar
  sidebar-foreground sidebar-primary sidebar-primary-foreground sidebar-accent
  sidebar-accent-foreground sidebar-border sidebar-ring`, each with `light` and
  `dark` (oklch values from shadcn's neutral base colour).
- `custom.radius` → `--radius: 0.625rem` (see 1c).

`effective_tokens(project) = defaults ⊕ project`: a token the project defines
wins in full (both themes); a name the project lacks comes from the defaults.
Matching is by **emitted variable name**, so a project's `custom["--primary"]`
(the shape legacy CSS imports produce) also shadows the default `colors.primary`.
The overlay is applied **at serve/compose time only**: `styles/tokens.json` is
never rewritten, so there is no migration and nothing to roll back.

Every consumer of the token CSS uses the effective doc: the sandbox
`tokens.css` route, the `/api/design/{project}/tokens.css` export, the inline
export composer, screenshots and `design_compare`. A legacy project with only a
`styles/tokens.css` row is parsed through the existing importer
(`css_to_tokens_json`, round-trip-safe per `tests/tokens_codec.rs:47`) and
overlaid the same way, so its own variables stay byte-identical in value.

A new, empty project therefore renders the full shadcn look with no seeding step.

**1b. The generated CSS takes shadcn's `globals.css` shape:**

```css
:root { /* every light value */ }
:root[data-theme="dark"], .dark { /* every dark value */ }
@theme inline {
  --color-<key>: var(--<key>);           /* one per EFFECTIVE colour key */
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}
```

- The old raw-value `@theme { … }` block is **dropped**: the browser ignored it,
  and in an app it would register `--primary` etc. as theme variables, which is
  wrong. The importer already reads `:root` first, so old files still import.
- Dark values emit under **both** selectors: the sandbox keeps toggling
  `data-theme`, and the file works unchanged in an app that uses `.dark`.
- The radius scale matches the repo's own `v2_fe/src/index.css`. It is emitted
  only when the effective doc defines `--radius` (always true with defaults).
- Fonts, shadows and spacing need no bridge: `--font-sans`, `--shadow-<k>` and
  `--spacing-<k>` already carry Tailwind's own names, and an unlayered `:root`
  value overrides Tailwind's layered default.

**1c. `--radius` has a stated home.** It is the `custom.radius` token, which
emits `--radius` (as project 2's tokens already do). The `radius` category keeps
emitting `--radius-<key>` for projects that want extra fixed radii.

**1d. The bridge reaches Tailwind in the sandbox (option A).** The page shell
and the inline export add the `@theme inline` block from 1b in a
`<style type="text/tailwindcss">` before the page body, generated from the same
effective doc. Token **values** stay in the plain `tokens.css`, so live token
edits and `design_compare`'s `?ov=` overrides keep working unchanged: the
bridge only says `var(--primary)`. A token write that adds or removes a colour
key changes the bridge, so an open board must re-compose (not just re-fetch
`tokens.css`). The plan verifies how the canvas reacts to a tokens revision
today and adds a re-compose if it only swaps the stylesheet.

**1e. Validator: semantic colours only.** New rule `palette-color` in
`validation.rs`, applied to pages **and** components:

- Rejects a Tailwind palette colour on any colour utility, with any variant
  prefix (`hover:`, `dark:`, `md:` …) and opacity suffix (`/50`): utilities
  `bg text border border-x/y/t/r/b/l ring ring-offset outline divide fill stroke
  from via to placeholder decoration caret accent shadow`; palette names `slate
  gray zinc neutral stone red orange amber yellow lime green emerald teal cyan sky
  blue indigo violet purple fuchsia pink rose` followed by `-50…-950`.
- Allows `black white transparent current inherit` (shadcn's own overlays use
  `bg-black/50`), every semantic class, and `bg-[var(--x)]` for custom tokens.
- The error names the class and a semantic replacement: background-ish
  utilities suggest `bg-primary / bg-muted / bg-accent / bg-card`, text suggests
  `text-foreground / text-muted-foreground / text-primary`, border suggests
  `border-border / border-input`.
- Existing stored pages are not re-validated: they keep rendering; the rule
  applies at the next write.
- The legacy CSS validator's hint `@theme { --color-accent: … }`
  (`validation.rs:699`) is corrected to the bare-name convention.

**1f. `design_get_tokens` and the dashboard token editor show the source.** The
response gains `defaults`: the names currently served from the defaults (absent
from the project). The token editor marks those rows "default"; editing one
saves it into the project's `tokens.json` like any other token.

### 2. How agents learn it

**2a. Guide route (backend).** `GET /api/taskflow/agents/design/guide?topic=`
(agent-authed, `RequireAgent`), text served from a new `guide.rs` in
`taskflow-design`. It lives in the backend so a backend deploy updates it
without waiting for every machine to reinstall the MCP (the same reason
`AUTHORING_GUIDE` lives there today, `agent_views.rs:80-90`).

| Topic | Contents |
|---|---|
| *(none)* | The index, about 600 chars: one line per topic saying when to read it |
| `tokens` | The shadcn names and what each is for; light/dark; `custom.radius`; the classes to write (`bg-primary text-primary-foreground`, `bg-card`, `border-border`, `rounded-lg`); what is rejected and why; that defaults fill gaps and how to override one with a `design_write_tokens` patch |
| `fonts` | `typography.font-sans` + `styles/resources.json` via `design_write_asset` (moved from `AUTHORING_GUIDE`) |
| `flow` | Groups, page order and links; when to use `design_arrange` vs a single operation |
| `primitives` | The four `ui-*` components with attrs and examples (from `primitives::catalog()`) |
| `pages` | Links between pages, back controls, media and Lottie (moved from `AUTHORING_GUIDE`); the page rules: no `<style>`, no raw header/nav/footer/aside, components over repetition |

An unknown topic is a 400 that lists the valid ones.

**2b. MCP tool `design_guide(topic?)`** calls that route and returns its text.

**2c. `AGENT_INSTRUCTIONS` gains one short design paragraph** (about 3 lines):
projects have a Design surface (`design_*` tools); before the first design write
in a session, call `design_guide` for the index and read the topics needed.
This is the only always-loaded cost.

**2d. `design_get_tokens` gets leaner.** The response drops `guide` (3.4k chars)
and `primitives`, keeping one `note` line pointing at `design_guide`. Every
token read gets about 4–5k chars cheaper. An older MCP keeps working: the
fields simply stop arriving.

**2e. Tool descriptions teach the shadcn vocabulary.** Examples move from
`--accent`/`--bg`/`--surface` to shadcn names and classes:

- `design_write_page` / `design_write_component`: "colour from shadcn classes
  (`bg-primary`, `text-muted-foreground`); raw palette and hex are rejected —
  see `design_guide tokens`".
- `design_get_tokens`, `design_write_tokens`, `design_compare`: example
  patches and overrides use `colors.primary`, `--primary`, `--background`.

### 3. Rename group in the dashboard

The pages panel's group header gets a rename action (inline edit, Enter saves,
Escape cancels) that writes the layout through the same update path the panel
already uses for create/reorder/delete. No backend change: the layout document
already carries the group name and agents rename through it today.

## Testing

**Backend (`cargo test --workspace`; bare `cargo test` skips plugin crates):**
- Overlay: an empty project gets every default; a project token wins in both
  themes; a legacy `custom["--primary"]` shadows `colors.primary`; a legacy
  CSS-only project keeps its own values byte-identical.
- CSS shape: no raw `@theme {}`; dark under both selectors; one
  `--color-<key>` per effective colour key; the radius scale present.
- Composer: the shell contains the `text/tailwindcss` bridge; the export inlines it.
- `palette-color`: each utility family, with variants and opacity, rejected with
  the right suggestion; `bg-black/50`, `bg-primary`, `bg-[var(--x)]` accepted;
  components covered too.
- Guide route: index, each topic, unknown topic → 400, agent auth required.
- `design_get_tokens`: `guide`/`primitives` gone, `defaults` correct.
- Update `tests/tokens_codec.rs` for the new CSS shape.

**Live render check:** a page using `bg-primary text-primary-foreground
rounded-lg` screenshots with the token colours in light and dark (through
`design_screenshot`, which uses the real Tailwind browser build).

**MCP (`npm test`):** `instructions.test.ts` asserts `design_guide` is named;
the new tool is covered.

**Frontend (`vitest`, `tsc -b`, lint must not grow past its baseline):** the
rename helper is a pure function in the layout module, so it is testable
(`.tsx` tests are not collected).

## Rollout

1. **Backend first** (`deploy-backend.yml`): overlay, CSS shape, bridge,
   validator, guide route, leaner `design_get_tokens`. From this moment every
   project, including ones served to agents on old MCPs, gets working shadcn
   defaults and `bg-primary`.
2. **Frontend** (push to `main`): default badges in the token editor, rename group.
3. **MCP release** (`mcp-v*` tag): `design_guide`, the instructions paragraph,
   new descriptions. Reaching an agent needs `npm i -g @dalmasonto/taskflow-mcp`
   and an MCP restart.
4. **Docs**: the docs site's Design section and `v2_fe/public/llms.txt` describe
   the shadcn vocabulary and `design_guide`.

**Behaviour change to announce:** after step 1, writing a page or component
that uses palette classes (`bg-blue-500`) is refused with the replacement named.

## Out of scope

- Rewriting existing projects' token names or page markup (dalmas chose
  fill-gaps over migration).
- Other shadcn base colours (zinc, stone…) as selectable presets.
- Checking that a `var(--x)` reference names a defined token.
- Dynamic or conditional MCP tool listing (explicitly not wanted).
