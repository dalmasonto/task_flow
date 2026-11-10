/// Chat (design: chat.html, chat--empty). The conversation engine (thread,
/// composer, attachments, questions, mentions, edits, read cursors) is v2's
/// `useAgentChat` + `AgentsConversationView`, kept whole; v3 owns the layout,
/// the conversation list, and #TSK1092: opening a chat puts the cursor in its
/// message box.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { RoomConversation } from "./RoomConversation"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeftIcon, HashIcon, MessagesSquareIcon, PaletteIcon, PencilIcon, SearchIcon, UsersIcon } from "lucide-react"

import { toast } from "sonner"

import { NewConversationPanel, type ConversationCandidate } from "@/components/chat/new-conversation"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { useIsBelowLg } from "@/hooks/use-mobile"
import { chatIdToSlug, findPublicRoomChat, isAgentOnline, liveId, mapLiveTerminalSessions, slugToChatId, upsertById } from "@/lib/live-mappers"
import { createTaskflowChannel, setChannelArchived } from "@/lib/taskflow-api"
import type { Project } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { seedTaskFrom } from "../tasks/task-seed"
import { useWorkspace } from "../workspace"
import { byRecent, chatRow, filterChats, followLine, listTime, rowBadge, withMentions, type ChatFilter, type ChatRow } from "./chat-logic"
import { useChatSummary } from "./use-chat-summary"
import { useTypers } from "./use-typing"
import { typingText } from "@/lib/typing"
import type { FollowedThread } from "@/lib/chat-summary-api"
import { focusComposerIn } from "./focus"
import { type Actor } from "./ActorDetails"
import { ThreadPanel } from "./ThreadPanel"
import { channelIdOf } from "./thread-logic"
import { useDetail } from "../lib/use-detail"
import { useIsWide } from "../lib/use-wide"
import { myMembership } from "../invites/invites-logic"
import { RoomHeader } from "./RoomHeader"
import { RoomPanel } from "./RoomPanel"
import { linkedTaskIds, roomMembers, roomPowers } from "./room-logic"
import { statusOf } from "../lib/task-status"

const PANEL_KEY = "v3.chat.details"

/// chat.html's tabs. Mentions and Threads need the #5983 endpoints and are
/// left out on a server that predates them.
function filtersFor(hasMentions: boolean, hasThreads: boolean): { id: ChatFilter; label: string }[] {
  return [
    { id: "all", label: "All" },
    { id: "unread", label: "Unread" },
    ...(hasMentions ? [{ id: "mentions" as const, label: "Mentions" }] : []),
    ...(hasThreads ? [{ id: "threads" as const, label: "Threads" }] : []),
    { id: "agents", label: "Agents" },
  ]
}

