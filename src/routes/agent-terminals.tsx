import { useRef, useEffect } from 'react'
import { useLiveAgents } from '@/hooks/use-agent-messages'
import { useSetting } from '@/hooks/use-settings'
import { TerminalControl } from '@/components/inbox/terminal-control'
import type { AgentRegistryEntry } from '@/types'

const DEFAULT_TERMINAL_WIDTH = 420

export default function AgentTerminals() {
  const liveAgents = useLiveAgents()
  const port = Number(useSetting('serverPort'))
  const terminalWidth = Number(useSetting('terminalWidth')) || DEFAULT_TERMINAL_WIDTH
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to an agent that just started awaiting input
  const awaitingAgent = liveAgents?.find(a => a.awaitingInput)
  useEffect(() => {
    if (!awaitingAgent || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-agent="${awaitingAgent.name}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center' })
  }, [awaitingAgent?.name])

  return (
    <div className="flex flex-col -mt-4 -mb-4" style={{ height: 'calc(100vh - 4rem - var(--timer-bar-height, 0px))' }}>
      {/* Header */}
      <div className="shrink-0 h-[60px] px-6 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-secondary">terminal</span>
          <h1 className="text-sm font-bold uppercase tracking-widest">Agent Terminals</h1>
          {liveAgents && (
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              {liveAgents.length} active
            </span>
          )}
        </div>
      </div>

      {/* Terminal cards — horizontal scroll */}
      {!liveAgents || liveAgents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <span className="material-symbols-outlined text-5xl text-muted-foreground/20 mb-3">terminal</span>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            No active agents
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Start a Claude session in tmux to see its terminal here
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden gap-0"
        >
          {liveAgents.map((agent) => (
            <TerminalCard
              key={agent.name}
              agent={agent}
              port={port}
              width={terminalWidth}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TerminalCard({ agent, port, width }: { agent: AgentRegistryEntry; port: number; width: number }) {
  return (
    <div
      data-agent={agent.name}
      className="shrink-0 border-r border-border flex flex-col h-full"
      style={{ width }}
    >
      <TerminalControl agentName={agent.name} port={port} />
    </div>
  )
}
