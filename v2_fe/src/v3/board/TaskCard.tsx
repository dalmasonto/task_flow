/// A board card (design: tf-task-card). Everything on it is live; fields with
/// no data (lease, live tool, decision) are simply absent until their backends
/// exist, rather than shown empty.
import type { DragEvent } from "react"
import { Link } from "react-router-dom"
import { CalendarIcon, GitBranchIcon, PaperclipIcon, ShieldCheckIcon, TriangleAlertIcon, UserIcon } from "lucide-react"

import type { Priority } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import type { CardInfo } from "./board-logic"

const PRIORITY_LABEL: Record<Priority, string> = { critical: "Critical priority", high: "High priority", normal: "Normal priority", low: "Low priority" }

export function PriorityMark({ priority }: { priority: Priority }) {
  if (priority === "critical") return <TriangleAlertIcon className="size-3.5 text-destructive" aria-label={PRIORITY_LABEL.critical} role="img" />
  const lit = priority === "high" ? 3 : priority === "normal" ? 2 : 1
  return (
    <span className="inline-flex h-3.5 items-end gap-px" role="img" aria-label={PRIORITY_LABEL[priority]}>
      {[1.5, 2.5, 3.5].map((h, i) => (
        <span key={h} className={cn("w-0.5 rounded-sm", i < lit ? "bg-foreground/70" : "bg-foreground/20")} style={{ height: `${h * 4}px` }} />
      ))}
    </span>
  )
}

export function TaskCard({
  card,
  selected,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  card: CardInfo
  selected?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent<HTMLAnchorElement>) => void
  onDragEnd?: () => void
}) {
  const meta = [
    card.repo ? (
      <span key="repo" className="inline-flex items-center gap-1">
        <GitBranchIcon className="size-3" aria-hidden />
        {card.repo}
      </span>
    ) : null,
    card.due ? (
      <span key="due" className={cn("inline-flex items-center gap-1", card.due.overdue && "text-destructive")} title={card.due.overdue ? "Overdue" : "Due"}>
        <CalendarIcon className="size-3" aria-hidden />
        {card.due.label}
      </span>
    ) : null,
    card.files > 0 ? (
      <span key="files" className="inline-flex items-center gap-1" title={`${card.files} ${card.files === 1 ? "file" : "files"}`}>
        <PaperclipIcon className="size-3" aria-hidden />
        {card.files}
      </span>
    ) : null,
  ].filter(Boolean)

  return (
    <Link
      to={`/v3/tasks/${card.id}`}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group block rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "border-ring ring-2 ring-ring/25" : "border-border",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <PriorityMark priority={card.priority} />
        <span className="font-medium tabular-nums">#{card.id}</span>
        <span className="ml-auto">
          {card.assignee ? (
            <ActorAvatar model={card.assignee.isAgent ? card.assignee.model : null} name={card.assignee.name} size="xs" />
          ) : (
            <span className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border" title="Unassigned">
              <UserIcon className="size-3" aria-hidden />
            </span>
          )}
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium leading-5 break-words">{card.title}</p>
      {card.gate ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 shrink-0 text-review" aria-hidden />
          <span className="truncate">Gate: {card.gate}</span>
        </p>
      ) : null}
      {meta.length ? <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div> : null}
    </Link>
  )
}
