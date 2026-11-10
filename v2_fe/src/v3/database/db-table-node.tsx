/// One table on the schema map (database.html's tf-db-table): the model's name
/// in its group's colour, then one row per field with PK / FK markers, type,
/// optional `?` and a lock on fields a person changed. Every row carries its
/// own connection points, so a relation is drawn column to column: from the
/// foreign-key field on the right edge to the target's key on its left edge.
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { LockIcon } from "lucide-react"

import type { DbModel } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { isJoinModel, sourceHandle, TABLE_W, targetHandle } from "./db-graph"

export type TableNodeData = {
  model: DbModel
  dot: string
  faded: boolean
  selected: boolean
}

const HANDLE = "!size-2 !min-w-0 !rounded-full !border !border-background !bg-muted-foreground/70"

export function DbTableNode({ data }: NodeProps) {
  const { model, dot, faded, selected } = data as unknown as TableNodeData
  return (
    <div
      style={{ width: TABLE_W }}
      className={cn("rounded-lg border bg-card text-xs shadow-sm transition-opacity", selected && "ring-2 ring-ring", faded && "opacity-35")}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className={cn("size-2 rounded-full", dot)} />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{model.name}</span>
        {isJoinModel(model) ? (
          <span className="rounded border border-border px-1 text-[10px] font-medium text-muted-foreground" title="A join table: it links two models many-to-many">
            join · M:N
          </span>
        ) : null}
        {model.samples?.length ? (
          <span className="text-muted-foreground">
            {model.samples.length} sample {model.samples.length === 1 ? "row" : "rows"}
          </span>
        ) : null}
      </div>
      <ul>
        {model.fields.map((f) => (
          <li key={f.name} className="relative flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
            <Handle id={targetHandle(f.name, "l")} type="target" position={Position.Left} className={HANDLE} isConnectable={false} />
            <Handle id={sourceHandle(f.name, "l")} type="source" position={Position.Left} className={HANDLE} isConnectable={false} />
            <span className="w-5 shrink-0 text-[10px] font-semibold text-muted-foreground">
              {f.primary_key ? "PK" : f.type === "fk" ? <span className="text-link">FK</span> : ""}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
            {f.locked_by_user ? <LockIcon className="size-3 text-muted-foreground" aria-label="Changed by a person" /> : null}
            <span className={cn("max-w-[45%] truncate font-mono", f.type === "fk" ? "text-link" : "text-muted-foreground")}>
              {f.type === "fk" ? f.fk?.model : f.type === "enum" ? `enum(${f.values?.length ?? 0})` : f.type}
              {f.optional ? "?" : ""}
            </span>
            <Handle id={sourceHandle(f.name, "r")} type="source" position={Position.Right} className={HANDLE} isConnectable={false} />
            <Handle id={targetHandle(f.name, "r")} type="target" position={Position.Right} className={HANDLE} isConnectable={false} />
          </li>
        ))}
      </ul>
    </div>
  )
}
