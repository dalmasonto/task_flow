/// One agent's live terminal: the mirrored transcript, and the keypad for
/// people who may drive it (#1127: the project's owners/admins and the human
/// who linked it; everyone else watches). Shared by the agent page and the
/// right-hand detail sheet (#5907 item 14), which opens from anywhere with
/// `?terminal=<agent id>`.
import { TerminalKeypad, TerminalTranscript, TerminalWatchOnly } from "@/components/chat/terminal"
import { Badge } from "@/components/ui/badge"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { mapLiveTerminalSessions } from "@/lib/live-mappers"
import { cn } from "@/lib/utils"

import { mayManageKeys } from "../api-keys/api-keys-logic"
import { myMembership } from "../invites/invites-logic"
import { useWorkspace } from "../workspace"
import { useAgentSlices } from "./use-agent-slices"

export function AgentTerminal({ agentId, tall = false }: { agentId: number; tall?: boolean }) {
  // Frames and sessions are chat-surface slices; make sure they load.
  useAgentSlices()
  const { live, currentUser } = useWorkspace()
  const now = useLivenessNow()
  const agent = live?.agents.find((a) => a.id === agentId)
  const sessions = live ? mapLiveTerminalSessions(live, now) : []
  const term = sessions.find((t) => t.agentId === agentId && t.hasStream) ?? sessions.find((t) => t.agentId === agentId)

  if (!term) {
    return <p className="text-sm text-muted-foreground">No terminal mirror yet. It appears when the agent runs inside tmux with TaskFlow connected.</p>
  }
  const mayDrive = agent ? mayManageKeys(agent, myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser) : false
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate font-mono">{term.cwd || term.agent}</span>
        <Badge variant="outline">{term.connected ? "Connected" : "Not connected"}</Badge>
      </div>
      <div className={cn("overflow-hidden rounded-lg border border-border bg-muted/30", tall ? "max-h-[60svh]" : "max-h-[28rem]")}>
        <TerminalTranscript session={term} />
      </div>
      {mayDrive ? <TerminalKeypad agentId={agentId} disabled={!term.connected} /> : <TerminalWatchOnly />}
    </div>
  )
}
