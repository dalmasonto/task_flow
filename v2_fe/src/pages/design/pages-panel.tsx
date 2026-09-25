/// The Pages tab: every manifest route with an open/closed toggle, a group
/// picker per page for the `groups` arrangement, and a box to give a page a
/// display label.
///
/// The list is GROUPED and NUMBERED: the groups first, in the document's own
/// order, then everything ungrouped, numbered 1..N across the whole sequence.
/// `pages-order.ts` owns that order and those numbers, and the test on them.
///
/// It is a listing and nothing more — grouping a page here does NOT move its
/// board on the canvas, and must not be made to. See the call site below.
///
/// Extracted from `DesignSurfacePage.tsx` (already ~1000 lines) when the group
/// picker landed; it is the one panel with per-row local interaction.
///
/// The group picker is a native `<select>` on purpose, not the app's Base UI
/// `Select`: that component renders the raw value unless the root is given an
/// `items` value→label map, which is an easy way to ship a picker that shows
/// `g1` instead of `Auth`. A native select has no such failure mode and needs
/// no extra client state. The rename box is a plain `<input>` for the same
/// reason: a field that commits its own text needs no value→label map either.

import { useState } from "react"

import type { DesignManifest } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import {
  assignRoute,
  createGroup,
  groupOf,
  MAX_GROUPS,
  MAX_LABEL,
  pageLabel,
  setPageLabel,
  type LayoutDoc,
} from "@/lib/design-layout"

import { groupedPages, type NumberedPage } from "./pages-order"

const UNGROUPED = "__ungrouped__"

/// The heading a section (a group, or the ungrouped tail) is introduced by — one
/// constant so the two cannot drift apart. The headings themselves are `<h3>`,
/// the level the rest of the app uses for a section inside a page, so the
/// panel's sections are headings a screen reader can jump between rather than
/// merely styled text.
const SECTION_HEADING =
  "px-3 pt-2.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"

