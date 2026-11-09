/// One table on the Database diagram (#885): the model's name in its group's
/// colour, then one row per field (PK / FK markers, type, optional `?`, a lock
/// on the fields a person changed). Faded when it is unrelated to the model
/// open in the editor.

import { Handle, Position, type NodeProps } from "@xyflow/react"
import { LockIcon } from "lucide-react"

import type { DbModel } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { TABLE_W } from "./db-graph"

export type TableNodeData = {
  model: DbModel
  dot: string
  faded: boolean
  selected: boolean
}

export function DbTableNode({ data }: NodeProps) {
  const { model, dot, faded, selected } = data as unknown as TableNodeData
  return (
    <div
      style={{ width: TABLE_W }}
      className={cn(
        "overflow-hidden rounded-lg border bg-card text-xs shadow-sm transition-opacity",
        selected && "ring-2 ring-ring",
        faded && "opacity-35",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className={cn("size-2 rounded-full", dot)} />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{model.name}</span>
        {model.samples?.length ? <span className="text-muted-foreground">{model.samples.length} sample {model.samples.length === 1 ? "row" : "rows"}</span> : null}
      </div>
      <ul>
        {model.fields.map((f) => (
          <li key={f.name} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
            <span className="w-5 shrink-0 text-[10px] font-semibold text-muted-foreground">
              {f.primary_key ? "PK" : f.type === "fk" ? <span className="text-link">FK</span> : ""}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
            {f.locked_by_user ? <LockIcon className="size-3 text-muted-foreground" aria-label="Changed by a person" /> : null}
            <span className="max-w-[45%] truncate font-mono text-muted-foreground">
              {f.type === "fk" ? f.fk?.model : f.type === "enum" ? `enum(${f.values?.length ?? 0})` : f.type}
              {f.optional ? "?" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
