import { AgentChatBubble, StagedFileList } from "@/components/chat/bubbles"
import { AgentPromptCard } from "@/components/chat/prompt-card"
import { AgentTerminalPanel } from "@/components/chat/terminal"
import { AgentsConversationEmpty, type AgentsOutletContext } from "@/pages/agents"
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, MoreHorizontalIcon, PaperclipIcon, RadioIcon, SendIcon, SmileIcon, TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MESSAGE_PAGE_SIZE, buildThreadItems } from "@/lib/live-mappers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { composerEmojiGroups, messagePriorityOptions, type MessagePriority, type StagedFile, type TargetMember } from "@/lib/workspace-view"
import { detectMention } from "@/lib/mention"
import { fileReferenceText, spliceAtCaret } from "@/lib/composer"
import { markChannelRead } from "@/lib/taskflow-api"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type UIEvent } from "react"
import { useNavigate } from "react-router-dom"


/// #55: the conversation view reads its inputs from PROPS, not from the router
/// outlet, so it can be mounted somewhere that has no route of its own — the
/// chat dock. `AgentsConversationRoute` below keeps the Agents page unchanged by
/// feeding it the outlet context.
///
/// `variant` only tunes density: "compact" is the same component with the same
/// features in a ~380px panel. Splitting it into a second, simpler chat is what
/// would let the two drift.
export function AgentsConversationView({
  selectedChat,
  selectedSession,
  onSendMessage,
  onRetryMessage,
  onCancelMessage,
  canManageMembers,
  addMemberCandidates,
  onAddMember,
  pendingPrompt,
  onAnswerPrompt,
  onLoadOlder,
  onCreateTask,
  onEditMessage,
  currentUser,
  variant = "full",
}: AgentsOutletContext & { variant?: "full" | "compact" }) {
  const compact = variant === "compact"
  const navigate = useNavigate()

  const [draftMessage, setDraftMessage] = useState("")
  const [messagePriority, setMessagePriority] = useState<MessagePriority>("normal")
  // #29: in a group channel, direct a message at one or more members — agents
  // (routed to their pane) and/or users (a mention). Empty = broadcast.
  const [targetMembers, setTargetMembers] = useState<TargetMember[]>([])
  // #29: the in-progress `@mention` (an `@` being typed), for the member picker.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  // #29: the "To:" multi-select popover open state.
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const canSendMessage = draftMessage.trim().length > 0 || stagedFiles.length > 0
  const focusComposer = () => {
    composerRef.current?.focus()
  }

  // Auto-grow the single-line pill textarea with its content, up to ~136px.
  useEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 136)}px`
  }, [draftMessage])

  // Restore the caret after an emoji is spliced into the draft.
  useEffect(() => {
    if (pendingCaret.current === null || !composerRef.current) return
    composerRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [draftMessage])

  /// Insert text at the caret, replacing any selection, and put the caret after
  /// it once React has re-rendered (see the `pendingCaret` effect above).
  /// Shared by the emoji picker and the newline shortcuts so the caret cannot
  /// jump to the end on one path and not the other.
  const insertAtCaret = (text: string) => {
    const textarea = composerRef.current
    const start = textarea?.selectionStart ?? draftMessage.length
    const end = textarea?.selectionEnd ?? draftMessage.length
    const { value, caret } = spliceAtCaret(draftMessage, start, end, text)
    pendingCaret.current = caret
    setDraftMessage(value)
    textarea?.focus()
  }

  const insertEmoji = (emoji: string) => insertAtCaret(emoji)

  // Clicking a staged file drops [its-name] at the caret, so a message can point
  // at one specific attachment among several.
  const insertFileReference = (name: string) => insertAtCaret(fileReferenceText(name))

  // #29: every addressable member of the room — agents (pane delivery) and users
  // (mention). A member with no id is not a target and is dropped, and YOU are
  // dropped too: you address other people, never yourself, so the current user
  // is never in the pick list (this is why your own name showed up before).
  const roomTargets: TargetMember[] = (selectedChat?.members ?? [])
    .map((member): TargetMember | null => {
      if (member.type === "agent" && member.agentId != null)
        return { kind: "agent", id: member.agentId, name: member.name }
      if (member.type === "human" && member.userId != null)
        return { kind: "user", id: member.userId, name: member.name }
      return null
    })
    .filter((t): t is TargetMember => t !== null)
    .filter((t) => !(t.kind === "user" && currentUser != null && t.id === currentUser.id))
    // Agents first, since only they can be directed to a pane.
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1))

  const isTargeted = (t: TargetMember) =>
    targetMembers.some((m) => m.kind === t.kind && m.id === t.id)

  const addTarget = (t: TargetMember) =>
    setTargetMembers((prev) => (prev.some((m) => m.kind === t.kind && m.id === t.id) ? prev : [...prev, t]))

  const toggleTarget = (t: TargetMember) =>
    setTargetMembers((prev) =>
      prev.some((m) => m.kind === t.kind && m.id === t.id)
        ? prev.filter((m) => !(m.kind === t.kind && m.id === t.id))
        : [...prev, t]
    )

  // The room's targets matching the in-progress @mention (by display name),
  // online or offline, so anyone can always be addressed.
  const mentionMembers = mention
    ? roomTargets.filter((t) => t.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : []

  const selectMention = (target: TargetMember) => {
    if (!mention) return
    const textarea = composerRef.current
    const caret = textarea?.selectionStart ?? draftMessage.length
    const token = `@${target.name} `
    const next = draftMessage.slice(0, mention.start) + token + draftMessage.slice(caret)
    pendingCaret.current = mention.start + token.length
    setDraftMessage(next)
    // Picking a member from the @ list both writes the mention and adds them as a
    // target: an agent gets pane delivery (on reconnect if offline), a user is
    // recorded as an addressed mention.
    addTarget(target)
    setMention(null)
    textarea?.focus()
  }

  // The terminal stays CLOSED by default and is opened on demand from the header
  // terminal icon, showing as an overlay over the chat area. Switching
  // conversations closes it so the new chat starts clean. Resetting during
  // render (rather than in an effect) is the React-blessed "adjust state when a
  // prop changes" pattern and avoids a set-state-in-effect lint error.
  const chatKey = selectedChat?.id ?? ""
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalChatId, setTerminalChatId] = useState(chatKey)
  // Client-side window: the thread renders only the last `visibleCount` messages
  // and reveals another page of MESSAGE_PAGE_SIZE as the user scrolls to the top.
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  if (terminalChatId !== chatKey) {
    setTerminalChatId(chatKey)
    setTerminalOpen(false)
    // A directed target is per-conversation; switching chats resets it.
    setTargetMembers([])
    setMention(null)
    setTargetPickerOpen(false)
    // Switching conversations starts a fresh window at the most recent page.
    setVisibleCount(MESSAGE_PAGE_SIZE)
  }

  // Keep the thread pinned to the latest message: scroll to the bottom when the
  // conversation changes or a new message arrives (optimistic send, echo, or a
  // realtime message from someone else). Keyed on the TOTAL message count (and
  // chatKey), NOT on visibleCount — revealing older messages must preserve the
  // reading position (see the reveal anchor below), not jump to the bottom.
  const messageCount = selectedChat?.messages.length ?? 0
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatKey, messageCount])

  // Mark-read: advance the current user's read cursor to the newest SAVED message
  // whenever this thread is open (mount / channel switch / a new message lands).
  // Only real channels with a real latest message id qualify — a pending bubble
  // has no server id yet. Debounced so a burst of arrivals fires at most one POST
  // once activity settles, and best-effort (a failed cursor update is silent).
  const liveChannelId = selectedChat?.liveChannelId ?? null
  const latestReadableMessageId = useMemo(() => {
    if (!selectedChat) return null
    for (let index = selectedChat.messages.length - 1; index >= 0; index -= 1) {
      const message = selectedChat.messages[index]
      if (message.status !== "posted") continue
      const numericId = Number(message.id)
      if (Number.isFinite(numericId)) return numericId
    }
    return null
  }, [selectedChat])
  useEffect(() => {
    if (!liveChannelId || latestReadableMessageId == null) return
    const timer = setTimeout(() => {
      void markChannelRead(liveChannelId, latestReadableMessageId).catch(() => {})
    }, 800)
    return () => clearTimeout(timer)
  }, [liveChannelId, latestReadableMessageId])

  // The window shows the last N messages; a new message lands at the end, so it
  // is always inside the window and the bottom-scroll effect above reveals it.
  const windowedMessages = useMemo(
    () => (selectedChat ? selectedChat.messages.slice(Math.max(0, messageCount - visibleCount)) : []),
    [selectedChat, messageCount, visibleCount]
  )
  const hasMoreOlder = visibleCount < messageCount

  // Reverse-infinite-scroll anchor: revealing older messages grows the container
  // at the top, which would shove the reading position down. We snapshot the
  // pre-growth scrollHeight on the scroll that triggers a reveal, then — after
  // the DOM grows — add the height delta back onto scrollTop so the messages the
  // user was reading stay exactly in place (no jump to the top).
  const pendingRevealAnchor = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = threadRef.current
    const anchor = pendingRevealAnchor.current
    if (el && anchor != null) {
      el.scrollTop += el.scrollHeight - anchor
      pendingRevealAnchor.current = null
    }
  }, [visibleCount])

  const handleThreadScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    // #56: everything fetched is already revealed — ask the server for older.
    if (el.scrollTop < 48 && visibleCount >= messageCount) onLoadOlder()
    if (el.scrollTop < 48 && visibleCount < messageCount) {
      pendingRevealAnchor.current = el.scrollHeight
      setVisibleCount((current) => Math.min(current + MESSAGE_PAGE_SIZE, messageCount))
    }
  }

  // Revoke every staged preview URL when the composer unmounts so switching
  // chats mid-compose doesn't leak object URLs.
  useEffect(() => {
    return () => {
      setStagedFiles((current) => {
        for (const staged of current) {
          if (staged.previewUrl) URL.revokeObjectURL(staged.previewUrl)
        }
        return current
      })
    }
  }, [])

  /// Stage files for upload. The picker and drag-and-drop both land here so the
  /// two entry points cannot drift on preview URLs, id shape, or which types get
  /// a thumbnail — a dropped image must behave exactly like a picked one.
  const stageFiles = (incoming: File[]) => {
    if (!incoming.length) return
    setStagedFiles((current) => [
      ...current,
      ...incoming.map((file) => ({
        id: `staged:${Date.now()}:${file.name}:${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ])
  }

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    stageFiles(Array.from(event.target.files ?? []))
    // Reset so picking the same file again re-fires change.
    event.target.value = ""
  }

  // Drag-and-drop onto the conversation. `dragenter`/`dragleave` fire for every
  // child element the cursor crosses, so a boolean would flicker off the moment
  // the pointer moved from the thread onto a message bubble. Counting enters
  // against leaves tracks the section as a whole.
  const dragDepth = useRef(0)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)

  /// Only FILE drags. Dragging selected text, a link, or one of the board's
  /// cards also fires these events, and offering to "drop files here" for a text
  /// selection would be a lie.
  const isFileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files")

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setIsDraggingFiles(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    // Without preventDefault the browser refuses the drop and opens the file in
    // a new tab instead — the default action for a dragged file.
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDraggingFiles(false)
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setIsDraggingFiles(false)
    stageFiles(Array.from(event.dataTransfer.files ?? []))
    // The files are staged, not sent — the composer keeps them so the user can
    // add a message, review, or remove one before sending.
    requestAnimationFrame(focusComposer)
  }

  const removeStagedFile = (id: string) => {
    setStagedFiles((current) => {
      const target = current.find((staged) => staged.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return current.filter((staged) => staged.id !== id)
    })
  }

  const handleSendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedChat) return
    const trimmedMessage = draftMessage.trim()
    if (!trimmedMessage && stagedFiles.length === 0) return

    onSendMessage(
      selectedChat,
      trimmedMessage,
      messagePriority,
      stagedFiles.map((staged) => staged.file),
      selectedChat.mode === "channel" ? targetMembers : []
    )
    // Revoke the composer's own preview URLs; the optimistic bubble mints its
    // own from the same File objects, so these are no longer needed.
    for (const staged of stagedFiles) {
      if (staged.previewUrl) URL.revokeObjectURL(staged.previewUrl)
    }
    setDraftMessage("")
    setStagedFiles([])
    setMessagePriority("normal")
    setEmojiPickerOpen(false)
    setTargetMembers([])
    setTargetPickerOpen(false)
    requestAnimationFrame(focusComposer)
  }

  // A hand-typed or stale conversation id doesn't resolve to a chat — show the
  // same empty state as the index route rather than a broken thread.
  if (!selectedChat) {
    return <AgentsConversationEmpty />
  }

  const chatLabel = selectedChat.mode === "channel" ? "Group chat" : "DM"

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop affordance. Rendered only while a file drag is in flight, and
          pointer-events-none so it cannot swallow the drop it is advertising —
          the events stay on the section underneath. */}
      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/80 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 text-center">
            <PaperclipIcon className="h-7 w-7 text-primary" />
            <p className="text-sm font-medium text-foreground">Drop files to attach</p>
            <p className="text-xs text-muted-foreground">
              They'll be added to your message — nothing sends until you do.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* #55: the dock draws its own header (title, switcher, minimise,
            close), so this one would be a second title bar in a 380px panel. */}
        <div className={cn("flex items-center justify-between gap-3 border-b px-4 py-3", compact && "hidden")}>
          <div className="flex min-w-0 items-center gap-2">
            {/* Mobile-only back control: returns to the full-screen list. On
                lg+ the list is always visible beside the thread, so it's hidden. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-1 shrink-0 lg:hidden"
              onClick={() => navigate("/dashboard/agents")}
            >
              <ArrowLeftIcon />
              <span className="sr-only">Back to conversations</span>
            </Button>
            <h2 className="truncate text-sm font-semibold">{selectedChat.title}</h2>
            <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
              {chatLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTerminalOpen((open) => !open)}
              aria-label="Toggle terminal"
              title="Terminal"
            >
              <TerminalIcon />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
                    <MoreHorizontalIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Add member</DropdownMenuLabel>
                  {canManageMembers ? (
                    addMemberCandidates.length === 0 ? (
                      <p className="px-1.5 py-2 text-xs text-muted-foreground">
                        Everyone in the project is already here.
                      </p>
                    ) : (
                      addMemberCandidates.map((candidate) => (
                        <DropdownMenuItem
                          key={candidate.user}
                          onClick={() => {
                            void onAddMember(candidate.user).catch(() => {})
                          }}
                        >
                          {candidate.name}
                        </DropdownMenuItem>
                      ))
                    )
                  ) : (
                    <p className="px-1.5 py-2 text-xs text-muted-foreground">
                      You can't manage members here.
                    </p>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          ref={threadRef}
          onScroll={handleThreadScroll}
          className="chat-thread-bg scrollbar-y min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        >
          {hasMoreOlder ? (
            <div className="pb-1 text-center text-xs text-muted-foreground/70">Scroll up for older messages</div>
          ) : messageCount > 0 ? (
            <div className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground/50">
              Beginning of conversation
            </div>
          ) : null}
          {buildThreadItems(windowedMessages).map((item) =>
            item.type === "date" ? (
              <div
                key={item.key}
                className="sticky top-0 z-10 -mx-4 flex items-center justify-center bg-gradient-to-b from-background via-background/85 to-transparent px-4 py-1"
              >
                <span className="rounded-full bg-muted px-3 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {item.label}
                </span>
              </div>
            ) : (
              <AgentChatBubble
                key={item.message.id}
                message={item.message}
                onRetry={onRetryMessage}
                onCancel={onCancelMessage}
                onCreateTask={onCreateTask}
                onEdit={onEditMessage}
              />
            )
          )}
        </div>

        {pendingPrompt ? (
          <div className="shrink-0 border-t bg-background px-3 pt-3">
            <AgentPromptCard prompt={pendingPrompt} onAnswer={onAnswerPrompt} />
          </div>
        ) : null}

        <form className="shrink-0 border-t bg-background p-3" onSubmit={handleSendMessage}>
          {emojiPickerOpen ? (
            <button
              type="button"
              className="fixed inset-0 z-20 cursor-default"
              aria-label="Close emoji picker"
              onClick={() => setEmojiPickerOpen(false)}
            />
          ) : null}

          <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border/75 bg-background/90 px-2 py-2 shadow-inner transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25">
            {stagedFiles.length ? (
              <div className="px-1">
                <StagedFileList
                  files={stagedFiles}
                  onRemove={removeStagedFile}
                  onReference={(staged) => insertFileReference(staged.file.name)}
                />
              </div>
            ) : null}

            <div className="relative">
            {/* #29: typing `@` surfaces everyone in the room — humans and agents,
                online or offline — so anyone can be addressed by picking from a
                list instead of typing a long, spaced handle by hand. */}
            {mentionMembers.length ? (
              <div className="absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  Mention
                </div>
                {mentionMembers.map((target) => (
                  <button
                    key={`${target.kind}:${target.id}`}
                    type="button"
                    // Mousedown (not click) so the textarea keeps focus and its
                    // caret — click would blur first and lose the insert point.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      selectMention(target)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="truncate">{target.name}</span>
                    {isTargeted(target) ? (
                      <CheckIcon className="ml-auto size-3.5 shrink-0 text-primary" />
                    ) : null}
                    <span className={cn("shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground", !isTargeted(target) && "ml-auto")}>
                      {target.kind}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={composerRef}
              rows={1}
              className="max-h-[8.5rem] min-h-9 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground"
              placeholder={`Message ${selectedChat.title}…`}
              value={draftMessage}
              onChange={(event) => {
                const value = event.target.value
                setDraftMessage(value)
                // #29: opening/updating an @mention as the human types.
                setMention(detectMention(value, event.target.selectionStart ?? value.length))
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                // An IME uses Enter to accept a candidate. Submitting there
                // would send half-composed text and swallow the keystroke that
                // was meant to finish the word.
                if (event.nativeEvent.isComposing) return

                // Alt+Enter inserts a newline. Shift+Enter already did, via the
                // textarea's own default, but Alt+Enter has no default insert to
                // fall through to — so it is done explicitly rather than left to
                // the browser, which varies by platform.
                if (event.altKey) {
                  event.preventDefault()
                  insertAtCaret("\n")
                  return
                }

                // Shift+Enter: let the textarea insert the newline itself.
                if (event.shiftKey) return

                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }}
            />
            </div>

            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-0.5">
                <div className="relative">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-xl"
                    aria-label="Emoji"
                    onClick={() => setEmojiPickerOpen((open) => !open)}
                  >
                    <SmileIcon />
                  </Button>

                  {emojiPickerOpen ? (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[21rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-2xl">
                      <div className="grid gap-3">
                        {composerEmojiGroups.map((group) => (
                          <div key={group.label}>
                            <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                              {group.label}
                            </div>
                            <div className="grid grid-cols-8 gap-1">
                              {group.emojis.map((emoji) => (
                                <button
                                  key={`${group.label}-${emoji}`}
                                  type="button"
                                  className="flex size-8 items-center justify-center rounded-lg text-lg transition-colors hover:bg-accent"
                                  onClick={() => insertEmoji(emoji)}
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />

                {/* #29: in a group channel, direct the message at one or more
                    members — agents (their pane) and/or users (a mention) —
                    instead of broadcasting to every agent. Mirrors the @ list. */}
                {selectedChat.mode === "channel" && roomTargets.length ? (
                  <div className="relative">
                    {targetPickerOpen ? (
                      <button
                        type="button"
                        className="fixed inset-0 z-20 cursor-default"
                        aria-label="Close recipients"
                        onClick={() => setTargetPickerOpen(false)}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setTargetPickerOpen((open) => !open)}
                      aria-label="Choose who this message is for"
                      className={cn(
                        "ml-0.5 flex max-w-[12rem] items-center gap-1 rounded-lg border px-2 py-1 text-xs",
                        targetMembers.length
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground"
                      )}
                    >
                      <span className="truncate">
                        {targetMembers.length === 0
                          ? "To: everyone"
                          : targetMembers.length === 1
                            ? `To: ${targetMembers[0].name}`
                            : `To: ${targetMembers.length} members`}
                      </span>
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    </button>
                    {targetPickerOpen ? (
                      <div className="absolute bottom-full left-0 z-30 mb-2 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl">
                        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                          Direct to
                        </div>
                        <button
                          type="button"
                          onClick={() => setTargetMembers([])}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                        >
                          <span className="truncate">Everyone</span>
                          {targetMembers.length === 0 ? (
                            <CheckIcon className="ml-auto size-3.5 shrink-0 text-primary" />
                          ) : null}
                        </button>
                        {roomTargets.map((target) => (
                          <button
                            key={`${target.kind}:${target.id}`}
                            type="button"
                            onClick={() => toggleTarget(target)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                          >
                            <span className="truncate">{target.name}</span>
                            {isTargeted(target) ? (
                              <CheckIcon className="ml-auto size-3.5 shrink-0 text-primary" />
                            ) : null}
                            <span
                              className={cn(
                                "shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground",
                                !isTargeted(target) && "ml-auto"
                              )}
                            >
                              {target.kind}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl"
                  aria-label="Attach file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl"
                  aria-label="Broadcast"
                >
                  <RadioIcon />
                </Button>

                <Select
                  value={messagePriority}
                  onValueChange={(value) => setMessagePriority(value as MessagePriority)}
                  items={messagePriorityOptions}
                >
                  <SelectTrigger
                    className="w-auto gap-1 border-0 bg-transparent text-xs shadow-none"
                    aria-label="Message priority"
                  >
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {messagePriorityOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="submit"
                size="icon-lg"
                className="rounded-2xl"
                disabled={!canSendMessage}
                aria-label="Send"
              >
                <SendIcon />
              </Button>
            </div>
          </div>
        </form>
      </div>

      {terminalOpen && !compact ? (
        // Opened from the header terminal icon: an overlay the size of the chat
        // column (anchored to the relative <section>), dismissable via its own
        // close (X) control, on every screen size.
        <AgentTerminalPanel
          selectedSession={selectedSession}
          onFocusComposer={focusComposer}
          onClose={() => setTerminalOpen(false)}
          className="absolute inset-0 z-30 bg-card shadow-xl animate-in slide-in-from-right duration-200"
        />
      ) : null}
    </section>
  )
}
