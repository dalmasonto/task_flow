import { useAgentRegistry, usePendingCount, useAgentPendingCount } from '@/hooks/use-agent-messages'
import type { AgentRegistryEntry } from '@/types'

interface AgentSidebarProps {
  selected: string
  onSelect: (name: string) => void
}

export function AgentSidebar({ selected, onSelect }: AgentSidebarProps) {
  const agents = useAgentRegistry()
  const pendingAll = usePendingCount()

  if (!agents) return null

  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const live = agents.filter(a => a.status === 'connected')
  const recent = agents.filter(a => a.status === 'disconnected' && a.disconnectedAt && (now - a.disconnectedAt.getTime()) < DAY_MS)

  return (
    <div className="space-y-4">
      {/* All messages */}
      <button
        onClick={() => onSelect('all')}
        className={`w-full flex items-center gap-3 px-3 py-2 text-xs uppercase tracking-widest font-bold transition-colors border-l-2 ${
          selected === 'all'
            ? 'text-secondary border-secondary'
            : 'text-muted-foreground border-transparent hover:text-foreground'
        }`}
      >
        <span className="material-symbols-outlined text-sm">inbox</span>
        <span className="flex-1 text-left">All</span>
        {pendingAll != null && pendingAll > 0 && (
          <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-1.5 py-0.5 min-w-[1.25rem] text-center">
            {pendingAll}
          </span>
        )}
      </button>

      {/* Live agents */}
      {live.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest px-3 mb-2">Live</div>
          {live.map(a => (
            <AgentItem key={a.name} agent={a} selected={selected === a.name} onSelect={onSelect} />
          ))}
        </div>
      )}

      {/* Recent agents */}
      {recent.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest px-3 mb-2">Recent</div>
          {recent.map(a => (
            <AgentItem key={a.name} agent={a} selected={selected === a.name} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentItem({ agent, selected, onSelect }: { agent: AgentRegistryEntry; selected: boolean; onSelect: (name: string) => void }) {
  const isLive = agent.status === 'connected'
  const pendingCount = useAgentPendingCount(agent.name)

  return (
    <button
      onClick={() => onSelect(agent.name)}
      className={`w-full flex items-center gap-3 px-3 py-2 text-xs uppercase tracking-widest font-bold transition-colors border-l-2 ${
        selected
          ? 'text-secondary border-secondary'
          : 'text-muted-foreground border-transparent hover:text-foreground'
      }`}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        {isLive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#69fd5d] opacity-75" />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${isLive ? 'bg-[#69fd5d]' : 'bg-muted-foreground/30'}`} />
      </span>
      <span className="flex-1 text-left truncate">{agent.name}</span>
      {pendingCount != null && pendingCount > 0 && (
        <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-1.5 py-0.5 min-w-[1.25rem] text-center">
          {pendingCount}
        </span>
      )}
    </button>
  )
}
