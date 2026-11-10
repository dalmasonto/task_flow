/// The Database page's right panel when no model is open: models under their
/// groups (database.html), each group a coloured section managed from its menu
/// (edit, new model in it, delete), each model a row with what it holds and a
/// menu to move it or delete it. Search filters by model or field name.
import { useMemo, useState } from "react"
import { ChevronRightIcon, DatabaseIcon, FolderPlusIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, SearchIcon, TableIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import type { DbModel, DbSchema, DbSchemaDoc } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { timeAgo } from "../lib/time"
import { effectiveGroups, groupTone, type EffectiveGroup } from "./db-groups"
import { isJoinModel } from "./db-graph"
import { matchModels } from "./db-search"

const UNGROUPED = "__ungrouped__"

export function ModelsPanel({
  doc,
  schema,
  selected,
  busy,
  onOpen,
  onNewModel,
  onEditGroup,
  onMoveModel,
  onDeleteModel,
}: {
  doc: DbSchemaDoc
  schema: DbSchema | null
  selected: string | null
  busy: boolean
  onOpen: (name: string) => void
  /// A new model, optionally straight into a group.
  onNewModel: (group?: string) => void
  /// Open the group dialog: a slug to edit, null to create.
  onEditGroup: (slug: string | null) => void
  onMoveModel: (name: string, group: string | undefined) => void
  onDeleteModel: (name: string) => void
}) {
  const now = useLivenessNow()
  const [query, setQuery] = useState("")
  const groups = useMemo(() => effectiveGroups(doc), [doc])
  const shown = useMemo(() => new Set(matchModels(doc, query).map((m) => m.name)), [doc, query])
  const searching = query.trim().length > 0

  const sections: { group: EffectiveGroup | null; models: DbModel[] }[] = [
    ...groups.map((g) => ({ group: g, models: doc.models.filter((m) => m.group === g.slug) })),
    { group: null, models: doc.models.filter((m) => !m.group?.trim()) },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a model or field" aria-label="Find a model or field" className="h-8 pl-8" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" aria-label="Add" title="Add a model or a group" />}>
            <PlusIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => onNewModel()}>
              <TableIcon />
              New model
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEditGroup(null)}>
              <FolderPlusIcon />
              New group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {doc.models.length === 0 && groups.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>No models yet</EmptyTitle>
              <EmptyDescription>Start with a group (an app or area), then add its models.</EmptyDescription>
            </EmptyHeader>
            <div className="flex justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => onEditGroup(null)}>
                <FolderPlusIcon />
                New group
              </Button>
              <Button size="sm" onClick={() => onNewModel()}>
                <PlusIcon />
                New model
              </Button>
            </div>
          </Empty>
        ) : (
          sections.map(({ group, models }) => {
            const visible = models.filter((m) => shown.has(m.name))
            if (group == null && models.length === 0) return null
            if (searching && visible.length === 0) return null
            const slug = group?.slug ?? UNGROUPED
            const tone = groupTone(doc, group?.slug)
            return (
              <Collapsible key={slug} defaultOpen className="group/sec mb-1">
                <div className="group/head flex h-8 items-center gap-1 rounded-md pr-1 hover:bg-muted/50">
                  <CollapsibleTrigger className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[open]/sec:rotate-90" />
                    <span className={cn("size-2.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
                    <span className={cn("min-w-0 truncate font-medium", !group && "text-muted-foreground")}>{group ? group.name : "Ungrouped"}</span>
                    <span className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground">{models.length}</span>
                  </CollapsibleTrigger>
                  {group ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="opacity-60 group-hover/head:opacity-100" aria-label={`${group.name} options`} />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => onEditGroup(group.slug)}>
                          <PencilIcon />
                          Edit group
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onNewModel(group.slug)}>
                          <PlusIcon />
                          New model here
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <CollapsibleContent>
                  {visible.length ? (
                    <ul className="mt-0.5 mb-2 space-y-0.5 pl-3">
                      {visible.map((m) => (
                        <ModelRow
                          key={m.name}
                          model={m}
                          active={selected === m.name}
                          groups={groups}
                          busy={busy}
                          onOpen={() => onOpen(m.name)}
                          onMove={(g) => onMoveModel(m.name, g)}
                          onDelete={() => onDeleteModel(m.name)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <button type="button" onClick={() => onNewModel(group?.slug)} className="mt-0.5 mb-2 ml-3 flex h-8 w-[calc(100%-0.75rem)] items-center gap-2 rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                      <PlusIcon className="size-3.5" />
                      Add a model to {group?.name ?? "this group"}
                    </button>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )
          })
        )}
        {searching && shown.size === 0 && doc.models.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">No model or field matches.</p> : null}
      </div>

      {schema && schema.version > 0 ? (
        <p className="border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
          {doc.models.length} {doc.models.length === 1 ? "model" : "models"} · schema v{schema.version}, saved by {schema.updated_by_label}
          {schema.updated_at ? ` ${timeAgo(schema.updated_at, now)}` : ""}
        </p>
      ) : null}
    </div>
  )
}

function ModelRow({
  model,
  active,
  groups,
  busy,
  onOpen,
  onMove,
  onDelete,
}: {
  model: DbModel
  active: boolean
  groups: EffectiveGroup[]
  busy: boolean
  onOpen: () => void
  onMove: (group: string | undefined) => void
  onDelete: () => void
}) {
  const relations = model.fields.filter((f) => f.type === "fk").length
  return (
    <li className={cn("group/row flex items-center gap-1 rounded-md pr-1", active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")}>
      <button type="button" onClick={onOpen} aria-current={active ? "true" : undefined} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <TableIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{model.name}</span>
        {isJoinModel(model) ? <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">M:N</span> : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={`${model.fields.length} fields, ${relations} relations`}>
          {model.fields.length}
          {relations ? <span className="text-link"> · {relations}→</span> : null}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100" aria-label={`${model.name} options`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={onOpen}>
            <PencilIcon />
            Edit fields
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Group</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={model.group ?? UNGROUPED} onValueChange={(v) => onMove(v === UNGROUPED ? undefined : (v as string))}>
                  {groups.map((g) => (
                    <DropdownMenuRadioItem key={g.slug} value={g.slug}>
                      <span className={cn("size-2 rounded-full", groupTone({ groups, models: [] }, g.slug).dot)} aria-hidden />
                      {g.name}
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value={UNGROUPED}>Ungrouped</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={busy} onClick={onDelete}>
            <Trash2Icon />
            Delete model
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
