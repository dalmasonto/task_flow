/// The bar above a conversation (design: chat.html, #5918): the room's name
/// and topic, who's in it, search in the room, and the details toggle. Search
/// asks the server (message text, newest first), so it finds messages older
/// than what's loaded too. A hit that's loaded scrolls into view.
import { useEffect, useState } from "react"
import { PanelRightIcon, SearchIcon, XIcon } from "lucide-react"

import type { TaskflowAgentMessage } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import type { RoomMembers } from "./room-logic"

/// A search hit as text: markdown marks, links and chips reduced to their words.
function plain(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function RoomSearch({ channelId, onJump, onClose }: { channelId: number; onJump: (id: number) => boolean; onClose: () => void }) {
  const now = useLivenessNow()
  const [q, setQ] = useState("")
  const [res, setRes] = useState<{ q: string; rows: TaskflowAgentMessage[]; error: boolean } | null>(null)
  const term = q.trim()

  useEffect(() => {
    if (term.length < 2) return
    let alive = true
    const t = setTimeout(() => {
      taskflowApi
        .from(taskflowTables.agentMessages)
        .filter({ channel: channelId, body_markdown__icontains: term })
        .orderBy("-created_at", "-id")
        .param("page_size", 20)
        .list()
        .then((r) => alive && setRes({ q: term, rows: r.results as TaskflowAgentMessage[], error: false }))
        .catch(() => alive && setRes({ q: term, rows: [], error: true }))
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [term, channelId])

  const shown = res && res.q === term && term.length >= 2 ? res : null

  return (
    <div className="relative border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this room" aria-label="Search this room" className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {shown ? (
        <div className="absolute inset-x-3 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl">
          {shown.error ? (
            <p className="px-3 py-2 text-sm text-destructive">Search didn&apos;t go through. Try again.</p>
          ) : shown.rows.length ? (
            shown.rows.map((m) => (
              <button
                key={m.id}
                type="button"
                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  if (onJump(m.id)) onClose()
                }}
              >
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{m.sender_label}</span>
                  {timeAgo(m.created_at, now)}
                </span>
                <span className="mt-0.5 line-clamp-2 text-sm">{plain(m.body_markdown)}</span>
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-muted-foreground">Nothing in this room says &ldquo;{term}&rdquo;.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function RoomHeader({
  title,
  topic,
  isRoom,
  members,
  channelId,
  panelOpen,
  onTogglePanel,
  onJump,
}: {
  title: string
  topic: string | null
  isRoom: boolean
  members: RoomMembers | null
  channelId: number | null
  panelOpen: boolean
  onTogglePanel: () => void
  onJump: (id: number) => boolean
}) {
  const [searching, setSearching] = useState(false)
  const faces = members ? [...members.people.map((p) => ({ key: `u${p.user}`, name: p.name, model: null })), ...members.agents.map((a) => ({ key: `a${a.id}`, name: a.name, model: guessModel(a.runtime) ?? guessModel(a.name) }))] : []
  return (
    <>
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {isRoom ? <span className="text-muted-foreground"># </span> : null}
            {title}
          </h2>
          {topic?.trim() ? <p className="truncate text-xs text-muted-foreground" title={topic}>{topic}</p> : null}
        </div>
        {faces.length ? (
          <button type="button" className="hidden shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted sm:flex" onClick={onTogglePanel} aria-label={`${faces.length} members. Show room details`}>
            <span className="flex -space-x-1.5">
              {faces.slice(0, 4).map((f) => (
                <ActorAvatar key={f.key} name={f.name} model={f.model} size="sm" className="ring-2 ring-background" />
              ))}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{faces.length}</span>
          </button>
        ) : null}
        {channelId != null ? (
          <Button variant="ghost" size="icon-sm" aria-label="Search this room" aria-pressed={searching} onClick={() => setSearching((s) => !s)}>
            <SearchIcon />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label={panelOpen ? "Hide room details" : "Show room details"} aria-expanded={panelOpen} className={cn(panelOpen && "bg-muted")} onClick={onTogglePanel}>
          <PanelRightIcon />
        </Button>
      </div>
      {searching && channelId != null ? <RoomSearch channelId={channelId} onJump={onJump} onClose={() => setSearching(false)} /> : null}
    </>
  )
}
