/// §9.6 — the bottom prompt bar: free-text to the agent, the current
/// selection as a removable chip, and streaming agent output collapsed to two
/// lines with an expand. Delivered through the same DM channel as comment
/// dispatch, so a running tmux mirror types it into the agent's pane.

import { useEffect, useRef, useState } from "react"
import { ChevronDownIcon, ChevronUpIcon, SendHorizonalIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DesignAgent } from "@/lib/design-api"
import type { SelectionState } from "./design-selection"

export type AgentLogRow = {
  /** Monotonic key: frame id when available, else arrival order. */
  key: string
  content: string
  stream: string | null
}

export function DesignPromptBar({
  agents,
  agentId,
  onAgentChange,
  selection,
  onClearSelection,
  logRows,
  onSend,
}: {
  agents: DesignAgent[]
  agentId: number | null
  onAgentChange: (id: number) => void
  selection: SelectionState | null
  onClearSelection: () => void
  logRows: AgentLogRow[]
  onSend: (text: string) => Promise<void>
}) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the expanded log pinned to the newest line while streaming.
  useEffect(() => {
    if (expanded && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logRows.length, expanded])

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || !agentId || sending) return
    setSending(true)
    setNotice(null)
    try {
      await onSend(trimmed)
      setText("")
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not deliver the prompt.")
    } finally {
      setSending(false)
    }
  }

  const agent = agents.find((a) => a.id === agentId)

  return (
    <div className="flex h-32 shrink-0 flex-col border-t bg-background">
      {/* Streaming output — two lines by default, expandable. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-2 px-3 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col">
          {logRows.length ? (
            expanded ? (
              <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto font-mono text-[10px] leading-relaxed text-muted-foreground">
                {logRows.map((r) => (
                  <div key={r.key} className={cn("whitespace-pre-wrap", r.stream === "stderr" && "text-destructive/80")}>
                    {r.content}
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-hidden font-mono text-[10px] leading-relaxed text-muted-foreground [&>div]:truncate">
                {logRows.slice(-2).map((r) => (
                  <div key={r.key}>{r.content}</div>
                ))}
              </div>
            )
          ) : (
            <p className="self-center text-[11px] text-muted-foreground">
              Agent output appears here once {agent ? agent.display_name : "the agent"} works in its tmux session.
            </p>
          )}
        </div>
        {logRows.length > 0 ? (
          <button
            className="self-start rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronUpIcon className="size-3.5" />}
          </button>
        ) : null}
      </div>

      {/* Input row */}
      <div className="flex items-end gap-2 px-3 pb-2.5 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-36 shrink-0 gap-1 font-normal" />}>
            <span className="truncate">{agent?.display_name ?? "No agent"}</span>
            <ChevronDownIcon className="size-3 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {agents.map((a) => (
              <button
                key={a.id}
                className={cn(
                  "flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-muted",
                  a.id === agentId && "text-accent",
                )}
                onClick={() => onAgentChange(a.id)}
              >
                {a.display_name}
                {a.id === agentId ? <span className="ml-auto text-xs">✓</span> : null}
              </button>
            ))}
            {!agents.length ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">No agents linked yet.</p>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        {selection ? (
          <button
            onClick={onClearSelection}
            title="Remove attached selection"
            className="flex max-w-56 shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-1 text-[11px] text-accent"
          >
            <span className="font-mono">{selection.component ?? selection.tag}</span>
            <span className="truncate opacity-70">@ {selection.route}</span>
            <span className="rounded-full px-0.5 hover:bg-accent/20">✕</span>
          </button>
        ) : null}

        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void send()
            }
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={agent ? `Prompt ${agent.display_name}…` : "Pick an agent to prompt…"}
          className="max-h-16 min-h-8 flex-1 resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
        />

        <Button size="sm" disabled={!text.trim() || !agentId || sending} onClick={() => void send()}>
          <SendHorizonalIcon className="size-3.5" />
          Send
        </Button>
      </div>

      {notice ? <p className="absolute bottom-full right-4 mb-1 text-[11px] text-destructive">{notice}</p> : null}
    </div>
  )
}
