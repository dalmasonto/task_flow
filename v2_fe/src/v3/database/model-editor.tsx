/// The model editor (database--model.html): one model's name and group, its
/// fields (name and type on each row, the rest behind an expand), and its
/// relations both ways. Every choice is a shadcn Select / menu, never a typed
/// label: groups come from the group dialog, relation targets from the models.
/// A field a person changed shows a lock; Save makes the next version.
import { useState } from "react"
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, FolderPlusIcon, LinkIcon, LockIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DB_FIELD_TYPES, type DbField, type DbModel, type DbSchemaDoc } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { suggestedTarget } from "./db-graph"
import { addRelation, effectiveGroups, groupTone, type RelationKind } from "./db-groups"

const FLAGS: Array<[keyof DbField, string]> = [
  ["optional", "Optional"],
  ["unique", "Unique"],
  ["indexed", "Indexed"],
  ["primary_key", "Primary key"],
]

const TYPE_LABELS: Record<string, string> = Object.fromEntries(DB_FIELD_TYPES.map((t) => [t, t === "fk" ? "relation" : t]))
const ON_DELETE: Record<string, string> = { cascade: "Cascade", set_null: "Set null", restrict: "Restrict" }
const UNGROUPED = "__ungrouped__"
const KINDS: { kind: RelationKind; label: string; hint: string }[] = [
  { kind: "many-to-one", label: "Many-to-one", hint: "N:1, adds a field here" },
  { kind: "one-to-one", label: "One-to-one", hint: "1:1, a unique field here" },
  { kind: "many-to-many", label: "Many-to-many", hint: "M:N, creates a join model" },
]

function AuthorMark({ f }: { f: DbField }) {
  if (f.locked_by_user) return <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Changed by a person: locked" />
  return <span className={cn("size-1.5 shrink-0 rounded-full", f.written_by?.kind === "agent" ? "bg-muted-foreground" : "bg-blocked")} title={f.written_by ? `Written by ${f.written_by.label}` : "Not saved yet"} />
}

function fieldSummary(f: DbField): string {
  const t = f.type === "fk" ? `→ ${f.fk?.model || "?"}` : f.type === "enum" ? `enum(${f.values?.length ?? 0})` : f.type
  return `${t}${f.optional ? "?" : ""}`
}

