/// One task as a full page (design: task.html), at /v3/tasks/:id. The body is
/// TaskDetail, shared with the right-hand detail sheet.
import { useNavigate, useParams } from "react-router-dom"

import { V3Shell } from "../shell/V3Shell"
import { TaskDetail } from "./TaskDetail"

export function TaskPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  return (
    <TaskDetail
      id={id}
      onDeleted={() => navigate("/v3/board", { replace: true })}
      frame={(title, actions, body) => (
        <V3Shell title={title} actions={actions}>
          {body}
        </V3Shell>
      )}
    />
  )
}