export function PagesPanel({
  manifest,
  openRoutes,
  onToggleRoute,
  layout,
  onLayoutChange,
}: {
  manifest: DesignManifest | null
  openRoutes: string[]
  onToggleRoute: (route: string) => void
  layout: LayoutDoc
  onLayoutChange: (next: LayoutDoc) => void
}) {
  const routes = manifest?.routes ?? []

  const assign = (route: string, value: string) => {
    onLayoutChange(assignRoute(layout, route, value === UNGROUPED ? null : value))
  }

  const addGroup = () => {
    const name = window.prompt("Group name")
    if (!name) return
    const { doc, id } = createGroup(layout, name)
    // `createGroup` returns the input unchanged when the name is taken or the
    // cap is hit, so an empty id means "nothing happened" — do not claim else.
    if (!id) return
    onLayoutChange(doc)
  }

  // A rename is an edit to the SHARED arrangement document, so it goes through
  // the same `onLayoutChange`/`updateLayout` path every other layout edit uses
  // — there is deliberately no second save path for labels.
  //
  // Both "nothing happened" cases are caught here rather than spent on a PUT:
  // re-typing the label you already have still builds a new document object,
  // and an over-cap label is refused by `setPageLabel` returning the document
  // itself. Only a real change reaches the server.
  const rename = (route: string, value: string) => {
    if (value.trim() === (layout.pageLabels[route] ?? "")) return
    const next = setPageLabel(layout, route, value)
    if (next === layout) return
    onLayoutChange(next)
  }

  // Which section a page is listed under, and which number it carries, are
  // `pages-order.ts`'s job rather than this component's: one pure function, so
  // there is a test on it (this repo's test setup has no DOM, so JSX cannot
  // have one), and one place that can be wrong about the edge cases — a group
  // the user deleted, a page two groups both claim — instead of two.
  //
  // This is a LISTING. The canvas is deliberately NOT sorted to match it: the
  // boards render in `openRoutes`, which `openRoute` keeps in MANIFEST order,
  // so re-sorting them into these sections would move every board below the
  // edited row the moment a single page is grouped. The spec's §F is absolute
  // about that — "The canvas layout never reflows" — and a grouping edit is no
  // more entitled to a reflow than a link click is. Grouping a page changes
  // where the page is LISTED; it never changes what the canvas looks like.
  const grouped = groupedPages(layout, routes)

  /// Manifest entries by path, for the row's title fallback.
  const byPath = new Map(routes.map((entry) => [entry.path, entry]))

  /// One page's row. A plain function the section maps CALL, not a component
  /// they mount: a component defined in here would be a new type on every render
  /// of the panel, so React would remount every row — `LabelInput`'s draft
  /// included — each time anything above it changed. Called, a row is an
  /// ordinary keyed child of its section.
  ///
  /// A row does remount when grouping moves it to another section. For the
  /// self-inflicted path that is harmless: the select's own `onChange` is what
  /// moves it, and reaching the select blurs the rename box first, so the blur
  /// commits the draft before the row changes parent.
  ///
  /// It does NOT cover a REMOTE move. `DesignSurfacePage` adopts another
  /// viewer's arrangement on the `designLayout` realtime event
  /// (`fetchLayout().then(setLayout)`), so an agent or a second viewer
  /// regrouping this very page re-renders the panel with a new `layout`, the row
  /// changes parent, `LabelInput` remounts, and an uncommitted draft is dropped
  /// with no blur to commit it. A known limitation, not corruption: the loss is
  /// one uncommitted label — visible as the box emptying itself — and nothing
  /// reaches the shared document. Hoisting the draft into this component to
  /// close it was rejected as too expensive for that: `LabelInput`'s
  /// resync-when-someone-else-renames rule (see it below) would have to be
  /// re-implemented at panel level, and every keystroke would then re-render
  /// every row.
  const pageRow = (page: NumberedPage) => {
    const open = openRoutes.includes(page.route)
    const current = groupOf(layout, page.route)
    const label = layout.pageLabels[page.route] ?? ""
    // The row's name comes from the resolver, never from `route.title`
    // directly — the canvas headers resolve through the same call. A
    // `NumberedPage` is only ever built out of `routes`, so the lookup always
    // hits; the raw path as the fallback (which `pageLabel` itself documents as
    // the last resort) keeps a nameless row off the screen if it ever did not.
    const name = pageLabel(layout, page.route, byPath.get(page.route)?.title ?? page.route)
    return (
      <div key={page.route} className="flex items-center gap-1 px-2 py-1">
        <button
          className={cn(
            "flex min-w-0 flex-1 items-center justify-between rounded px-1 py-0.5 text-left text-sm hover:bg-muted",
            open && "bg-muted/60 font-medium",
          )}
          onClick={() => onToggleRoute(page.route)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {/* The page's position in THIS list, so the number a reader sees
                always matches the position they see it in. */}
            <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
              {page.n}
            </span>
            <span className="truncate">{name}</span>
          </span>
          <span className="ml-2 shrink-0 font-mono text-[11px] text-muted-foreground">
            {page.route}
          </span>
        </button>
        {/* Kept native on purpose — see the file header. */}
        <select
          className="max-w-24 shrink-0 rounded border bg-transparent px-1 py-0.5 text-[11px]"
          aria-label={`Group for ${page.route}`}
          value={current?.id ?? UNGROUPED}
          onChange={(e) => assign(page.route, e.target.value)}
        >
          <option value={UNGROUPED}>—</option>
          {layout.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <LabelInput
          route={page.route}
          label={label}
          name={name}
          onCommit={(value) => rename(page.route, value)}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col py-1">
      {/* A group with no pages still gets its heading: `+ New group` is the only
          way to make one, so hiding an empty group would make that button look
          like it did nothing. But a section needs pages to be a section OF
          anything: with `manifest === null` — the panel is mounted for the whole
          load — there are no pages yet, so every section would be empty and the
          panel would read as headings stacked above "No pages yet.": the empty
          state drawn as though it were a result. Same for a project with no
          pages at all. */}
      {routes.length
        ? grouped.groups.map((section) => (
            <div key={section.id} className="flex flex-col">
              <h3 className={SECTION_HEADING}>{section.name}</h3>
              {section.pages.map(pageRow)}
            </div>
          ))
        : null}
      <div className="flex flex-col">
        {/* The tail is only a NAMED thing once something is grouped. With no
            groups at all every page is ungrouped, and a lone "Ungrouped" above
            the entire list is noise — and with no PAGES at all it is worse than
            noise. */}
        {routes.length && grouped.groups.length ? (
          <h3 className={SECTION_HEADING}>Ungrouped</h3>
        ) : null}
        {grouped.ungrouped.map(pageRow)}
      </div>
      {/* Gated on the CAP, not on emptiness. This button is the only caller of
          `createGroup`, so hiding it while `groups` is empty would make the
          first group impossible to create and the whole `groups` arrangement
          permanently empty. Do not "simplify" this back to `length`.
          `createGroup` enforces the same cap itself — that is enforcement,
          this is display. */}
      {layout.groups.length < MAX_GROUPS ? (
        <button
          className="mt-1 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={addGroup}
        >
          + New group
        </button>
      ) : null}
      {!routes.length ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>
      ) : null}
    </div>
  )
}

/// The rename box: a plain `<input>`, never a Base UI field — the rule this
/// panel's controls follow (see the file header). Commits on Enter or blur,
/// reverts on Escape.
///
/// It holds the LABEL only, never the resolved name: an empty box means "no
/// label", so clearing it is how a label is removed — the page's own title
/// shows through again, and `name` is the placeholder saying which that is.
/// The committed value therefore goes straight to `setPageLabel` with no "is
/// this the title after all?" special case: re-typing the title just pins it as
/// a label, which renders identically.
function LabelInput({
  route,
  label,
  name,
  onCommit,
}: {
  route: string
  /** The stored label, `""` when the page has none. */
  label: string
  /** The name in use while the box is empty: the page's own title. */
  name: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(label)
  // The label this box last synced with. Adjusting state during render —
  // React's documented pattern for "state that changes when a prop changes" —
  // is what stops a stale draft being committed over someone else's rename:
  // focus the box, another viewer renames the page, click away, and a blur
  // would otherwise write back the name the box was still showing.
  const [syncedLabel, setSyncedLabel] = useState(label)
  if (syncedLabel !== label) {
    setSyncedLabel(label)
    setDraft(label)
  }

  return (
    <input
      className="w-24 shrink-0 rounded border bg-transparent px-1 py-0.5 text-[11px]"
      aria-label={`Label for ${route}`}
      placeholder={name}
      value={draft}
      // The cap is the server's (`MAX_LABEL`, i.e. the layout document's own
      // rule); holding it on the box means an over-cap label is never typed,
      // and the refusal in `setPageLabel` stays the contract for other callers.
      maxLength={MAX_LABEL}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(draft)
        // Revert in place WITHOUT blurring: a blur here would commit the very
        // draft this branch is discarding.
        else if (e.key === "Escape") setDraft(label)
      }}
    />
  )
}
