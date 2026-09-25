/// The Pages tab: every manifest route with an open/closed toggle, a group
/// picker per page for the `groups` arrangement, and a box to give a page a
/// display label.
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

const UNGROUPED = "__ungrouped__"

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

  return (
    <div className="flex flex-col py-1">
      {routes.map((route) => {
        const open = openRoutes.includes(route.path)
        const current = groupOf(layout, route.path)
        const label = layout.pageLabels[route.path] ?? ""
        // The row's name comes from the resolver, never from `route.title`
        // directly — the canvas headers resolve through the same call.
        const name = pageLabel(layout, route.path, route.title)
        return (
          <div key={route.path} className="flex items-center gap-1 px-2 py-1">
            <button
              className={cn(
                "flex min-w-0 flex-1 items-center justify-between rounded px-1 py-0.5 text-left text-sm hover:bg-muted",
                open && "bg-muted/60 font-medium",
              )}
              onClick={() => onToggleRoute(route.path)}
            >
              <span className="truncate">{name}</span>
              <span className="ml-2 shrink-0 font-mono text-[11px] text-muted-foreground">
                {route.path}
              </span>
            </button>
            {/* Kept native on purpose — see the file header. */}
            <select
              className="max-w-24 shrink-0 rounded border bg-transparent px-1 py-0.5 text-[11px]"
              aria-label={`Group for ${route.path}`}
              value={current?.id ?? UNGROUPED}
              onChange={(e) => assign(route.path, e.target.value)}
            >
              <option value={UNGROUPED}>—</option>
              {layout.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <LabelInput
              route={route.path}
              label={label}
              name={name}
              onCommit={(value) => rename(route.path, value)}
            />
          </div>
        )
      })}
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
