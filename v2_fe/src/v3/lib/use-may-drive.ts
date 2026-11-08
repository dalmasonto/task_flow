/// May the viewer drive an agent: answer its permission prompts and type into
/// its terminal? The server's rule (#1127 `may_drive_agent`, the same as for
/// its keys): an active owner/admin of its project, the human who linked it
/// (still an active member), or a superuser. Answers for agents of the active
/// project; an agent it can't see answers `null` (unknown), so a caller can
/// leave the control on and let the server decide.
import { useCallback } from "react"

import { mayManageKeys } from "../api-keys/api-keys-logic"
import { myMembership } from "../invites/invites-logic"
import { useWorkspace } from "../workspace"

export function useMayDrive(): (agentId: number) => boolean | null {
  const { live, currentUser } = useWorkspace()
  const agents = live?.agents
  const members = live?.members
  return useCallback(
    (agentId: number) => {
      const agent = agents?.find((a) => a.id === agentId)
      if (!agent) return null
      return mayManageKeys(agent, myMembership(members ?? [], currentUser?.id), !!currentUser?.is_superuser)
    },
    [agents, members, currentUser],
  )
}
