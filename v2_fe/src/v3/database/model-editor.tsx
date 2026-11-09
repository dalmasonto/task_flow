/// The model editor (#885): one model's fields, compact — name and type on each
/// row, everything else behind an expand, flags as checkboxes. A field a person
/// changed shows a lock (agents need their OK to change it); every field shows
/// who wrote it. One primary action: Save as the next version.

import { useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, LockIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DB_FIELD_TYPES, type DbField, type DbModel, type DbSchemaDoc } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { toneFor } from "./db-graph"

const FLAGS: Array<[keyof DbField, string]> = [
  ["optional", "Optional"],
  ["unique", "Unique"],
  ["indexed", "Indexed"],
  ["primary_key", "Primary key"],
]

function authorDot(f: DbField) {
  if (f.locked_by_user) return <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Changed by a person: locked" />
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", f.written_by?.kind === "agent" ? "bg-muted-foreground" : "bg-amber-500")}
      title={f.written_by ? `Written by ${f.written_by.label}` : "Not saved yet"}
    />
  )
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
}) {
  const [draft, setDraft] = useState<DbModel>(() => structuredClone(model))
  const [open, setOpen] = useState<number | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(model)
  const others = doc.models.map((m) => m.name).filter((n) => n !== model.name)

  const setField = (i: number, patch: Partial<DbField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-sm", toneFor(doc, draft.group).dot)} />
          <Input
            aria-label="Model name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-8 font-mono text-sm font-semibold"
          />
          {/* Save sits up here, next to the name: the bottom-right corner is
              where the app's floating chat dock and session pill live. */}
          <Button
            size="sm"
            className="shrink-0"
            disabled={(!dirty && !isNew) || busy}
            onClick={() => onSave(draft, isNew ? undefined : model.name)}
          >
            Save v{version + 1}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close the editor" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
        <Input
          aria-label="Group"
          placeholder="Group (colours the diagram)"
          value={draft.group ?? ""}
          onChange={(e) => setDraft({ ...draft, group: e.target.value || undefined })}
          className="h-7 text-xs"
        />
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-muted-foreground" />Written by an agent</span>
          <span className="inline-flex items-center gap-1"><LockIcon className="size-3" />Changed by a person (locked)</span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ul className="divide-y rounded-lg border text-sm">
          {draft.fields.map((f, i) => (
            <li key={i} className={cn(open === i && "bg-muted/40")}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
              >
                {authorDot(f)}
                <span className="min-w-0 flex-1 truncate font-mono">{f.name || "(unnamed)"}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {f.type === "fk" ? `→ ${f.fk?.model ?? "?"}` : f.type}
                  {f.optional ? "?" : ""}
                </span>
                {open === i ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              </button>
              {open === i ? (
                <div className="space-y-2.5 px-2.5 pb-3">
                  <div className="flex gap-2">
                    <Input
                      aria-label="Field name"
                      value={f.name}
                      onChange={(e) => setField(i, { name: e.target.value })}
                      className="h-8 font-mono text-sm"
                    />
                    <select
                      aria-label="Type"
                      className="h-8 rounded-md border bg-background px-1.5 font-mono text-xs"
                      value={f.type}
                      onChange={(e) => setField(i, { type: e.target.value })}
                    >
                      {DB_FIELD_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                    {FLAGS.map(([key, label]) => (
                      <label key={key} className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-primary"
                          checked={!!f[key]}
                          onChange={(e) => setField(i, { [key]: e.target.checked } as Partial<DbField>)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  {f.type === "enum" ? (
                    <Input
                      aria-label="Enum values"
                      placeholder="Values, comma separated"
                      value={(f.values ?? []).join(", ")}
                      onChange={(e) =>
                        setField(i, { values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })
                      }
                      className="h-8 font-mono text-xs"
                    />
                  ) : null}
                  {f.type === "fk" ? (
                    <div className="flex gap-2 text-xs">
                      <select
                        aria-label="Points at"
                        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-1.5 font-mono"
                        value={f.fk?.model ?? ""}
                        onChange={(e) => setField(i, { fk: { model: e.target.value, on_delete: f.fk?.on_delete ?? "cascade" } })}
                      >
                        <option value="">Points at…</option>
                        {[...others, draft.name].map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                      <select
                        aria-label="On delete"
                        className="h-8 rounded-md border bg-background px-1.5"
                        value={f.fk?.on_delete ?? "cascade"}
                        onChange={(e) =>
                          setField(i, { fk: { model: f.fk?.model ?? "", on_delete: e.target.value as "cascade" | "set_null" | "restrict" } })
                        }
                      >
                        <option value="cascade">cascade</option>
                        <option value="set_null">set null</option>
                        <option value="restrict">restrict</option>
                      </select>
                    </div>
                  ) : null}
                  <Input
                    aria-label="Default"
                    placeholder="Default (optional)"
                    value={f.default === undefined || f.default === null ? "" : String(f.default)}
                    onChange={(e) => setField(i, { default: e.target.value === "" ? undefined : e.target.value })}
                    className="h-8 font-mono text-xs"
                  />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {f.written_by ? `Last written by ${f.written_by.label}` : "New field"}
                      {f.locked_by_user ? " · agents need your OK to change it" : ""}
                    </span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-destructive hover:underline"
                      onClick={() => {
                        setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))
                        setOpen(null)
                      }}
                    >
                      <Trash2Icon className="size-3" />
                      Remove
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full gap-1.5 border-dashed"
          onClick={() => {
            setDraft((d) => ({ ...d, fields: [...d.fields, { name: "", type: "String" }] }))
            setOpen(draft.fields.length)
          }}
        >
          <PlusIcon className="size-4" />
          Add field
        </Button>
        {!isNew ? (
          <button type="button" className="mt-4 text-xs text-destructive hover:underline" disabled={busy} onClick={onDelete}>
            Delete this model
          </button>
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 border-t p-3">
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
          <p className="text-[11px] text-muted-foreground">
            Saving makes v{version + 1} and locks the fields you changed, so agents ask before changing them.
          </p>
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
