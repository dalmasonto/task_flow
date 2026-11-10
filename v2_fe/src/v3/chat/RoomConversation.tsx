/// One room's conversation, the same everywhere (#1154): the Chat page, the
/// Design chat and the Database room all render this. Flat message rows with
/// avatars and sender badges (chat.html), the "for you" tint, clickable
/// @mentions, pins and the pin bar, reactions, "ran N tools", delivery
/// receipts, thread links, "X is writing" and the v3 composer.
///
/// What differs per surface comes in as props: the Chat page opens threads
/// and people in its own side panels; a surface without one gets a thread
/// sheet here and people open on their own pages. The Design chat adds its
/// comment cards, selection chip and page mentions through `viewProps`.
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AgentsConversationView } from "@/components/chat/conversation-view"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { ActorMentionContext } from "@/lib/markdown-contexts"
import { subscribeThreadEvents } from "@/lib/thread-bus"
import { fetchThreadSummaries } from "@/lib/threads-api"
import { sendTyping, TYPING_LIVE, typingText } from "@/lib/typing"
import type { AgentMessage } from "@/lib/workspace-view"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { useLoad } from "../lib/use-load"
import { useMayDrive } from "../lib/use-may-drive"
import { useWorkspace } from "../workspace"
import { mentionsUser } from "./chat-logic"
import { DeliveredLine, MessageExtraActions, PinBar, PinnedMark, ReactionRow, ToolsLine, TypingLine } from "./pins"
import { reactionIds } from "./pins-logic"
import { ThreadPanel } from "./ThreadPanel"
import { useDeliveries } from "./use-deliveries"
import { useMessageTools } from "./use-message-tools"
import { useRoomExtras } from "./use-room-extras"
import { useTypers } from "./use-typing"

type ViewProps = ComponentProps<typeof AgentsConversationView>

