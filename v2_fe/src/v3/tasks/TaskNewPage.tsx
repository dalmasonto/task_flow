/// Create a task as a full page (design: task-new.html), at /v3/tasks/new.
/// The form is TaskNewForm, shared with the right-hand detail sheet.
import { useNavigate, useSearchParams } from "react-router-dom"


import { normalizeStatus } from "../lib/task-status"
import { V3Shell } from "../shell/V3Shell"
import { TaskNewForm } from "./TaskNewForm"

export function TaskNewPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const status = normalizeStatus(params.get("status")) ?? "not_started"
  return (
    <V3Shell title="New task">
      <TaskNewForm status={status} column={params.get("column") || null} onCreated={(id) => navigate(`/v3/tasks/${id}`, { replace: true })} onCancel={() => navigate(-1)} />
    </V3Shell>
  )
}
