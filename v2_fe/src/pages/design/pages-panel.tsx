/// The Pages tab: every manifest route with an open/closed toggle, plus a group
/// picker per page for the `groups` arrangement.
///
/// Extracted from `DesignSurfacePage.tsx` (already ~1000 lines) when the group
/// picker landed; it is the one panel with per-row local interaction.
///
/// The group picker is a native `<select>` on purpose, not the app's Base UI
/// `Select`: that component renders the raw value unless the root is given an
/// `items` value→label map, which is an easy way to ship a picker that shows
/// `g1` instead of `Auth`. A native select has no such failure mode and needs
/// no extra client state.

import type { DesignManifest } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import { assignRoute, createGroup, groupOf, type LayoutDoc } from "@/lib/design-layout"

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

  return (
    <div className="flex flex-col py-1">
      {routes.map((route) => {
        const open = openRoutes.includes(route.path)
        const current = groupOf(layout, route.path)
        return (
          <div key={route.path} className="flex items-center gap-1 px-2 py-1">
            <button
              className={cn(
                "flex min-w-0 flex-1 items-center justify-between rounded px-1 py-0.5 text-left text-sm hover:bg-muted",
                open && "bg-muted/60 font-medium",
              )}
              onClick={() => onToggleRoute(route.path)}
            >
              <span className="truncate">{route.title}</span>
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
          </div>
        )
      })}
      {layout.groups.length ? (
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