export function RoomConversation({
  context,
  channelId,
  readOnly = false,
  canSignalTyping = true,
  onOpenThread,
  onShowActor,
  onJump,
  viewProps,
}: {
  /// What useAgentChat returns as `outletContext`, its selectedChat set.
  context: Omit<ViewProps, "variant">
  channelId: number | null
  /// An archived room: read, never write.
  readOnly?: boolean
  /// "X is writing" goes to shared rooms only (the server drops private
  /// rooms' events), so DMs and groups pass false.
  canSignalTyping?: boolean
  /// Open a thread in the caller's own panel; without it, a sheet here.
  onOpenThread?: (root: string) => void
  /// Show a person or agent in the caller's panel; without it, their page.
  onShowActor?: (kind: "user" | "agent", id: number) => void
  /// Scroll to a message (the pin bar); without it, within this view.
  onJump?: (id: number) => boolean
  /// Surface extras for the view (the Design chat: variant, renderBody,
  /// contextChip, pageMentions…).
  viewProps?: Partial<ViewProps>
}) {
  const { live, currentUser } = useWorkspace()
  const mayDrive = useMayDrive()
  const navigate = useNavigate()
  const box = useRef<HTMLDivElement>(null)
  const messages = useMemo(() => context.selectedChat?.messages ?? [], [context.selectedChat?.messages])

  // Who's who: avatars and the badge after a name.
  const agentNames = useMemo(() => new Map((live?.agents ?? []).map((a) => [a.display_name, a])), [live?.agents])
  const roleByName = useMemo(() => new Map((live?.members ?? []).filter((m) => m.status === "active").map((m) => [m.display_name, m.role])), [live?.members])
  const renderAvatar = (from: string) => {
    if (from === "user") return <ActorAvatar name={currentUser?.username || "You"} size="md" />
    const a = agentNames.get(from)
    return <ActorAvatar name={from} model={a ? (guessModel(a.runtime) ?? guessModel(a.display_name)) : null} size="md" />
  }
  const senderBadge = (from: string) => {
    if (agentNames.has(from)) return "agent"
    const role = roleByName.get(from)
    return role === "owner" ? "Owner" : role === "admin" ? "Admin" : null
  }

  const jumpHere = (id: number) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!el) {
      toast.info("That message is further back", { description: "Scroll up to load older messages, then try again." })
      return false
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    el.classList.add("bg-accent")
    setTimeout(() => el.classList.remove("bg-accent"), 1600)
    return true
  }
  const jump = onJump ?? jumpHere

  // Threads: reply counts under each root, refreshed when a reply arrives.
  const rootIds = messages.filter((m) => m.status === "posted" && !m.threadRoot).map((m) => Number(m.id)).filter((n) => Number.isInteger(n) && n > 0)
  const summaries = useLoad(channelId && rootIds.length ? `threads|${channelId}|${rootIds.join(",")}` : null, (signal) => fetchThreadSummaries(channelId!, rootIds.slice(-200), signal))
  const reloadSummaries = summaries.reload
  useEffect(() => subscribeThreadEvents((e) => (e.kind === "delete" || (e.message.thread_root != null && e.message.channel === channelId) ? reloadSummaries() : undefined)), [channelId, reloadSummaries])
  const threadSummaries = useMemo(() => Object.fromEntries(Object.entries(summaries.data ?? {}).map(([k, v]) => [k, { replyCount: v.reply_count, lastReplyAt: v.last_reply_at }])), [summaries.data])
  const [sheetThread, setSheetThread] = useState<number | null>(null)
  const openThread = onOpenThread ?? ((root: string) => setSheetThread(Number(root) || null))

  // Pins and reactions (hidden on a server without them).
  const extras = useRoomExtras(channelId, reactionIds(messages))
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const renderActions =
    extras.supported && !readOnly
      ? (m: AgentMessage) => {
          const id = Number(m.id)
          const pinned = extras.pinned.has(id)
          // Only a room's own messages can be pinned, not thread replies.
          return <MessageExtraActions pinned={pinned} canPin={!m.threadRoot} onReact={() => setPickerFor(m.id)} onPin={() => void extras.togglePin(id, !pinned)} />
        }
      : undefined
  const renderMeta = (m: AgentMessage) => (extras.pinned.has(Number(m.id)) ? <PinnedMark /> : null)

  // What each agent message's sender ran, and whose terminals it reached.
  const agentMessageIds = messages
    .filter((m) => m.status === "posted" && agentNames.has(m.from))
    .map((m) => Number(m.id))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(-100)
  const tools = useMessageTools(channelId, agentMessageIds)
  const posted = messages
    .filter((m) => m.status === "posted")
    .map((m) => ({ id: Number(m.id), createdAt: m.createdAt ?? null }))
    .filter((m) => Number.isInteger(m.id) && m.id > 0)
    .slice(-100)
  const deliveries = useDeliveries(channelId, posted)
  const renderFooter = (m: AgentMessage) => (
    <>
      <ToolsLine tools={tools[m.id]} />
      {extras.supported ? (
        <ReactionRow
          reactions={extras.reactions[m.id] ?? []}
          picking={pickerFor === m.id}
          readOnly={readOnly}
          onToggle={(emoji) => void extras.react(Number(m.id), emoji)}
          onPick={() => setPickerFor(m.id)}
          onClosePicker={() => setPickerFor(null)}
        />
      ) : null}
      <DeliveredLine deliveries={deliveries[m.id]} />
    </>
  )

  // "X is writing".
  const typers = useTypers(currentUser ? `user:${currentUser.id}` : null)
  const signalTyping = TYPING_LIVE && canSignalTyping && channelId != null && !readOnly

  // @mentions open the person: in the caller's panel, or on their page.
  const showActor = onShowActor ?? ((kind: "user" | "agent", id: number) => navigate(kind === "agent" ? `/v3/agents/${id}` : `/v3/chat?user=${id}`))

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      {extras.pins?.length ? <PinBar key={channelId ?? 0} pins={extras.pins} onJump={jump} /> : null}
      <ActorMentionContext.Provider value={showActor}>
        <AgentsConversationView
          {...context}
          bare
          readOnly={readOnly}
          messageLayout="row"
          composerStyle="v3"
          renderAvatar={renderAvatar}
          senderBadge={senderBadge}
          renderActions={renderActions}
          renderFooter={renderFooter}
          renderMeta={renderMeta}
          messageHighlight={(m) => (currentUser && m.from !== "user" && mentionsUser(m.body, currentUser.id) ? "me" : m.priority === "blocking" ? "urgent" : null)}
          onOpenThread={channelId ? openThread : undefined}
          threadSummaries={threadSummaries}
          mayDrive={(id) => mayDrive(id) !== false}
          onComposerInput={signalTyping ? () => void sendTyping(channelId!) : undefined}
          aboveComposer={TYPING_LIVE && channelId != null ? <TypingLine text={typingText(typers.get(channelId) ?? [])} /> : null}
          {...viewProps}
        />
      </ActorMentionContext.Provider>
      {!onOpenThread && channelId != null ? (
        <Sheet open={sheetThread != null} onOpenChange={(o) => !o && setSheetThread(null)}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <SheetTitle className="sr-only">Thread</SheetTitle>
            {sheetThread != null ? <ThreadPanel key={`${channelId}:${sheetThread}`} channel={channelId} root={sheetThread} currentUser={currentUser} onClose={() => setSheetThread(null)} openedByTap /> : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}
