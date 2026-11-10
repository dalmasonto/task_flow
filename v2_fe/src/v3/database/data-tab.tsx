/// The Data tab (#885): a model's sample rows, editable inline. Cells are typed
/// by the field: numbers and booleans are parsed back, everything else is text.
/// Saving writes the rows into the schema as the next version.

import { useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DbModel } from "@/lib/db-api"

import { parseCell } from "./db-cells"

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

export function DataTab({
  model,
  busy,
  onSave,
}: {
  model: DbModel
  busy: boolean
  onSave: (rows: Record<string, unknown>[]) => void
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>(() => structuredClone(model.samples ?? []))
  const dirty = JSON.stringify(rows) !== JSON.stringify(model.samples ?? [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
            <tr className="border-b">
              {model.fields.map((f) => (
                <th key={f.name} className="px-3 py-2 font-medium">
                  <span className="font-mono">{f.name}</span>
                  <span className="ml-1 font-mono font-normal opacity-70">{f.type === "fk" ? f.fk?.model : f.type}</span>
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, r) => (
              <tr key={r} className="hover:bg-muted/40">
                {model.fields.map((f) => (
                  <td key={f.name} className="px-1 py-0.5">
                    {f.type === "enum" ? (
                      <Select
                        items={Object.fromEntries((f.values ?? []).map((v) => [v, v]))}
                        value={cellText(row[f.name]) || null}
                        onValueChange={(v) => setRows(rows.map((x, i) => (i === r ? { ...x, [f.name]: (v as string | null) ?? "" } : x)))}
                      >
                        <SelectTrigger aria-label={`${f.name}, row ${r + 1}`} className="h-8 w-full min-w-28 border-transparent bg-transparent font-mono text-xs shadow-none hover:border-border">
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          {(f.values ?? []).map((v) => (
                            <SelectItem key={v} value={v} className="font-mono text-xs">
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <input
                        aria-label={`${f.name}, row ${r + 1}`}
                        className="h-8 w-full min-w-24 rounded border border-transparent bg-transparent px-2 font-mono text-xs outline-none hover:border-border focus:border-ring"
                        value={cellText(row[f.name])}
                        onChange={(e) =>
                          setRows(rows.map((x, i) => (i === r ? { ...x, [f.name]: parseCell(f, e.target.value) } : x)))
                        }
                      />
                    )}
                  </td>
                ))}
                <td className="px-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove row ${r + 1}`} onClick={() => setRows(rows.filter((_, i) => i !== r))}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No sample rows for {model.name} yet. Add some, or ask an agent to write them.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t p-3">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setRows([...rows, {}])}>
          <PlusIcon className="size-4" />
          Add row
        </Button>
        <span className="text-xs text-muted-foreground">{rows.length} of 50 rows</span>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={!dirty || busy} onClick={() => setRows(structuredClone(model.samples ?? []))}>
          Discard
        </Button>
        <Button size="sm" disabled={!dirty || busy} onClick={() => onSave(rows)}>
          Save rows
        </Button>
      </div>
    </div>
  )
}
