/// A link to a task that opens it in the right-hand detail sheet over the
/// current page (#5907 item 2). On the full task page it goes to the other
/// task's page instead. A drop-in for <Link to={`/v3/tasks/${id}`}>.
import type { ComponentProps } from "react"
import { Link, useLocation } from "react-router-dom"

import type { ColumnId } from "@/lib/workspace-view"

import { detailHref } from "../lib/detail-params"

export function TaskLink({ task, ...props }: { task: string | number } & Omit<ComponentProps<typeof Link>, "to">) {
  const { pathname, search } = useLocation()
  return <Link to={detailHref(pathname, search, { kind: "task", id: String(task) })} {...props} />
}

/// A link to the new-task form in the detail sheet, optionally in a column.
export function NewTaskLink({ status = "not_started", ...props }: { status?: ColumnId } & Omit<ComponentProps<typeof Link>, "to">) {
  const { pathname, search } = useLocation()
  return <Link to={detailHref(pathname, search, { kind: "new-task", status })} {...props} />
}
