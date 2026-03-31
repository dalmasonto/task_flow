import { useState, useRef, useEffect } from 'react'
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
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredMessages = useAgentMessages(agentFilter)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredMessages?.length])

  if (!filteredMessages || !projects) return null

  const projectMap = new Map(projects.map(p => [p.id!, p]))

  // Sort messages oldest first for chat thread flow
  const sorted = [...filteredMessages].reverse()

  return (
    <div className="flex h-[calc(100vh-4rem-var(--timer-bar-height,0px))] -mt-4">
      {/* Compact sidebar */}
      <div className="w-52 shrink-0 border-r border-border flex flex-col">
        <div className="h-[60px] px-3 flex items-center border-b border-border">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-secondary text-sm">forum</span>
            <span className="text-[10px] tracking-widest uppercase text-secondary font-bold">Inbox</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          <AgentSidebar selected={agentFilter} onSelect={setAgentFilter} />
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0 max-w-3xl">
        {/* Chat header */}
        <div className="shrink-0 h-[60px] px-6 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold uppercase tracking-widest">
              {agentFilter === 'all' ? 'All Conversations' : agentFilter}
            </h1>
            {sorted.filter(m => m.status === 'pending' && m.senderName !== 'user').length > 0 && (
              <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-1.5 py-0.5 min-w-[1.25rem] text-center">
                {sorted.filter(m => m.status === 'pending' && m.senderName !== 'user').length}
              </span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {sorted.length} messages
          </span>
        </div>

        {/* Message thread — scrollable */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full">
              <span className="material-symbols-outlined text-5xl text-muted-foreground/20 mb-3">chat</span>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">
                {agentFilter === 'all' ? 'No conversations yet' : `No messages from ${agentFilter}`}
              </p>
            </div>
          ) : (
            sorted.map(m => (
              <ChatBubble
                key={m.id}
                message={m}
                project={m.projectId ? projectMap.get(m.projectId) : undefined}
                port={port}
              />
            ))
          )}
        </div>

        {/* Fixed compose box at bottom */}
        {agentFilter !== 'all' && (
          <div className="shrink-0">
            <ComposeBox recipient={agentFilter} port={port} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Chat Bubble ──────────────────────────────────────────────────────

function ChatBubble({
  message,
  project,
  port,
}: {
  message: AgentMessage
  project?: { name: string; color: string }
  port: number
}) {
  const isFromUser = message.senderName === 'user'
  const isPending = message.status === 'pending'

  return (
    <div className={`flex flex-col ${isFromUser ? 'items-end' : 'items-start'}`}>
      {/* Sender label + timestamp */}
      <div className={`flex items-center gap-2 mb-1 ${isFromUser ? 'flex-row-reverse' : ''}`}>
        {project && (
          <span
            className="text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 border"
            style={{ borderColor: project.color, color: project.color }}
          >
            {project.name}
          </span>
        )}
        <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
          {isFromUser ? 'You' : message.senderName}
        </span>
        <span className="text-[10px] text-muted-foreground/60">{getTimeAgo(message.createdAt)}</span>
        {isPending && !isFromUser && (
          <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" title="Unread" />
        )}
      </div>

      {/* Bubble */}
      <div className={`max-w-[85%] space-y-3 ${
        isFromUser
          ? 'bg-secondary/10 border border-secondary/20'
          : isPending
            ? 'bg-card border-l-2 border-l-secondary border border-secondary/30 shadow-[0_0_12px_rgba(222,142,255,0.08)]'
            : 'bg-card border border-border opacity-80'
      } px-4 py-3`}>
        {/* Context */}
        {message.context && (
          <div className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none prose-headings:text-muted-foreground prose-headings:text-sm prose-headings:font-bold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-li:my-0">
            <ReactMarkdown>{unescapeMarkdown(message.context)}</ReactMarkdown>
          </div>
        )}

        {/* Message text — bold question for agents, plain text for user */}
        <p className={isFromUser ? 'text-sm' : 'font-bold text-base'}>{message.question}</p>

        {/* Pending: show choices + input (only for agent messages, not user-sent) */}
        {isPending && !isFromUser && <PendingActions message={message} port={port} />}

        {/* Answered: show response */}
        {message.status === 'answered' && message.response && (
          <div className="flex items-start gap-2 pt-2 border-t border-border/50">
            <span className="material-symbols-outlined text-sm text-secondary mt-0.5">reply</span>
            <span className="text-sm">{message.response}</span>
          </div>
        )}

        {/* Dismissed */}
        {message.status === 'dismissed' && (
          <div className="flex items-center gap-2 pt-2 border-t border-border/50 text-muted-foreground/50">
            <span className="material-symbols-outlined text-sm">do_not_disturb</span>
            <span className="text-[10px] uppercase tracking-widest">Answered in terminal</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Pending Actions (choices + text input) ───────────────────────────

function PendingActions({ message, port }: { message: AgentMessage; port: number }) {
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

  return (
    <div className="space-y-2 pt-2 border-t border-border/50">
      {/* Choices */}
      {message.choices && message.choices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.choices.map((choice) => (
            <Button
              key={choice}
              variant="outline"
              size="sm"
              disabled={sending}
              className="uppercase tracking-widest text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-7"
              onClick={() => handleRespond(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {/* Text input + dismiss */}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleRespond(input) }}
          placeholder="Type a response..."
          disabled={sending}
          className="bg-muted/30 border-border text-xs h-8"
        />
        <Button
          onClick={() => handleRespond(input)}
          disabled={sending || !input.trim()}
          size="sm"
          className="uppercase tracking-widest text-[10px] font-bold h-8"
        >
          {sending ? '...' : 'Send'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={sending}
          className="text-muted-foreground hover:text-destructive h-8 px-2"
          onClick={handleDismiss}
          title="Dismiss"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </Button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────

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
