import { useState } from 'react'
import { useAgentMessages, respondToMessage } from '@/hooks/use-agent-messages'
import { useProjects } from '@/hooks/use-projects'
import { useSetting } from '@/hooks/use-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProjectFilter } from '@/components/charts/project-filter'
import type { AgentMessage } from '@/types'

export default function AgentInbox() {
  const messages = useAgentMessages()
  const projects = useProjects()
  const port = Number(useSetting('serverPort'))
  const [projectFilter, setProjectFilter] = useState('all')

  if (!messages || !projects) return null

  const projectMap = new Map(projects.map(p => [p.id!, p]))

  const filtered = projectFilter === 'all'
    ? messages
    : messages.filter(m => m.projectId === Number(projectFilter))

  const pending = filtered.filter(m => m.status === 'pending')
  const answered = filtered.filter(m => m.status === 'answered')

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              {pending.length > 0 && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${pending.length > 0 ? 'bg-secondary' : 'bg-muted-foreground/30'}`} />
            </span>
            <span className="text-xs tracking-widest uppercase text-secondary font-bold">
              Agent Comms
            </span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tighter uppercase leading-none">
            Agent <span className="text-secondary">Inbox</span>
          </h1>
          <p className="text-xs text-muted-foreground uppercase tracking-widest mt-2">
            {pending.length} pending {pending.length === 1 ? 'question' : 'questions'}
          </p>
        </div>
        <ProjectFilter value={projectFilter} onChange={setProjectFilter} />
      </div>

      {/* Pending Questions */}
      {pending.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xs tracking-widest uppercase font-bold text-secondary flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">pending</span>
            Awaiting Response
          </h2>
          {pending.map(m => (
            <MessageCard key={m.id} message={m} project={projectMap.get(m.projectId)} port={port} />
          ))}
        </section>
      )}

      {/* Answered */}
      {answered.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xs tracking-widest uppercase font-bold text-muted-foreground flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Answered
          </h2>
          {answered.map(m => (
            <AnsweredCard key={m.id} message={m} project={projectMap.get(m.projectId)} />
          ))}
        </section>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-4 block">inbox</span>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            No agent questions yet
          </p>
        </div>
      )}
    </div>
  )
}

function MessageCard({
  message,
  project,
  port,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
  port: number
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const handleRespond = async (response: string) => {
    if (!response.trim() || !message.id) return
    setSending(true)
    try {
      await respondToMessage(message.id, response.trim(), port)
    } catch (err) {
      console.error('Failed to respond:', err)
    } finally {
      setSending(false)
      setInput('')
    }
  }

  const timeAgo = getTimeAgo(message.createdAt)

  return (
    <div className="bg-card border border-secondary/20 shadow-[0_0_15px_rgba(222,142,255,0.05)] p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {project && (
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 border" style={{ borderColor: project.color, color: project.color }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: project.color }} />
              {project.name}
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">{timeAgo}</span>
      </div>

      {/* Context (markdown rendered as pre-formatted for now) */}
      {message.context && (
        <div className="bg-muted/50 border border-border p-4 text-sm whitespace-pre-wrap font-mono text-muted-foreground max-h-64 overflow-y-auto">
          {message.context}
        </div>
      )}

      {/* Question */}
      <p className="text-lg font-bold">{message.question}</p>

      {/* Choice buttons */}
      {message.choices && message.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.choices.map((choice) => (
            <Button
              key={choice}
              variant="outline"
              disabled={sending}
              className="uppercase tracking-widest text-xs font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary"
              onClick={() => handleRespond(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {/* Free-text input */}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleRespond(input) }}
          placeholder="Type a response..."
          disabled={sending}
          className="bg-muted/30 border-border text-sm"
        />
        <Button
          onClick={() => handleRespond(input)}
          disabled={sending || !input.trim()}
          className="uppercase tracking-widest text-xs font-bold"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}

function AnsweredCard({
  message,
  project,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="bg-card border border-border p-4 cursor-pointer hover:border-muted-foreground/30 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {project && (
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
          )}
          <span className="text-sm font-bold truncate">{message.question}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {getTimeAgo(message.createdAt)}
          </span>
          <span className="material-symbols-outlined text-sm text-muted-foreground">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {message.context && (
            <div className="bg-muted/50 border border-border p-3 text-xs whitespace-pre-wrap font-mono text-muted-foreground max-h-48 overflow-y-auto">
              {message.context}
            </div>
          )}
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-sm text-secondary mt-0.5">reply</span>
            <span className="text-sm">{message.response}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