export function ModelEditor({
  doc,
  model,
  isNew,
  version,
  busy,
  error,
  onSave,
  onDelete,
  onClose,
  onNewGroup,
  onCreateJoin,
}: {
  doc: DbSchemaDoc
  model: DbModel
  isNew: boolean
  version: number
  busy: boolean
  error: { message: string; errors: string[]; stale: boolean } | null
  onSave: (model: DbModel, previousName: string | undefined) => void
  onDelete: () => void
  onClose: () => void
  /// Open the group dialog to create a group.
  onNewGroup: () => void
  /// Create the join model for a many-to-many (saved as its own version).
  onCreateJoin: (target: string) => void
}) {
  const [draft, setDraft] = useState<DbModel>(() => structuredClone(model))
  const [open, setOpen] = useState<number | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(model)
  const others = doc.models.map((m) => m.name).filter((n) => n !== model.name)
  const targets = [...others, draft.name]
  const groups = effectiveGroups(doc)
  const groupItems: Record<string, string> = { [UNGROUPED]: "Ungrouped", ...Object.fromEntries(groups.map((g) => [g.slug, g.name])) }
  const targetItems: Record<string, string> = Object.fromEntries(targets.map((n) => [n, n === draft.name ? `${n} (itself)` : n]))

  const belongsTo = draft.fields.filter((f) => f.type === "fk" && f.fk?.model)
  const hasMany = doc.models.flatMap((m) => (m.name === model.name ? [] : m.fields.filter((f) => f.type === "fk" && f.fk?.model === model.name).map((f) => ({ model: m.name, field: f.name, unique: !!f.unique }))))

  const setField = (i: number, patch: Partial<DbField>) => setDraft((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }))

  const relate = (target: string, kind: RelationKind) => {
    if (kind === "many-to-many") return onCreateJoin(target)
    // Add the field to the draft (saved with the model), by the same rule the
    // page uses, on a document holding this draft.
    const { doc: next, added } = addRelation({ models: [draft, ...doc.models.filter((m) => m.name !== draft.name)] }, draft.name, target, kind)
    const updated = next.models.find((m) => m.name === draft.name)
    if (!updated) return
    setDraft(updated)
    setOpen(updated.fields.findIndex((f) => f.name === added.field))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2.5 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <span className={cn("size-2.5 shrink-0 rounded-full", groupTone(doc, draft.group).dot)} aria-hidden />
          <Input aria-label="Model name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-8 font-mono text-sm font-semibold" />
          <Button size="sm" className="shrink-0" disabled={(!dirty && !isNew) || busy} onClick={() => onSave(draft, isNew ? undefined : model.name)}>
            {isNew ? "Create" : `Save v${version + 1}`}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close the editor" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Select items={groupItems} value={draft.group && groupItems[draft.group] ? draft.group : UNGROUPED} onValueChange={(v) => setDraft({ ...draft, group: !v || v === UNGROUPED ? undefined : (v as string) })}>
            <SelectTrigger aria-label="Group" className="h-8 min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g.slug} value={g.slug}>
                  <span className={cn("size-2 rounded-full", groupTone(doc, g.slug).dot)} aria-hidden />
                  {g.name}
                </SelectItem>
              ))}
              <SelectItem value={UNGROUPED}>Ungrouped</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon-sm" aria-label="New group" title="New group" onClick={onNewGroup}>
            <FolderPlusIcon />
          </Button>
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
            Written by an agent
          </span>
          <span className="inline-flex items-center gap-1">
            <LockIcon className="size-3" />
            Changed by a person (agents ask first)
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
          Fields <span className="tabular-nums">{draft.fields.length}</span>
        </h3>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
          {draft.fields.map((f, i) => (
            <li key={i} className={cn(open === i && "bg-muted/40")}>
              <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/40" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <AuthorMark f={f} />
                <span className="w-6 shrink-0 text-[10px] font-semibold text-muted-foreground">{f.primary_key ? "PK" : f.type === "fk" ? <span className="text-link">FK</span> : ""}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{f.name || "(unnamed)"}</span>
                <span className={cn("font-mono text-xs", f.type === "fk" ? "text-link" : "text-muted-foreground")}>{fieldSummary(f)}</span>
                {open === i ? <ChevronDownIcon className="size-3.5 text-muted-foreground" /> : <ChevronRightIcon className="size-3.5 text-muted-foreground" />}
              </button>
              {open === i ? (
                <div className="space-y-3 px-2.5 pt-1 pb-3">
                  <div className="flex gap-2">
                    <Input aria-label="Field name" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} className="h-8 font-mono text-sm" />
                    <Select items={TYPE_LABELS} value={f.type} onValueChange={(v) => v && setField(i, { type: v as string, ...(v === "fk" && !f.fk ? { fk: { model: "", on_delete: "cascade" as const } } : {}) })}>
                      <SelectTrigger aria-label="Type" className="h-8 w-32 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DB_FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="font-mono text-xs">
                            {TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {f.type === "fk" ? (
                    <div className="flex gap-2">
                      <Select items={targetItems} value={f.fk?.model || null} onValueChange={(v) => v && setField(i, { fk: { model: v as string, on_delete: f.fk?.on_delete ?? "cascade" } })}>
                        <SelectTrigger aria-label="Points at" className="h-8 min-w-0 flex-1 font-mono text-xs">
                          <SelectValue placeholder="Points at… (required)" />
                        </SelectTrigger>
                        <SelectContent>
                          {targets.map((n) => (
                            <SelectItem key={n} value={n} className="font-mono text-xs">
                              {targetItems[n]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select items={ON_DELETE} value={f.fk?.on_delete ?? "cascade"} onValueChange={(v) => v && setField(i, { fk: { model: f.fk?.model ?? "", on_delete: v as "cascade" | "set_null" | "restrict" } })}>
                        <SelectTrigger aria-label="On delete" className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(ON_DELETE).map(([v, l]) => (
                            <SelectItem key={v} value={v} className="text-xs">
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  {f.type === "i64" && !f.primary_key && targets.length ? (
                    <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-xs">
                      <LinkIcon className="size-3.5 shrink-0 text-link" />
                      <span className="min-w-0 flex-1">{suggestedTarget(doc, f) ? `Looks like a link to ${suggestedTarget(doc, f)}.` : "Points at another model?"}</span>
                      <Select items={targetItems} value={null} onValueChange={(v) => v && setField(i, { type: "fk", fk: { model: v as string, on_delete: f.optional ? "set_null" : "cascade" } })}>
                        <SelectTrigger aria-label="Make it a relation to" className="h-7 text-xs">
                          <SelectValue placeholder="Make it a relation" />
                        </SelectTrigger>
                        <SelectContent>
                          {targets.map((n) => (
                            <SelectItem key={n} value={n} className="font-mono text-xs">
                              {targetItems[n]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                    {FLAGS.map(([key, label]) => (
                      <label key={key} className="inline-flex items-center gap-1.5">
                        <Checkbox checked={!!f[key]} onCheckedChange={(c) => setField(i, { [key]: c === true } as Partial<DbField>)} />
                        {label}
                      </label>
                    ))}
                  </div>

                  {f.type === "enum" ? (
                    <Input aria-label="Enum values" placeholder="Values, comma separated" value={(f.values ?? []).join(", ")} onChange={(e) => setField(i, { values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} className="h-8 font-mono text-xs" />
                  ) : null}
                  <Input aria-label="Default" placeholder="Default (optional)" value={f.default === undefined || f.default === null ? "" : String(f.default)} onChange={(e) => setField(i, { default: e.target.value === "" ? undefined : e.target.value })} className="h-8 font-mono text-xs" />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {f.written_by ? `Last written by ${f.written_by.label}` : "New field"}
                      {f.locked_by_user ? ", agents need your OK to change it" : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))
                        setOpen(null)
                      }}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full border-dashed"
          onClick={() => {
            setDraft((d) => ({ ...d, fields: [...d.fields, { name: "", type: "String" }] }))
            setOpen(draft.fields.length)
          }}
        >
          <PlusIcon />
          Add field
        </Button>

        <section className="mt-6" aria-labelledby="relations">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="relations" className="text-xs font-medium text-muted-foreground">
              Relations
            </h3>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="xs" disabled={!targets.length} />}>
                <ArrowRightIcon />
                Add relation
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{draft.name || "This model"} relates to…</DropdownMenuLabel>
                  {KINDS.map((k) => (
                    <DropdownMenuSub key={k.kind}>
                      <DropdownMenuSubTrigger>
                        <span className="grid">
                          <span>{k.label}</span>
                          <span className="text-[11px] text-muted-foreground">{k.hint}</span>
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                        {targets.map((n) => (
                          <DropdownMenuItem key={n} className="font-mono text-xs" disabled={k.kind === "many-to-many" && (dirty || isNew)} onClick={() => relate(n, k.kind)}>
                            <span className={cn("size-2 rounded-full", groupTone(doc, doc.models.find((m) => m.name === n)?.group).dot)} aria-hidden />
                            {targetItems[n]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuGroup>
                {dirty || isNew ? <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">Save this model first to add a many-to-many.</p> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {belongsTo.length || hasMany.length ? (
            <ul className="space-y-1.5 rounded-lg border border-border p-2.5 text-xs">
              {belongsTo.map((f) => (
                <li key={`b:${f.name}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-muted px-1 font-mono text-[10px]">{f.unique ? "1:1" : "N:1"}</span>
                  <span className="text-muted-foreground">{f.unique ? "has one" : "belongs to"}</span>
                  <span className="font-mono font-medium">{f.fk!.model}</span>
                  <span className="text-muted-foreground">via</span>
                  <span className="font-mono">{f.name}</span>
                </li>
              ))}
              {hasMany.map((r) => (
                <li key={`h:${r.model}.${r.field}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-muted px-1 font-mono text-[10px]">{r.unique ? "1:1" : "1:N"}</span>
                  <span className="text-muted-foreground">{r.unique ? "has one" : "has many"}</span>
                  <span className="font-mono font-medium">{r.model}</span>
                  <span className="text-muted-foreground">via</span>
                  <span className="font-mono">{r.field}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">No relations yet. Add one above; the map draws it as an arrow.</p>
          )}
        </section>

        {!isNew ? (
          <Button variant="ghost" size="sm" className="mt-6 text-destructive hover:text-destructive" disabled={busy} onClick={onDelete}>
            <Trash2Icon />
            Delete this model
          </Button>
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 border-t border-border p-3">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            <p className="font-medium text-destructive">{error.stale ? "Changed since you opened it" : "Not saved"}</p>
            {error.errors.length ? (
              <ul className="mt-1 list-disc pl-4">
                {error.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1">{error.message}</p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Saving makes v{version + 1} and locks the fields you changed, so agents ask before changing them.</p>
        )}
        {dirty ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(structuredClone(model))}>
            Discard changes
          </Button>
        ) : null}
      </div>
    </div>
  )
}
