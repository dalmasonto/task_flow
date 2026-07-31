import { useIsBelowLg } from "@/hooks/use-mobile"
import { AgentsConversationView } from "@/components/chat/conversation-view"
import { BotIcon, InboxIcon, PlusIcon, UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { NewConversationPanel, type ConversationCandidate } from "@/components/chat/new-conversation"
import { Outlet, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { PROJECT_ROOM_TITLE, type AgentChatContext, type AgentTerminalSessionView, type MessagePriority, type Project, type TargetMember, countMemberType } from "@/lib/workspace-view"
import { agentStatusClass } from "@/lib/workspace-view"
import { chatIdToSlug, liveId, slugToChatId, upsertById } from "@/lib/live-mappers"
import { cn } from "@/lib/utils"
import { createTaskflowChannel, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { type AuthUser } from "@/lib/auth-api"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { useEffect, useMemo, useState } from "react"


/// The data + handlers the layout hands to whichever conversation route renders
/// in its <Outlet/>. `selectedChat` is resolved from the route param upstream;
/// it is null on the index route or when the param doesn't match a real chat.
export type AgentsOutletContext = {
  selectedChat: AgentChatContext | null
  selectedSession?: AgentTerminalSessionView
  onSendMessage: (chat: AgentChatContext, body: string, priority: MessagePriority, files: File[], targets?: TargetMember[]) => void
  onRetryMessage: (nonce: string) => void
  onCancelMessage: (nonce: string) => void
  canManageMembers: boolean
  addMemberCandidates: { user: number; name: string }[]
  onAddMember: (userId: number) => Promise<void>
  currentUser: AuthUser | null
  /// The question the selected agent is blocked on, if any.
  pendingPrompt?: TaskflowWorkspace["agentPrompts"][number]
  onAnswerPrompt: (promptId: number, answers: number[][], cancel?: boolean, texts?: (string | null)[]) => Promise<void>
  /// #56: fetch the next page of older messages for the open conversation.
  onLoadOlder: () => void
  /// Turn a message into a task — first line as the title, the rest as the body.
  onCreateTask: (body: string) => void
  /// #107: edit your OWN message. Resolves when the server has the new body;
  /// rejects with the server's reason so the editor can stay open on failure.
  onEditMessage: (messageId: number, body: string) => Promise<void>
}


function useAgentsOutletContext() {
  return useOutletContext<AgentsOutletContext>()
}


/// The Agents page's route element: takes the outlet context the page provides
/// and hands it to the (now prop-driven) conversation view.
export function AgentsConversationRoute() {
  return <AgentsConversationView {...useAgentsOutletContext()} />
}


export function AgentsPage({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  onActive,
  onComposeTask,
}: {
  onActive?: (active: boolean) => void
  onComposeTask: (body: string) => void
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
}) {
  const navigate = useNavigate()
  const { conversationId } = useParams()
  const isBelowLg = useIsBelowLg()
  // #56: tell App this surface needs the chat slice, and release it on unmount.
  // Being mounted is the honest signal; a URL prefix is a guess about routing.
  useEffect(() => {
    onActive?.(true)
    return () => onActive?.(false)
  }, [onActive])
  // #55: the chat itself lives in useAgentChat so the dock can mount it too.
  // Destructured to the same names the render already used, so this page's
  // markup is untouched by the extraction. The conversation is addressed by the
  // route param here; the dock passes its own local selection instead.
  const { directChats, channelChats, selectedChat, messageError, outletContext } = useAgentChat({
    project,
    liveWorkspace,
    currentUser,
    onWorkspaceUpdate,
    onRefreshWorkspace,
    // Ids contain colons (e.g. "live:direct:2") and map to a clean URL slug
    // (`direct-2`) via chatIdToSlug/slugToChatId so the address bar stays
    // readable. null on the index route, or when the param doesn't resolve.
    selectedChatId: conversationId ? slugToChatId(conversationId) : null,
    onComposeTask,
  })
  // #42: explicit-conversation state — who you can start a chat with (project
  // members except yourself, plus every agent), and whether the picker is open.
  const [newConvoOpen, setNewConvoOpen] = useState(false)
  const conversationCandidates = useMemo<ConversationCandidate[]>(() => {
    if (!liveWorkspace) return []
    const users = liveWorkspace.members
      .filter((member) => member.status === "active" && member.user != null && member.user !== currentUser?.id)
      .map((member) => ({
        key: `user:${member.user}`,
        label: member.display_name,
        type: "user" as const,
        member: { kind: "user" as const, user: member.user as number },
      }))
    const agents = liveWorkspace.agents.map((agent) => ({
      key: `agent:${agent.id}`,
      label: agent.display_name,
      type: "agent" as const,
      member: { kind: "agent" as const, agent: agent.id },
    }))
    return [...users, ...agents]
  }, [liveWorkspace, currentUser])
  // Default to the project room (the first group chat) on the index route, so
  // the page opens on a conversation rather than the empty state. Falls back to
  // the first DM; the empty state shows only when there are no conversations.
  // Only auto-open on DESKTOP: on mobile the index route must land on the
  // full-screen conversation LIST so the user taps in deliberately (jumping
  // straight into a thread would hide the list behind a back button).
  useEffect(() => {
    if (conversationId || isBelowLg) return
    // Prefer the PROJECT ROOM explicitly. channelChats is ordered by title, so
    // "first channel" was really "alphabetically first" — a group called
    // "Announcements" would win over the room everyone actually talks in.
    const projectRoom = channelChats.find((chat) => chat.title === PROJECT_ROOM_TITLE)
    const first = projectRoom ?? channelChats[0] ?? directChats[0]
    if (first) navigate(chatIdToSlug(first.id), { replace: true })
  }, [conversationId, isBelowLg, channelChats, directChats, navigate])
  // #42: create a DM or group explicitly, then open it. The server dedups DMs
  // (find-or-create by roster), so starting a DM you already have just reopens
  // it. Throws on failure so the picker shows the reason.
  const createConversation = async (
    kind: "direct" | "group",
    title: string,
    members: ConversationCandidate["member"][]
  ) => {
    const projectId = liveId(project.id)
    if (!projectId) throw new Error("Select a live project first.")
    const channel = await createTaskflowChannel({ project: projectId, kind, title, members })
    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentChannels: upsertById(workspace.agentChannels, channel),
      agentChannelMembers: channel.members.reduce(
        (current, member) => upsertById(current, member),
        workspace.agentChannelMembers
      ),
    }))
    const chatId = `live:${kind === "direct" ? "direct" : "channel"}:${channel.id}`
    navigate(chatIdToSlug(chatId))
  }

  // The active conversation is addressed by the URL; clicking navigates so the
  // conversation is deep-linkable and the browser Back button works.
  const activeChatId = selectedChat?.id ?? ""
  const openChat = (chat: AgentChatContext) => navigate(chatIdToSlug(chat.id))

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 lg:p-4 xl:p-5">
      {messageError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {messageError}
        </p>
      ) : null}

      {/* Responsive master/detail. On mobile it's a single full-height pane:
          the list fills the screen on the index route and hides once a
          conversation is open (the thread takes over, with a back button). On
          lg+ both panes sit side-by-side as columns. The list stays mounted
          across the swap so its scroll position survives. */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)] lg:rounded-lg lg:border lg:bg-card lg:shadow-sm">
        {/* Conversation list — a persistent layout panel that stays mounted
            while the message area swaps via the <Outlet/> below. */}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/35 p-3 lg:border-r",
            conversationId ? "hidden lg:flex" : "flex"
          )}
        >
          <div className="relative shrink-0">
            {newConvoOpen ? (
              <button
                type="button"
                className="fixed inset-0 z-20 cursor-default"
                aria-label="Close new conversation"
                onClick={() => setNewConvoOpen(false)}
              />
            ) : null}
            <div className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="flex items-center gap-2">
                <InboxIcon className="size-4 text-primary" />
                Groups And DMs
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setNewConvoOpen((open) => !open)}
              >
                <PlusIcon className="size-3.5" />
                New
              </Button>
            </div>
            {newConvoOpen ? (
              <NewConversationPanel
                candidates={conversationCandidates}
                onCreate={createConversation}
                onClose={() => setNewConvoOpen(false)}
              />
            ) : null}
          </div>
          <div className="scrollbar-y mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-2 px-1 text-[0.7rem] font-semibold uppercase tracking-normal text-muted-foreground">
              <span>Group chats</span>
              <span>{channelChats.length}</span>
            </div>
            {channelChats.map((chat) => (
              <button
                key={chat.id}
                type="button"
                className={cn(
                  "w-full min-w-0 overflow-hidden p-3 text-left transition max-lg:border-b max-lg:border-border/60 max-lg:hover:bg-muted/40 lg:rounded-lg lg:border lg:border-border lg:bg-background lg:hover:border-primary/35",
                  activeChatId === chat.id && "max-lg:bg-muted lg:border-primary/50 lg:ring-2 lg:ring-primary/15"
                )}
                onClick={() => openChat(chat)}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                  {chat.unread ? (
                    <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                      {chat.unread > 99 ? "99+" : chat.unread}
                    </span>
                  ) : null}
                </div>
                <MarkdownRenderer
                  content={chat.detail}
                  compact
                  className="mt-1 w-full [&_p]:truncate [&_p]:text-xs"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60">
                    {chat.members.length} members
                  </span>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60">
                    {countMemberType(chat.members, "agent")} agents
                  </span>
                </div>
              </button>
            ))}
            <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3 px-1 text-[0.7rem] font-semibold uppercase tracking-normal text-muted-foreground">
              <span>DMs</span>
              <span>{directChats.length}</span>
            </div>
            {directChats.map((chat) => {
              // An agent DM carries liveAgentId; a human (member) DM carries
              // liveMemberUserId. Existing direct channels created against an
              // agent still carry liveAgentId, so the icon stays correct there too.
              const isAgentDm = Boolean(chat.liveAgentId)
              return (
                <button
                  key={chat.id}
                  type="button"
                  className={cn(
                    "w-full min-w-0 overflow-hidden p-3 text-left transition max-lg:border-b max-lg:border-border/60 max-lg:hover:bg-muted/40 lg:rounded-lg lg:border lg:border-border lg:bg-background lg:hover:border-primary/35",
                    activeChatId === chat.id && "max-lg:bg-muted lg:border-primary/50 lg:ring-2 lg:ring-primary/15"
                  )}
                  onClick={() => openChat(chat)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="relative shrink-0">
                      <span
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-full ring-1",
                          isAgentDm
                            ? "bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900/60"
                            : "bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60"
                        )}
                        aria-hidden
                      >
                        {isAgentDm ? <BotIcon className="size-4" /> : <UserIcon className="size-4" />}
                      </span>
                      {isAgentDm && chat.online !== undefined ? (
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background",
                            chat.online ? "bg-emerald-500" : "bg-muted-foreground/40"
                          )}
                          title={chat.online ? "Online" : "Offline"}
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                    <span className="shrink-0 text-[0.65rem] font-medium uppercase tracking-normal text-muted-foreground">
                      {isAgentDm ? "Agent" : "Member"}
                    </span>
                    {chat.unread ? (
                      <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                        {chat.unread > 99 ? "99+" : chat.unread}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{chat.detail}</p>
                  {/* Only an agent DM carries a meaningful status (connected/offline/…).
                      A human DM's status is just "Direct" — redundant under the DMS
                      header — so it's dropped. */}
                  {isAgentDm ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1", agentStatusClass(chat.status))}>
                        {chat.status}
                      </span>
                    </div>
                  ) : null}
                </button>
              )
            })}
            {directChats.length === 0 ? (
              <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                No direct messages yet. Use <span className="font-medium text-foreground">New</span> to start one.
              </p>
            ) : null}
          </div>
        </div>

        {/* Message area — route-addressable: index shows the empty state, a
            :conversationId child renders that conversation's messages. */}
        <Outlet context={outletContext} />
      </section>
    </section>
  )
}


/// Index-route element for /dashboard/agents: an honest empty state shown in the
/// message area before any conversation is opened. No message content loads here.
export function AgentsConversationEmpty() {
  return (
    // Desktop-only: on mobile the index route shows the full-screen conversation
    // list, so this empty state (the outlet's index element) is hidden there.
    <div className="hidden min-h-0 min-w-0 place-items-center p-8 text-center lg:grid">
      <div className="max-w-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <InboxIcon className="size-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Select a conversation</h2>
        <p className="mx-auto mt-2 text-sm leading-6 text-muted-foreground">
          Pick a group chat or a DM from the list to start messaging, share files, and inspect the active terminal session.
        </p>
      </div>
    </div>
  )
}
