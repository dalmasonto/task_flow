import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useAgentMessages, respondToMessage, dismissMessage } from '@/hooks/use-agent-messages'
import { useProjects } from '@/hooks/use-projects'
import { useSetting } from '@/hooks/use-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AgentSidebar } from '@/components/inbox/agent-sidebar'
import { ComposeBox } from '@/components/inbox/compose-box'
import type { AgentMessage } from '@/types'

/** Convert literal escape sequences (e.g. \\n, \\t) from MCP JSON strings into real characters */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

export default function AgentInbox() {
  const projects = useProjects()
  const port = Number(useSetting('serverPort'))
  const [agentFilter, setAgentFilter] = useState('all')
  const [showAnswered, setShowAnswered] = useState(false)

  const filteredMessages = useAgentMessages(agentFilter)

  if (!filteredMessages || !projects) return null

  const projectMap = new Map(projects.map(p => [p.id!, p]))

  const pending = filteredMessages.filter(m => m.status === 'pending')
  const answered = filteredMessages.filter(m => m.status === 'answered' || m.status === 'dismissed')

  const answeredByDate = answered.reduce<Record<string, AgentMessage[]>>((acc, m) => {
    const dateKey = m.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    if (!acc[dateKey]) acc[dateKey] = []
    acc[dateKey].push(m)
    return acc
  }, {})

  return (
    <div className="flex h-full">
      {/* Left sidebar — agent list */}
      <div className="w-48 shrink-0 border-r border-border py-4 overflow-y-auto">
        <AgentSidebar selected={agentFilter} onSelect={setAgentFilter} />
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full space-y-8">
          {/* Header */}
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
              {agentFilter === 'all' ? `${pending.length} pending` : `${agentFilter} — ${pending.length} pending`}
            </p>
          </div>

          {/* Pending */}
          {pending.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-xs tracking-widest uppercase font-bold text-secondary flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">pending</span>
                Awaiting Response
              </h2>
              {pending.map(m => (
                <MessageCard key={m.id} message={m} project={m.projectId ? projectMap.get(m.projectId) : undefined} port={port} />
              ))}
            </section>
          )}

          {/* Answered */}
          {answered.length > 0 && (
            <section className="space-y-4">
              <button
                onClick={() => setShowAnswered(!showAnswered)}
                className="text-xs tracking-widest uppercase font-bold text-muted-foreground flex items-center gap-2 hover:text-foreground transition-colors"
              >
                <span className="material-symbols-outlined text-sm">check_circle</span>
                Answered ({answered.length})
                <span className="material-symbols-outlined text-sm">
                  {showAnswered ? 'expand_less' : 'expand_more'}
                </span>
              </button>
              {showAnswered && Object.entries(answeredByDate).map(([date, msgs]) => (
                <div key={date} className="space-y-2">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1">{date}</div>
                  {msgs.map(m => (
                    <AnsweredCard key={m.id} message={m} project={m.projectId ? projectMap.get(m.projectId) : undefined} />
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Empty */}
          {filteredMessages.length === 0 && (
            <div className="text-center py-16">
              <span className="material-symbols-outlined text-5xl text-muted-foreground/30 mb-4 block">inbox</span>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">
                {agentFilter === 'all' ? 'No agent questions yet' : `No messages for ${agentFilter}`}
              </p>
            </div>
          )}
        </div>

        {/* Compose box — only when a specific agent is selected */}
        {agentFilter !== 'all' && (
          <ComposeBox recipient={agentFilter} port={port} />
        )}
      </div>
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

  const handleDismiss = async () => {
    if (!message.id) return
    setSending(true)
    try {
      await dismissMessage(message.id, port)
    } catch (err) {
      console.error('Failed to dismiss:', err)
    } finally {
      setSending(false)
    }
  }

  const timeAgo = getTimeAgo(message.createdAt)

  return (
    <div className="bg-card text-card-foreground border border-secondary/20 shadow-[0_0_15px_rgba(222,142,255,0.05)] p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {project && (
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 border" style={{ borderColor: project.color, color: project.color }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: project.color }} />
              {project.name}
            </span>
          )}
          <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
            {message.senderName === 'user' ? 'You' : message.senderName} →
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">{timeAgo}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={sending}
            className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-destructive h-auto py-1 px-2"
            onClick={handleDismiss}
          >
            <span className="material-symbols-outlined text-sm mr-1">close</span>
            Dismiss
          </Button>
        </div>
      </div>

      {/* Context rendered as Markdown */}
      {message.context && (
        <div className="bg-muted/50 border border-border p-4 text-sm text-muted-foreground max-h-64 overflow-y-auto prose prose-sm max-w-none">
          <ReactMarkdown>{unescapeMarkdown(message.context)}</ReactMarkdown>
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
      className="bg-card text-card-foreground border border-border p-4 cursor-pointer hover:border-muted-foreground/30 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {project && (
            <span className="w-2 h-2 rounded-full shrink-0 mt-1.5" style={{ backgroundColor: project.color }} />
          )}
          <span className="text-sm font-bold break-words">{message.question}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {getTimeAgo(message.createdAt)}
          </span>
          {message.status === 'dismissed' && (
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1.5 py-0.5 border border-muted-foreground/20">
              Dismissed
            </span>
          )}
          <span className="material-symbols-outlined text-sm text-muted-foreground">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {message.context && (
            <div className="bg-muted/50 border border-border p-3 text-xs text-muted-foreground max-h-48 overflow-y-auto prose prose-xs max-w-none">
              <ReactMarkdown>{unescapeMarkdown(message.context)}</ReactMarkdown>
            </div>
          )}
          {message.status === 'answered' && (
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-sm text-secondary mt-0.5">reply</span>
              <span className="text-sm">{message.response}</span>
            </div>
          )}
          {message.status === 'dismissed' && (
            <div className="flex items-center gap-2 text-muted-foreground/50">
              <span className="material-symbols-outlined text-sm">do_not_disturb</span>
              <span className="text-xs uppercase tracking-widest">Answered in terminal</span>
            </div>
          )}
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
