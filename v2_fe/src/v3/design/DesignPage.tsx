/// The design workspace in v3 (group 3). The engine (canvas, live frames,
/// comments, pages, tokens, components, versions) is v2's, kept whole: it is
/// ~7.7k lines of tested behaviour, and rewriting it would only add risk. v3
/// gives it the new shell and tokens; its chrome inherits the v3 look through
/// the shared token names.
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { DesignSurfacePage } from "@/pages/design/DesignSurfacePage"

import { V3Shell } from "../shell/V3Shell"
import { seedTaskFrom } from "../tasks/task-seed"
import { useWorkspace } from "../workspace"

export function DesignPage() {
  const navigate = useNavigate()
  const { activeProject, live, currentUser, applyLiveUpdate, reloadLive } = useWorkspace()
  return (
    <V3Shell title="Design" flush>
      <div className="flex h-full min-h-0 flex-col">
        <DesignSurfacePage
          projectId={live ? live.project.id : null}
          project={activeProject}
          liveWorkspace={live}
          currentUser={currentUser}
          onWorkspaceUpdate={applyLiveUpdate}
          onRefreshWorkspace={reloadLive}
          onComposeTask={(body) => {
            if (!seedTaskFrom(body)) {
              toast.error("Couldn't turn that into a task", { description: "It had no text to use as a title." })
              return
            }
            navigate("/v3/tasks/new")
          }}
          onOpenBoard={() => navigate("/v3/board")}
        />
      </div>
    </V3Shell>
  )
}