function ThreadRow({ t, room, now, onOpen }: { t: FollowedThread; room: string | null; now: number; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
          <MessagesSquareIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", t.new_replies ? "font-semibold" : "font-medium")}>{t.excerpt || "Thread"}</span>
            {t.last_reply_at ? <time className="shrink-0 text-xs text-muted-foreground">{timeAgo(t.last_reply_at, now)}</time> : null}
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{followLine(t, room)}</span>
            {t.new_replies ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-foreground" aria-label={`${t.new_replies} new ${t.new_replies === 1 ? "reply" : "replies"}`}>
                {t.new_replies > 99 ? "99+" : t.new_replies}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  )
}

/// chat.html's conversation avatars: an agent DM shows the agent's model,
/// a person their initials, and a room its kind's icon with up to three of
/// its members (agents first) along the bottom edge.
function RowIcon({ row, agentRuntime, runtimeOf }: { row: ChatRow; agentRuntime?: string | null; runtimeOf: (title: string) => string | null }) {
  if (row.kind === "agent") return <ActorAvatar model={guessModel(agentRuntime) ?? guessModel(row.title)} name={row.title} status={row.online ? "running" : "offline"} size="md" />
  if (row.kind === "person") return <ActorAvatar name={row.title} size="md" />
  const Icon = row.kind === "group" ? UsersIcon : /design/i.test(row.title) ? PaletteIcon : HashIcon
  const faces = row.faces ?? []
  return (
    <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
      <Icon className={cn("size-4", faces.length && "-translate-y-1")} />
      {faces.length ? (
        <span className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 -space-x-1">
          {faces.map((f) => (
            <ActorAvatar key={f.name} name={f.name} model={f.agent ? (guessModel(runtimeOf(f.name)) ?? guessModel(f.name)) : null} size="xs" className="ring-1 ring-background" />
          ))}
        </span>
      ) : null}
    </span>
  )
}

function ChatList({ rows, archived, activeId, onOpen, runtimeOf, onNew, candidates, onCreate, hasMentions, following, roomTitle, onOpenThread, typingIn }: {
  rows: ChatRow[]
  /// "X is writing" for a room, replacing its preview (chat.html, #5988).
  typingIn: (channel: number) => string | null
  /// The server's mention counts are in (#5983): show the Mentions tab.
  hasMentions: boolean
  /// Threads I follow; null on a server without them (no Threads tab).
  following: FollowedThread[] | null
  roomTitle: (channel: number) => string | null
  onOpenThread: (channel: number, root: number) => void
  /// Archived rooms' chat ids: listed last, folded away (#5951).
  archived: Set<string>
  activeId: string | null
  onOpen: (id: string) => void
  runtimeOf: (title: string) => string | null
  /// ?new=dm / ?new=room (the sidebar's Create menu): open the new
  /// conversation panel on that tab.
  onNew: "direct" | "group" | null
  candidates: ConversationCandidate[]
  onCreate: (kind: "direct" | "group", title: string, members: ConversationCandidate["member"][]) => Promise<void>
}) {
  const now = useLivenessNow()
  const [filter, setFilter] = useState<ChatFilter>("all")
  const [query, setQuery] = useState("")
  const [newOpen, setNewOpen] = useState(onNew != null)
  const [newMode, setNewMode] = useState<"direct" | "group">(onNew ?? "direct")
  // The Create menu can ask again while this page is already up (state
  // adjusted during render when the prop changes, not in an effect).
  const [askedNew, setAskedNew] = useState(onNew)
  if (onNew !== askedNew) {
    setAskedNew(onNew)
    if (onNew) {
      setNewMode(onNew)
      setNewOpen(true)
    }
  }
  const filters = filtersFor(hasMentions, following != null)
  // A tab that went away (older server) falls back to All.
  const active: ChatFilter = filters.some((f) => f.id === filter) ? filter : "all"
  const all = active === "threads" ? [] : filterChats(rows, active, query)
  const shown = all.filter((r) => !archived.has(r.id))
  const archivedRows = all.filter((r) => archived.has(r.id))
  const [showArchived, setShowArchived] = useState(false)
  const rooms = shown.filter((r) => r.kind === "room")
  const dms = shown.filter((r) => r.kind !== "room").sort(byRecent)
  const unread = rows.filter((r) => r.unread > 0).length
  const mentioned = rows.filter((r) => r.mentions > 0).length
  const q = query.trim().toLowerCase()
  const threads = (following ?? []).filter((t) => !q || t.excerpt.toLowerCase().includes(q))
  const freshThreads = threads.filter((t) => t.new_replies > 0)
  const threadItem = (t: FollowedThread) => <ThreadRow key={t.root} t={t} room={roomTitle(t.channel)} now={now} onOpen={() => onOpenThread(t.channel, t.root)} />

  const item = (r: ChatRow) => {
    const badge = rowBadge(r)
    const writing = r.channelId != null ? typingIn(r.channelId) : null
    return (
    <li key={r.id}>
      <button
        type="button"
        onClick={() => onOpen(r.id)}
        aria-current={activeId === r.id ? "page" : undefined}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
          activeId === r.id ? "bg-accent text-accent-foreground shadow-[inset_2px_0_0_var(--ring)]" : "hover:bg-muted/60",
        )}
      >
        <RowIcon row={r} agentRuntime={runtimeOf(r.title)} runtimeOf={runtimeOf} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", r.unread ? "font-semibold" : "font-medium")}>{r.title}</span>
            {r.at ? (
              <time dateTime={r.at} title={new Date(r.at).toLocaleString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {listTime(r.at, now)}
              </time>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            {writing ? (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground italic">{writing}</span>
            ) : (
              <span className={cn("min-w-0 flex-1 truncate text-xs", r.unread ? "text-foreground" : "text-muted-foreground")}>{r.preview}</span>
            )}
            {badge ? (
              <span className={cn("shrink-0 rounded-full px-1.5 text-xs font-semibold tabular-nums", badge.mention ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")} aria-label={badge.label}>
                {badge.text}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative shrink-0 space-y-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a room or person" aria-label="Find a room or person" className="h-8 pl-8" />
          </div>
          <Button variant="outline" size="icon-sm" aria-label="New conversation" aria-expanded={newOpen} onClick={() => setNewOpen((o) => !o)}>
            <PencilIcon />
          </Button>
        </div>
        {newOpen ? <NewConversationPanel key={newMode} initialMode={newMode} candidates={candidates} onCreate={onCreate} onClose={() => setNewOpen(false)} /> : null}
        <div role="tablist" aria-label="Filter conversations" className="flex flex-wrap gap-0.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={active === f.id}
              onClick={() => setFilter(f.id)}
              className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs", active === f.id ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
            >
              {f.label}
              {f.id === "unread" && unread ? <span className="tabular-nums">{unread}</span> : null}
              {f.id === "mentions" && mentioned ? <span className="tabular-nums">{mentioned}</span> : null}
              {f.id === "threads" && freshThreads.length ? <span className="tabular-nums">{freshThreads.length}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {active === "threads" ? (
          threads.length ? (
            <>
              <p className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Threads you follow</p>
              <ul className="space-y-0.5">{threads.map(threadItem)}</ul>
            </>
          ) : (
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">{q ? "Nothing matches." : "You aren't following any threads. Reply in one, or open it and choose Follow."}</p>
          )
        ) : null}
        {rooms.length ? (
          <>
            <p className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Rooms</p>
            <ul className="space-y-0.5">{rooms.map(item)}</ul>
          </>
        ) : null}
        {active === "all" && freshThreads.length ? (
          <>
            <p className="px-2.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">Threads you follow</p>
            <ul className="space-y-0.5">{freshThreads.map(threadItem)}</ul>
          </>
        ) : null}
        {dms.length ? (
          <>
            <p className="px-2.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">Direct messages</p>
            <ul className="space-y-0.5">{dms.map(item)}</ul>
          </>
        ) : null}
        {archivedRows.length ? (
          <>
            <button type="button" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className="mt-3 flex w-full items-center gap-1 px-2.5 pb-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
              Archived <span className="tabular-nums">{archivedRows.length}</span>
              <span className="ml-auto">{showArchived ? "Hide" : "Show"}</span>
            </button>
            {showArchived ? <ul className="space-y-0.5 opacity-80">{archivedRows.map(item)}</ul> : null}
          </>
        ) : null}
        {active !== "threads" && !rooms.length && !dms.length && !archivedRows.length ? <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">{query || active !== "all" ? "Nothing matches." : "No conversations yet."}</p> : null}
      </div>
    </div>
  )
}

function ChatWorkspace({ project, onTitle }: { project: Project; onTitle: (title: ReactNode) => void }) {
  const navigate = useNavigate()
  const detail = useDetail()
  const { slug } = useParams()
  const [params, setParams] = useSearchParams()
  const isBelowLg = useIsBelowLg()
  const { live, currentUser, applyLiveUpdate, reloadLive, setChatSurfaceMounted } = useWorkspace()
  const pane = useRef<HTMLDivElement>(null)

  // Tell App the chat slices are needed while this page is up.
  useEffect(() => {
    setChatSurfaceMounted(true)
    return () => setChatSurfaceMounted(false)
  }, [setChatSurfaceMounted])

  const { directChats, channelChats, selectedChat, messageError, outletContext } = useAgentChat({
    project,
    liveWorkspace: live,
    currentUser,
    onWorkspaceUpdate: applyLiveUpdate,
    onRefreshWorkspace: reloadLive,
    selectedChatId: slug ? slugToChatId(slug) : null,
    includeArchived: true,
    onComposeTask: (body) => {
      if (seedTaskFrom(body)) detail.open({ kind: "new-task", status: "not_started" })
    },
  })

  // chat.html puts the open conversation's name in the shell header.
  const headerTitle = selectedChat ? `${selectedChat.mode === "channel" ? "# " : ""}${selectedChat.title}` : "Chat"
  useEffect(() => onTitle(headerTitle), [headerTitle, onTitle])

  const baseRows = useMemo(() => [...channelChats, ...directChats].map((c) => chatRow(c)), [channelChats, directChats])
  // #5983: mention counts and followed threads, refetched when any unread
  // count moves (there's no realtime group for them, by design).
  const unreadSignal = baseRows.map((r) => `${r.id}:${r.unread}`).join(",")
  const chatSummary = useChatSummary(liveId(project.id), unreadSignal)
  const rows = useMemo(() => withMentions(baseRows, chatSummary.summary), [baseRows, chatSummary.summary])
  const roomTitle = (channel: number) => [...channelChats, ...directChats].find((c) => c.liveChannelId === channel)?.title ?? null
  const openFollowedThread = (channel: number, root: number) => {
    const chat = [...channelChats, ...directChats].find((c) => c.liveChannelId === channel)
    if (chat) navigate(`/v3/chat/${chatIdToSlug(chat.id)}?thread=${root}`)
  }
  const runtimeOf = (title: string) => live?.agents.find((a) => a.display_name === title)?.runtime ?? null
  const open = (chatId: string) => {
    navigate(`/v3/chat/${chatIdToSlug(chatId)}`)
    // Clicking a row (even the open one) means "I want to type here" (#TSK1092).
    requestAnimationFrame(() => focusComposerIn(pane.current, { byTap: true }))
  }

  const candidates = useMemo<ConversationCandidate[]>(() => {
    if (!live) return []
    return [
      ...live.members
        .filter((m) => m.status === "active" && m.user != null && m.user !== currentUser?.id)
        .map((m) => ({ key: `user:${m.user}`, label: m.display_name, type: "user" as const, member: { kind: "user" as const, user: m.user as number } })),
      ...live.agents.filter((a) => a.status !== "revoked").map((a) => ({ key: `agent:${a.id}`, label: a.display_name, type: "agent" as const, member: { kind: "agent" as const, agent: a.id } })),
    ]
  }, [live, currentUser?.id])

  const createConversation = async (kind: "direct" | "group", title: string, members: ConversationCandidate["member"][]) => {
    const projectId = liveId(project.id)
    if (!projectId) throw new Error("Select a live project first.")
    const channel = await createTaskflowChannel({ project: projectId, kind, title, members })
    applyLiveUpdate((w) => ({
      ...w,
      agentChannels: upsertById(w.agentChannels, channel),
      agentChannelMembers: channel.members.reduce((cur, m) => upsertById(cur, m), w.agentChannelMembers),
    }))
    open(`live:${kind === "direct" ? "direct" : "channel"}:${channel.id}`)
  }

  // ?agent=<id> (the palette's "Message"): open that agent's DM, starting one
  // if none exists yet. Handled once, then dropped from the URL.
  const agentParam = params.get("agent")
  const handledAgent = useRef<string | null>(null)
  useEffect(() => {
    if (!agentParam || handledAgent.current === agentParam || !live?.agentChannelsLoaded) return
    handledAgent.current = agentParam
    const id = Number(agentParam)
    const existing = directChats.find((c) => c.liveAgentId === id)
    const agent = live.agents.find((a) => a.id === id)
    params.delete("agent")
    setParams(params, { replace: true })
    if (existing) open(existing.id)
    else if (agent) void createConversation("direct", agent.display_name, [{ kind: "agent", agent: id }])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per ?agent= value; the ref guards repeats
  }, [agentParam, live?.agentChannelsLoaded, directChats])

  // ?channel=<id>[&msg=<id>] (inbox items, links that only know the channel):
  // open whichever room or DM that channel is, keeping ?msg= for the jump.
  const channelParam = Number(params.get("channel")) || null
  useEffect(() => {
    if (!channelParam || !live?.agentChannelsLoaded) return
    const chat = [...channelChats, ...directChats].find((c) => c.liveChannelId === channelParam)
    if (!chat) return
    const next = new URLSearchParams(params)
    next.delete("channel")
    const q = next.toString()
    navigate(`/v3/chat/${chatIdToSlug(chat.id)}${q ? `?${q}` : ""}`, { replace: true })
  }, [channelParam, live?.agentChannelsLoaded, channelChats, directChats, params, navigate])

  // ?user=<id> (a person's "Message" in the details panel): open your DM
  // with them, starting one if none exists yet.
  const userParam = params.get("user")
  const handledUser = useRef<string | null>(null)
  useEffect(() => {
    if (!userParam || handledUser.current === userParam || !live?.agentChannelsLoaded) return
    handledUser.current = userParam
    const id = Number(userParam)
    const existing = directChats.find((c) => c.liveMemberUserId === id)
    const person = live.members.find((m) => m.user === id)
    params.delete("user")
    setParams(params, { replace: true })
    if (existing) open(existing.id)
    else if (person) void createConversation("direct", person.display_name, [{ kind: "user", user: id }])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ?user= value; the ref guards repeats
  }, [userParam, live?.agentChannelsLoaded, directChats])

  // Desktop with no conversation chosen: open the project room, as v2 does.
  // The query string goes along: ?new=room from the sidebar's + must survive
  // this redirect, or the new-conversation panel opens and closes at once.
  useEffect(() => {
    if (slug || isBelowLg || agentParam || userParam || channelParam || !live?.agentChannelsLoaded) return
    const first = findPublicRoomChat(live, currentUser) ?? directChats[0]
    const q = params.toString()
    if (first) navigate(`/v3/chat/${chatIdToSlug(first.id)}${q ? `?${q}` : ""}`, { replace: true })
  }, [slug, isBelowLg, agentParam, userParam, channelParam, live, currentUser, directChats, navigate, params])

  // #TSK1092: a newly opened conversation puts the cursor in its message box.
  const selectedId = selectedChat?.id ?? null
  useEffect(() => {
    if (!selectedId) return
    const raf = requestAnimationFrame(() => focusComposerIn(pane.current))
    return () => cancelAnimationFrame(raf)
  }, [selectedId])

  // #1132: threads. ?thread=<root id> opens the panel (deep-linkable); reply
  // counts load for the roots on screen and refresh when a thread row arrives.
  const channelId = channelIdOf(selectedId)
  const threadParam = Number(params.get("thread")) || null
  // #1092: a thread opened by a click may focus its reply box even on touch.
  const [threadTapped, setThreadTapped] = useState(false)
  const openThread = (rootId: string) => {
    setThreadTapped(true)
    const next = new URLSearchParams(params)
    next.set("thread", rootId)
    setParams(next, { replace: false })
  }
  const closeThread = () => {
    const next = new URLSearchParams(params)
    next.delete("thread")
    setParams(next, { replace: true })
  }
  const threadOpen = !!(threadParam && channelId)

  // #5918: the room header, details panel and flat message rows of chat.html.
  const now = useLivenessNow()
  const isWide = useIsWide()
  const { projectTasks } = useWorkspace()
  const [panelPref, setPanelPref] = useState<boolean>(() => {
    try {
      // Closed until asked for, as in chat.html (the room gets the width).
      return localStorage.getItem(PANEL_KEY) === "1"
    } catch {
      return false
    }
  })
  const [panelSheet, setPanelSheet] = useState(false)
  const togglePanel = () => {
    if (!isWide) return setPanelSheet((o) => !o)
    setPanelPref((o) => {
      try {
        localStorage.setItem(PANEL_KEY, o ? "0" : "1")
      } catch {
        // Private window: remembered for this visit only.
      }
      return !o
    })
  }
  // Someone opened from Members or an @mention chip, and "Edit room".
  const [actor, setActor] = useState<Actor | null>(null)
  const [editRequest, setEditRequest] = useState(0)
  const openPanel = () => (isWide ? setPanelPref(true) : setPanelSheet(true))
  const showActor = useCallback(
    (kind: "user" | "agent", id: number) => {
      setActor({ kind, id })
      if (isWide) setPanelPref(true)
      else setPanelSheet(true)
    },
    [isWide],
  )
  const messageActor = (a: Actor) => {
    setActor(null)
    setPanelSheet(false)
    navigate(`/v3/chat?${a.kind === "agent" ? "agent" : "user"}=${a.id}`)
  }
  const channel = channelId != null ? (live?.agentChannels.find((c) => c.id === channelId) ?? null) : null
  const members = useMemo(
    () => (channel && live ? roomMembers(channel, live.agentChannelMembers, live.members, live.agents, live.tasks, (id) => isAgentOnline(id, live.agents, live.agentSessions, now)) : null),
    [channel, live, now],
  )
  const me = myMembership(live?.members ?? [], currentUser?.id)
  const powers = channel ? roomPowers(channel, { user: currentUser?.id ?? null, role: me?.role ?? null, inRoom: !!members?.people.some((p) => p.user === currentUser?.id), superuser: !!currentUser?.is_superuser }) : null
  const messages = useMemo(() => selectedChat?.messages ?? [], [selectedChat?.messages])
  const linkedTasks = useMemo(() => {
    const byId = new Map(projectTasks.map((t) => [Number(t.id), t]))
    return linkedTaskIds(channel?.task ?? null, messages.map((m) => m.body), new Set(byId.keys())).map((id) => {
      const t = byId.get(id)!
      return { id, title: t.title, status: statusOf(t) }
    })
  }, [channel?.task, messages, projectTasks])
  const terminals = useMemo(() => {
    const seen = new Set<number>()
    return (live ? mapLiveTerminalSessions(live, now) : []).filter((t) => (seen.has(t.agentId) ? false : (seen.add(t.agentId), true)))
  }, [live, now])
  const unarchive = async () => {
    if (!channel) return
    try {
      const c = await setChannelArchived(channel.id, false)
      applyLiveUpdate((w) => ({ ...w, agentChannels: upsertById(w.agentChannels, c) }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't unarchive the room.")
    }
  }
  const jumpTo = (id: number) => {
    const el = pane.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!el) {
      toast.info("That message is further back", { description: "Scroll up to load older messages, then try again." })
      return false
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    el.classList.add("bg-accent")
    setTimeout(() => el.classList.remove("bg-accent"), 1600)
    return true
  }
  // ?msg=<id> (inbox items): scroll to that message once it's on screen, then
  // drop the param. Re-tried as messages arrive, so a slow load still lands.
  const msgParam = Number(params.get("msg")) || null
  const loadedCount = outletContext.selectedChat?.messages.length ?? 0
  useEffect(() => {
    if (!msgParam || !pane.current?.querySelector(`[data-message-id="${msgParam}"]`)) return
    const raf = requestAnimationFrame(() => {
      jumpTo(msgParam)
      const next = new URLSearchParams(params)
      next.delete("msg")
      setParams(next, { replace: true })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jumpTo/params are read fresh when it fires
  }, [msgParam, loadedCount, selectedId])

  const typers = useTypers(currentUser ? `user:${currentUser.id}` : null)
  const panelOpen = !!channel && (isWide ? panelPref && !threadOpen : panelSheet)
  const panel =
    channel && members && powers ? (
      <RoomPanel
        channel={channel}
        members={members}
        powers={powers}
        meUser={currentUser?.id ?? null}
        linkedTasks={linkedTasks}
        terminals={terminals}
        messages={messages}
        addCandidates={outletContext.addMemberCandidates}
        agentCandidates={
          members && !channel.is_public && channel.kind !== "project"
            ? (live?.agents ?? []).filter((x) => x.status !== "revoked" && !members.agents.some((m) => m.id === x.id)).map((x) => ({ id: x.id, name: x.display_name }))
            : []
        }
        onAddMember={outletContext.onAddMember}
        onJumpToMessage={(id) => {
          setPanelSheet(false)
          return jumpTo(id)
        }}
        onClose={isWide ? undefined : () => setPanelSheet(false)}
        actor={actor}
        onActor={setActor}
        onMessage={messageActor}
        editRequest={editRequest}
      />
    ) : null

  const archivedIds = useMemo(() => new Set((live?.agentChannels ?? []).filter((c) => c.archived).map((c) => `live:channel:${c.id}`)), [live?.agentChannels])

  const showList = !isBelowLg || !slug
  const showConvo = (!isBelowLg || !!slug) && !(isBelowLg && threadOpen)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {messageError ? <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{messageError}</p> : null}
      <div className={cn("grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden", threadOpen ? "lg:grid-cols-[19rem_minmax(0,1fr)_24rem]" : isWide && panelOpen ? "lg:grid-cols-[19rem_minmax(0,1fr)_20rem]" : "lg:grid-cols-[19rem_minmax(0,1fr)]")}>
        {showList ? (
          <aside className="min-h-0 border-border lg:border-r" aria-label="Conversations">
            <ChatList
              rows={rows}
              archived={archivedIds}
              activeId={selectedId}
              onOpen={open}
              runtimeOf={runtimeOf}
              onNew={params.get("new") === "dm" ? "direct" : params.get("new") === "room" ? "group" : null}
              candidates={candidates}
              onCreate={createConversation}
              hasMentions={chatSummary.summary != null}
              following={chatSummary.following}
              roomTitle={roomTitle}
              onOpenThread={openFollowedThread}
              typingIn={(ch) => typingText(typers.get(ch) ?? [])}
            />
          </aside>
        ) : null}
        {showConvo ? (
          <section ref={pane} className="flex min-h-0 min-w-0 flex-col" aria-label={selectedChat?.title ?? "Conversation"}>
            {isBelowLg && slug ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
                <Button variant="ghost" size="sm" onClick={() => navigate("/v3/chat")}>
                  <ArrowLeftIcon />
                  Conversations
                </Button>
              </div>
            ) : null}
            {selectedChat ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <RoomHeader
                  title={selectedChat.title}
                  topic={channel?.topic ?? null}
                  isRoom={selectedChat.mode === "channel"}
                  members={members}
                  channelId={channelId}
                  panelOpen={panelOpen}
                  onTogglePanel={togglePanel}
                  onEditRoom={
                    powers?.edit
                      ? () => {
                          setActor(null)
                          setEditRequest((n) => n + 1)
                          openPanel()
                        }
                      : undefined
                  }
                  onJump={jumpTo}
                />
                {channel?.archived ? (
                  <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm">
                    <span className="text-muted-foreground">This room is archived. It&apos;s read-only; nobody can post in it.</span>
                    {powers?.archive ? (
                      <Button size="sm" variant="outline" className="ml-auto" onClick={() => void unarchive()}>
                        Unarchive
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <RoomConversation
                  context={outletContext}
                  channelId={channelId}
                  readOnly={!!channel?.archived}
                  canSignalTyping={!!channel && channel.kind !== "direct" && channel.kind !== "group"}
                  onOpenThread={openThread}
                  onShowActor={showActor}
                  onJump={jumpTo}
                />
              </div>
            ) : (
              <Empty className="m-auto max-w-sm">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessagesSquareIcon />
                  </EmptyMedia>
                  <EmptyTitle>{rows.length ? "Pick a conversation" : "No conversations yet"}</EmptyTitle>
                  <EmptyDescription>
                    {rows.length ? "Choose a room or a direct message on the left." : "Start one with the pencil: a DM with an agent or a person, or a group."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        ) : null}
        {isWide && panelOpen && panel ? (
          <aside className="h-full min-h-0 overflow-hidden border-l border-border" aria-label="Room details">
            {panel}
          </aside>
        ) : null}
        {threadOpen ? (
          <div className="h-full min-h-0 overflow-hidden">
            <ThreadPanel
              key={`${channelId}:${threadParam}`}
              channel={channelId!}
              root={threadParam!}
              currentUser={currentUser}
              onClose={closeThread}
              following={chatSummary.following ? chatSummary.following.some((t) => t.root === threadParam) : null}
              onFollowChanged={chatSummary.reload}
              openedByTap={threadTapped}
            />
          </div>
        ) : null}
      </div>
      {!isWide ? (
        <Sheet open={panelSheet && !!panel} onOpenChange={setPanelSheet}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-sm">
            <SheetTitle className="sr-only">Room details</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}

export function ChatPage() {
  const { activeProject } = useWorkspace()
  const [title, setTitle] = useState<ReactNode>("Chat")
  return (
    <V3Shell title={title} flush>
      {activeProject ? (
        <ChatWorkspace project={activeProject} onTitle={setTitle} />
      ) : (
        <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No project yet</EmptyTitle>
            <EmptyDescription>Chat rooms belong to a project. Create one to start.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </V3Shell>
  )
}
