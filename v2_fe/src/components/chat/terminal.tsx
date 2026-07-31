import { Button } from "@/components/ui/button"
import { MessageSquareIcon, TerminalIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { sendTerminalKey } from "@/lib/taskflow-api"
import { type AgentTerminalSessionView } from "@/lib/workspace-view"
import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react"


export function AgentTerminalPanel({
  selectedSession,
  onFocusComposer,
  onClose,
  className,
}: {
  selectedSession?: AgentTerminalSessionView
  onFocusComposer: () => void
  onClose: () => void
  className?: string
}) {
  const closeButton = (
    <Button variant="ghost" size="icon" onClick={onClose} title="Close terminal" aria-label="Close terminal">
      <XIcon />
    </Button>
  )
  if (!selectedSession) {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-col bg-muted/20", className)}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Terminal</h2>
          </div>
          {closeButton}
        </div>
        <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
          No terminal session yet. Connected agents and their terminal frames will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col bg-muted/20", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-primary" />
            <h2 className="truncate text-sm font-semibold">{selectedSession.agent}</h2>
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1", terminalStatusClass(selectedSession.status))}>
              {selectedSession.connected ? (
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              ) : null}
              {selectedSession.status}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{selectedSession.cwd}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFocusComposer}>
            <MessageSquareIcon />
            Message
          </Button>
          {closeButton}
        </div>
      </div>

      <div className="min-h-0 flex-1 p-3 sm:p-4">
        <TerminalTranscript session={selectedSession} />
      </div>

      {/* Enable when the pane is actually mirroring (streaming frames) OR the
          session is live. `connected` alone (heartbeat recency) went stale while
          the mirror was plainly still streaming, greying out working keys. */}
      <TerminalKeypad
        agentId={selectedSession.agentId}
        disabled={!selectedSession.hasStream && !selectedSession.connected}
      />
    </div>
  )
}




/// Keys forwarded to an agent's terminal (#12), like v1 had. Digits, arrows, and
/// the common control keys — each maps to a tmux key NAME the server allowlists
/// and the agent's mirror types into the pane. Own component (not inline in the
/// panel) so its state sits above the panel's early return.
const TERMINAL_KEYS: { label: string; key: string; wide?: boolean }[] = [
  { label: "1", key: "1" }, { label: "2", key: "2" }, { label: "3", key: "3" },
  { label: "4", key: "4" }, { label: "5", key: "5" }, { label: "6", key: "6" },
  { label: "7", key: "7" }, { label: "8", key: "8" }, { label: "9", key: "9" },
  { label: "0", key: "0" },
  { label: "←", key: "Left" }, { label: "↑", key: "Up" }, { label: "↓", key: "Down" }, { label: "→", key: "Right" },
  { label: "Tab", key: "Tab", wide: true }, { label: "Enter", key: "Enter", wide: true },
  { label: "Esc", key: "Escape", wide: true }, { label: "Space", key: "Space", wide: true },
  { label: "⌫", key: "BSpace" },
]


export function TerminalKeypad({ agentId, disabled }: { agentId: number; disabled?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const press = (key: string) => {
    setError(null)
    void sendTerminalKey(agentId, key).catch((err) =>
      setError(err instanceof Error ? err.message : "Could not send the key.")
    )
  }
  return (
    <div className="shrink-0 border-t bg-background/70 px-3 py-2">
      <div className="flex flex-wrap gap-1">
        {TERMINAL_KEYS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            disabled={disabled}
            onClick={() => press(entry.key)}
            title={disabled ? "No live terminal mirror for this agent" : `Send ${entry.label}`}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-md border font-mono text-xs transition disabled:cursor-not-allowed disabled:opacity-40",
              entry.wide ? "px-2.5" : "w-8",
              "hover:bg-muted"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">{error}</p>
      ) : disabled ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Keys send once this agent has a live terminal mirror.
        </p>
      ) : null}
    </div>
  )
}


/// Live terminal transcript: a dark, monospace stream that colours frames by
/// their source and follows the tail (auto-scrolls to the bottom as new frames
/// arrive, unless the reader has scrolled up to look back).
export function TerminalTranscript({ session }: { session: AgentTerminalSessionView }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const frameCount = session.frames.length

  // A `snapshot` frame is a whole screen that REPLACES the view — a full-screen
  // TUI on tmux's alternate screen has no scrollback to append, so its mirror
  // arrives as repeated complete captures. Rendering those as a log would stack
  // near-identical screens; only the newest one is meaningful.
  const latestSnapshot = useMemo(() => {
    for (let index = session.frames.length - 1; index >= 0; index -= 1) {
      const frame = session.frames[index]
      if (frame && frame.stream === "snapshot") return frame
    }
    return null
  }, [session.frames])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [frameCount])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="scrollbar-y h-full overflow-y-auto rounded-lg bg-[oklch(0.16_0.014_238)] p-4 font-mono text-xs leading-6 text-[oklch(0.88_0.018_238)] shadow-inner"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 text-[oklch(0.72_0.02_238)]">
        <span>{session.task}</span>
        <span>{session.updated}</span>
      </div>
      {latestSnapshot ? (
        // A live mirror, not a transcript: no per-line stream colouring, and the
        // screen is kept intact rather than wrapped, so box-drawing TUIs line up.
        <div className="overflow-x-auto">
          <pre className="whitespace-pre font-mono text-xs leading-6">{latestSnapshot.content}</pre>
        </div>
      ) : (
        session.frames.map((frame, index) => (
          <div key={index} className={cn("whitespace-pre-wrap break-words", terminalStreamClass(frame.stream))}>
            {frame.stream === "stdin" ? <span className="text-emerald-400">$ </span> : null}
            {frame.content || " "}
          </div>
        ))
      )}
    </div>
  )
}


/// Per-stream colour for a terminal frame — stdout stays neutral, stderr reads
/// red, system output is dimmed/italic, stdin is the input prompt colour.
function terminalStreamClass(stream: string): string {
  if (stream === "stderr") return "text-rose-400"
  if (stream === "system") return "italic text-[oklch(0.7_0.03_238)]"
  if (stream === "stdin") return "text-emerald-300"
  return ""
}

function terminalStatusClass(status: string) {
  if (status === "Awaiting input") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "Running" || status === "Connected") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "Expired" || status === "Disconnected") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}
