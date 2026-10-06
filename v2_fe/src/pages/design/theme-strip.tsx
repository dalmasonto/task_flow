/// The token panel's theme strip (#619): `Light | Dark | … | +`. Picking a
/// chip makes the editor below show that theme's values; each chip's ⋯ menu
/// duplicates it (every theme) or renames / moves / deletes it (not light).
/// All edits are local to the editor's `doc` until "Save tokens", like every
/// other token edit; the document logic is `token-themes.ts` (tested).

import { useState } from "react"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DesignTokensDoc } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import {
  LIGHT,
  addTheme,
  declaredThemes,
  deleteTheme,
  duplicateTheme,
  moveTheme,
  renameTheme,
  themeLabel,
  themeNameError,
} from "./token-themes"

type Editing = { mode: "add" } | { mode: "rename"; name: string } | { mode: "duplicate"; source: string }

export function ThemeStrip({
  doc,
  active,
  onSelect,
  onDocChange,
}: {
  doc: DesignTokensDoc
  active: string
  onSelect: (theme: string) => void
  onDocChange: (doc: DesignTokensDoc) => void
}) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState("")
  const names = declaredThemes(doc)
  const movable = names.slice(1)
  const renaming = editing?.mode === "rename" ? editing.name : undefined
  const error = editing && draft.trim() ? themeNameError(doc, draft.trim(), renaming) : null

  const start = (next: Editing, initial: string) => {
    setEditing(next)
    setDraft(initial)
  }

  const commit = () => {
    if (!editing) return
    const name = draft.trim()
    if (themeNameError(doc, name, renaming)) return
    if (editing.mode === "add") onDocChange(addTheme(doc, name))
    else if (editing.mode === "rename") onDocChange(renameTheme(doc, editing.name, name))
    else onDocChange(duplicateTheme(doc, editing.source, name))
    onSelect(name)
    setEditing(null)
  }

  const remove = (name: string) => {
    onDocChange(deleteTheme(doc, name))
    if (active === name) onSelect(LIGHT)
  }

  return (
    <div className="border-b px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Theme">
        {names.map((name) => (
          <div
            key={name}
            className={cn(
              "flex items-center rounded-md border text-[11px]",
              name === active ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={name === active}
              className="px-2 py-0.5 font-medium"
              onClick={() => onSelect(name)}
            >
              {themeLabel(doc, name)}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="px-1 py-0.5 hover:text-foreground"
                    aria-label={`${themeLabel(doc, name)} theme actions`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-40" align="start">
                <DropdownMenuItem onClick={() => start({ mode: "duplicate", source: name }, `${name === LIGHT ? "new" : name}-copy`)}>
                  Duplicate
                </DropdownMenuItem>
                {name !== LIGHT ? (
                  <>
                    <DropdownMenuItem onClick={() => start({ mode: "rename", name }, name)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem disabled={movable.indexOf(name) === 0} onClick={() => onDocChange(moveTheme(doc, name, -1))}>
                      Move left
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={movable.indexOf(name) === movable.length - 1}
                      onClick={() => onDocChange(moveTheme(doc, name, 1))}
                    >
                      Move right
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => remove(name)}>
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <button
          type="button"
          title="Add a theme"
          aria-label="Add a theme"
          className="rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => start({ mode: "add" }, "")}
        >
          <PlusIcon className="size-3" />
        </button>
      </div>
      {editing ? (
        <form
          className="mt-1.5 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
        >
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null)
            }}
            placeholder={editing.mode === "rename" ? "new-name" : "theme-name"}
            aria-label={editing.mode === "rename" ? "New theme name" : "Theme name"}
            className="h-7 w-32 px-1.5 text-xs md:text-xs"
          />
          <button type="submit" className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70">
            {editing.mode === "add" ? "Add" : editing.mode === "rename" ? "Rename" : "Duplicate"}
          </button>
          <button type="button" className="px-1 text-[10px] text-muted-foreground" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
        </form>
      ) : null}
    </div>
  )
}
