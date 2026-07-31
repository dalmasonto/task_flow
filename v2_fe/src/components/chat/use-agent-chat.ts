import { type AgentsOutletContext } from "@/pages/agents"
import { PROJECT_ROOM_TITLE, type AgentChatContext, type MessagePriority, type Project, type TargetMember } from "@/lib/workspace-view"
import { addChannelMember, answerAgentPrompt, createTaskflowChannel, editTaskflowAgentMessage, fetchChannelMessages, sendTaskflowAgentMessage, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { addPending, dismissPending, findPending, markFailed, markRetrying, reconcile, type PendingAttachment } from "@/lib/message-store"
import { liveId, mapLiveChannelChats, mapLiveDirectChats, mapLiveTerminalSessions, revokeBlobUrls, toLiveMessagePriority, upsertById } from "@/lib/live-mappers"
import { type AuthUser } from "@/lib/auth-api"
import { useCallback, useMemo, useRef, useState } from "react"
import { useLivenessNow } from "@/hooks/use-liveness-now"


/// #55: everything the chat needs, independent of where it is rendered.
///
/// This used to live inside `AgentsPage`, which meant chat only existed on that
/// route — to message an agent you left the board and came back. The logic is
/// unchanged; it just takes the selected conversation as an ARGUMENT instead of
/// reading the URL, so the Agents page can drive it from the route and the dock
/// can drive it from local state.
export function useAgentChat({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  selectedChatId,
  onComposeTask,
}: {
  onComposeTask: (body: string) => void
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
  selectedChatId: string | null
}) {
  const [messageError, setMessageError] = useState<string | null>(null)
  // `livenessNow` is passed in, not read inside: these mappers decide who is
  // online, and without a refreshing clock a silent agent keeps its last known
  // (green) state forever — no data changes, no re-map, no staleness.
  const livenessNow = useLivenessNow()
  const directChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveDirectChats(liveWorkspace, currentUser, livenessNow) : []),
    [currentUser, liveWorkspace, livenessNow]
  )
  const channelChats = useMemo<AgentChatContext[]>(
    () => (liveWorkspace ? mapLiveChannelChats(liveWorkspace, currentUser) : []),
    [currentUser, liveWorkspace]
  )
  const allChats = useMemo(() => [...channelChats, ...directChats], [channelChats, directChats])

  const selectedChat = useMemo<AgentChatContext | null>(
    () => (selectedChatId ? (allChats.find((chat) => chat.id === selectedChatId) ?? null) : null),
    [allChats, selectedChatId]
  )

  const terminalSessions = useMemo(
    () => (liveWorkspace ? mapLiveTerminalSessions(liveWorkspace, livenessNow) : []),
    [liveWorkspace, livenessNow]
  )
  // The terminal is an agent-only surface: resolve a session only when the
  // selected chat is an agent DM, and only for THAT agent (matched by the
  // agent's display name, which is how mapLiveTerminalSessions labels each
  // session). Non-agent conversations get no session, so the terminal shows its
  // honest empty state rather than some other agent's global first session.
  const selectedSession = useMemo(() => {
    if (!selectedChat?.liveAgentId) return undefined
    const agent = liveWorkspace?.agents.find((candidate) => candidate.id === selectedChat.liveAgentId)
    const agentName = agent?.display_name ?? selectedChat.primaryAgent
    return terminalSessions.find((session) => session.agent === agentName)
  }, [liveWorkspace, selectedChat, terminalSessions])

  const ensureLiveChannel = async (chat: AgentChatContext) => {
    if (chat.liveChannelId) return chat.liveChannelId
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    // The other participants; the server adds the caller. A DM is named for who
    // it is with: an agent DM rosters that agent, a human DM that person, and a
    // shared room every active member plus every agent.
    const members: Array<{ kind: "user"; user: number } | { kind: "agent"; agent: number }> = []
    if (chat.mode === "direct" && chat.liveMemberUserId) {
      members.push({ kind: "user", user: chat.liveMemberUserId })
    } else if (chat.mode === "direct") {
      const agentId = liveWorkspace.agents.find((c) => c.id === chat.liveAgentId)?.id ?? chat.liveAgentId
      if (agentId) members.push({ kind: "agent", agent: agentId })
    } else {
      for (const member of liveWorkspace.members) {
        if (member.status === "active" && member.user && member.user !== currentUser?.id) {
          members.push({ kind: "user", user: member.user })
        }
      }
      for (const agent of liveWorkspace.agents) members.push({ kind: "agent", agent: agent.id })
    }

    const channel = await createTaskflowChannel({
      project: projectId,
      kind: chat.mode === "direct" ? "direct" : "project",
      title: chat.mode === "direct" ? chat.title : PROJECT_ROOM_TITLE,
      topic: chat.detail,
      members,
    })

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentChannels: upsertById(workspace.agentChannels, channel),
      agentChannelMembers: channel.members.reduce(
        (current, member) => upsertById(current, member),
        workspace.agentChannelMembers
      ),
    }))
    return channel.id
  }

  const sendLiveMessage = async (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    files: File[],
    targets: TargetMember[] = []
  ) => {
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    const channelId = await ensureLiveChannel(chat)
    const nonce = crypto.randomUUID()

    // Local previews for the optimistic bubble: object URLs for images so the
    // thumbnail shows immediately; non-images render from name + size. These
    // URLs are revoked once the server echo replaces the pending bubble.
    const pendingAttachments: PendingAttachment[] = files.map((file, index) => ({
      id: `pending:${nonce}:${index}`,
      name: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
    }))
    const revokePreviews = () => {
      for (const attachment of pendingAttachments) {
        if (attachment.url) URL.revokeObjectURL(attachment.url)
      }
    }

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: addPending(workspace.agentMessages, {
        client_nonce: nonce,
        body_markdown: body,
        priority: toLiveMessagePriority(priority),
        channel: channelId,
        status: "pending",
        attachments: pendingAttachments,
      }),
    }))

    try {
      const saved = await sendTaskflowAgentMessage(
        {
          channel: channelId,
          body_markdown: body,
          priority: toLiveMessagePriority(priority),
          client_nonce: nonce,
          targets: targets.map((target) => ({ kind: target.kind, id: target.id })),
        },
        files
      )
      // Reconcile the response as well as the SSE echo. Whichever lands first
      // wins and the other is a no-op — they key on the same nonce. Relying on
      // the echo alone would strand the bubble as pending whenever SSE is down,
      // even though the message saved fine. The response also carries the stored
      // attachments, which we merge so the bubble swaps its object-URL previews
      // for the real /media links even if the attachment SSE frames never land.
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
        messageAttachments: saved.attachments.reduce(
          (rows, attachment) => upsertById(rows, attachment),
          workspace.messageAttachments
        ),
      }))
      revokePreviews()
    } catch (error) {
      // Keep the previews: the failed bubble still shows what was staged. Carry
      // the server's reason (e.g. "…too large…") onto the bubble so the user
      // learns WHY, not just that it failed.
      const reason = error instanceof Error ? error.message : undefined
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce, reason),
      }))
      throw error
    }
  }

  /// #107: edit your own message in place. The server stamps `edited_at` and
  /// fans an `updated` event out over realtime (which also redelivers to agent
  /// panes); reconcile the returned row immediately so the author is not
  /// waiting on their own echo.
  const editLiveMessage = async (messageId: number, body: string) => {
    const saved = await editTaskflowAgentMessage(messageId, body)
    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: reconcile(workspace.agentMessages, saved),
    }))
  }

  const retryLiveMessage = async (nonce: string) => {
    const failed = findPending(liveWorkspace?.agentMessages ?? [], nonce)
    if (!failed) return

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: markRetrying(workspace.agentMessages, nonce),
    }))

    try {
      const saved = await sendTaskflowAgentMessage({
        channel: failed.channel,
        body_markdown: failed.body_markdown,
        priority: failed.priority,
        client_nonce: nonce,          // same nonce: the send endpoint is idempotent
      })
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
        messageAttachments: saved.attachments.reduce(
          (rows, attachment) => upsertById(rows, attachment),
          workspace.messageAttachments
        ),
      }))
      // #44: the bubble now points at real /media links — free the old blob
      // previews the failed attempt was still showing.
      revokeBlobUrls(failed.attachments)
    } catch (error) {
      const reason = error instanceof Error ? error.message : undefined
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce, reason),
      }))
      setMessageError(reason ?? "Could not send the message.")
    }
  }

  // Drop a failed optimistic bubble from the view. The message never reached the
  // server (or was rejected), so there is nothing to delete server-side — just
  // remove the local pending row keyed by its nonce.
  const cancelLiveMessage = (nonce: string) => {
    // #44: free the failed bubble's blob previews before dropping the row.
    revokeBlobUrls(findPending(liveWorkspace?.agentMessages ?? [], nonce)?.attachments)
    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: dismissPending(workspace.agentMessages, nonce),
    }))
  }

  const handleSendMessage = (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    files: File[],
    targets: TargetMember[] = []
  ) => {
    const trimmedBody = body.trim()
    if (!trimmedBody && files.length === 0) return

    setMessageError(null)
    void sendLiveMessage(chat, trimmedBody, priority, files, targets).catch((error) => {
      setMessageError(error instanceof Error ? error.message : "Could not send the live message.")
    })
  }

  // Active project members who are not already on the selected LIVE channel.
  // "Already a member" is read straight from the channel's member rows (the same
  // data mapLiveChannelMembers renders), keyed by user id so display-name
  // collisions or a differing self-label never let someone be re-added by hand.
  const addMemberCandidates = useMemo<{ user: number; name: string }[]>(() => {
    const channelId = selectedChat?.liveChannelId
    if (!liveWorkspace || channelId == null) return []
    const existingUserIds = new Set(
      liveWorkspace.agentChannelMembers
        .filter((member) => member.channel === channelId && member.user != null)
        .map((member) => member.user as number)
    )
    return liveWorkspace.members
      .filter((member) => member.status === "active" && member.user != null && !existingUserIds.has(member.user))
      .map((member) => ({ user: member.user as number, name: member.display_name }))
  }, [liveWorkspace, selectedChat?.liveChannelId])

  const handleAddMember = async (userId: number) => {
    const channelId = selectedChat?.liveChannelId
    if (channelId == null) return
    await addChannelMember(channelId, userId)
    // Re-fetch so the roster, member counts, and candidate list all reflect the
    // new membership (mirrors how invite-accept re-syncs the workspace).
    await onRefreshWorkspace()
  }

  // The question THIS agent is blocked on. Newest pending wins: an agent can
  // only be stopped at one keypress at a time, and older pending rows are stale
  // (the terminal moved on without anyone answering here).
  const pendingPrompt = useMemo(() => {
    const agentId = selectedChat?.liveAgentId
    if (!agentId || !liveWorkspace) return undefined
    return liveWorkspace.agentPrompts
      .filter(
        (prompt) =>
          prompt.agent === agentId &&
          prompt.status === "pending" &&
          // #6: a targeted question is only for that user; an untargeted one
          // (the agent had no DM context) still shows to every member.
          (prompt.target_user == null || prompt.target_user === currentUser?.id)
      )
      .sort((a, b) => b.id - a.id)[0]
  }, [selectedChat, liveWorkspace, currentUser])

  // #56: last page fetched per channel. A ref for the same reasons as the board
  // cursor: it guards a fetch, must not be stale inside a scroll handler, and
  // has no business causing a render.
  const messagePages = useRef<Record<number, number>>({})
  const loadOlderMessages = useCallback(() => {
    const channelId = selectedChat?.liveChannelId
    if (channelId == null) return
    const nextPage = (messagePages.current[channelId] ?? 1) + 1
    // Claimed before the request: scrolling fires this repeatedly, and two hits
    // must not fetch the same page twice. Released on failure so it can retry.
    messagePages.current[channelId] = nextPage
    void fetchChannelMessages(channelId, nextPage)
      .then(({ rows }) => {
        if (!rows.length) return
        onWorkspaceUpdate((workspace) => ({
          ...workspace,
          // reconcile(), not upsertById: agentMessages holds optimistic
          // PendingMessage rows that have no id yet, and it is the merge the
          // realtime path already uses for saved rows.
          agentMessages: rows.reduce((current, row) => reconcile(current, row), workspace.agentMessages),
        }))
      })
      .catch(() => {
        messagePages.current[channelId] = nextPage - 1
      })
  }, [selectedChat?.liveChannelId, onWorkspaceUpdate])

  /// Capture a message as a task. Commitments made in conversation go missing
  /// because opening a form costs more than the sentence did; this makes it one
  /// click. Refreshes the workspace afterwards rather than merging locally —
  /// `tasks` and `liveWorkspace.tasks` are separate stores, and a local merge
  /// into one leaves the board showing the other.
  const createTaskFromMessage = onComposeTask

  const handleAnswerPrompt = useCallback(
    async (promptId: number, answers: number[][], cancel = false, texts: (string | null)[] = []) => {
      await answerAgentPrompt(promptId, answers, cancel, texts)
    },
    []
  )

  const outletContext: AgentsOutletContext = {
    selectedChat,
    selectedSession,
    onSendMessage: handleSendMessage,
    onRetryMessage: retryLiveMessage,
    onCancelMessage: cancelLiveMessage,
    canManageMembers: selectedChat?.liveChannelId != null && selectedChat.mode === "channel",
    addMemberCandidates,
    onAddMember: handleAddMember,
    currentUser,
    pendingPrompt,
    onAnswerPrompt: handleAnswerPrompt,
    onLoadOlder: loadOlderMessages,
    onCreateTask: createTaskFromMessage,
    onEditMessage: editLiveMessage,
  }

  return {
    directChats,
    channelChats,
    allChats,
    selectedChat,
    messageError,
    setMessageError,
    outletContext,
  }
}
