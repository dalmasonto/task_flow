import { useIsBelowLg } from "@/hooks/use-mobile"
import { AgentsConversationView } from "@/components/chat/conversation-view"
import { ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, MinusIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { type AuthUser } from "@/lib/auth-api"
import { type Project } from "@/lib/workspace-view"
import { type TaskflowWorkspace } from "@/lib/taskflow-api"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { dockBodyFor } from "@/lib/chat-dock-state"
import { useCallback, useEffect, useState } from "react"


/// The status line the dock wears while it has no conversation to draw, and the
/// way out of it.
///
/// Both unknown-channels bodies draw this, because the escape is not only for
/// the failed state: a request that never ANSWERS leaves no failure to report
/// (nothing rejects), and a spinner with no way out of it is the thing this
/// replaces. The retry re-asks; it does not make the dock act on a placeholder.
function ChannelsStatus({
  failed,
  busy,
  onRetry,
}: {
  failed: boolean
  busy: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-3 pb-2.5">
      {failed ? (
        <TriangleAlertIcon className="size-4 shrink-0 text-amber-500" />
      ) : (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {failed ? "Couldn't load conversations" : "Loading conversations…"}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
        onClick={onRetry}
        disabled={busy}
        title="Ask for the project's conversations again"
      >
        Try again
      </button>
    </div>
  )
}


/// #55: the docked chat panel — message any agent or channel without leaving the
/// page you are on.
///
/// It mounts the SAME `useAgentChat` + `AgentsConversationView` the Agents page
/// uses, so every feature (@mentions, targeting, attachments, prompt cards)
/// works here too and cannot drift. Only the chrome differs: this draws its own
/// header with a conversation switcher, and the view runs in `compact`.
export function ChatDock({
  project,
  liveWorkspace,
  currentUser,
  onWorkspaceUpdate,
  onRefreshWorkspace,
  chatId,
  onChangeChat,
  onClose,
  onComposeTask,
}: {
  project: Project
  liveWorkspace: TaskflowWorkspace | null
  currentUser: AuthUser | null
  onWorkspaceUpdate: (updater: (workspace: TaskflowWorkspace) => TaskflowWorkspace) => void
  onRefreshWorkspace: () => Promise<void>
  chatId: string | null
  onChangeChat: (chatId: string) => void
  onClose: () => void
  onComposeTask: (body: string) => void
}) {
  const [minimised, setMinimised] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const isBelowLg = useIsBelowLg()
  // Whether `liveWorkspace`'s channel list is the server's answer. False while
  // the slice is in flight, which is when `mapLiveChannelChats` is synthesising.
  const channelsLoaded = liveWorkspace?.agentChannelsLoaded ?? false
  // The other half of that false: whether the read FAILED. Without it the two
  // are one flag, and a dock whose list cannot be read has nothing to say and
  // no reason to think anything will change — the retry budget is finite
  // (App.tsx's `MAX_SLICE_RETRIES`) and after it is spent, nothing re-asks.
  const channelsFailed = liveWorkspace?.agentChannelsFailed ?? false

  const body = dockBodyFor({
    minimised,
    channelsLoaded,
    channelsFailed: channelsFailed && !retrying,
    switcherOpen,
  })

  const { directChats, channelChats, allChats, selectedChat, messageError, outletContext } =
    useAgentChat({
      project,
      liveWorkspace,
      currentUser,
      onWorkspaceUpdate,
      onRefreshWorkspace,
      selectedChatId: chatId,
      onComposeTask,
    })

  // Nothing selected yet (first open, or the stored id no longer resolves):
  // fall back to the project room, then any DM, so the dock never opens empty.
  //
  // It waits for the channel list first, and that matters more than it looks.
  // With a cold slice `mapLiveChannelChats` returns ONE synthesised chat
  // (`live:project-room`), so this effect used to select a room that does not
  // exist — and because the selection is persisted, it OVERWROTE the stored
  // conversation with the placeholder id, deterministically, on every open: the
  // dock could not return you to the conversation it had remembered. Once the
  // real list lands, the stored id can be resolved, which is what this effect is
  // for. `allChats` is non-empty in both cases, so this cannot be expressed as
  // an emptiness check.
  useEffect(() => {
    if (selectedChat || !allChats.length) return
    if (!channelsLoaded) return
    const first = channelChats[0] ?? directChats[0]
    if (first) onChangeChat(first.id)
  }, [selectedChat, allChats, channelChats, directChats, channelsLoaded, onChangeChat])

  // The way out of the unknown-channels state: re-ask. `onRefreshWorkspace`
  // reloads the project's core workspace, which invalidates every loaded slice
  // — so the channel fetch runs again — and it is the app's existing "load this
  // project again" gesture rather than a second mechanism. `retrying` is what
  // makes the click do something visible immediately: the status line returns
  // to the spinner under the user's finger, instead of sitting on an error they
  // have just acted on.
  const retryChannels = useCallback(async () => {
    setRetrying(true)
    try {
      await onRefreshWorkspace()
    } finally {
      setRetrying(false)
    }
  }, [onRefreshWorkspace])

  if (!allChats.length) return null

  // Two frames, not four: the conversation gets the panel; collapsed, loading
  // and failed all get the BAR, and their bodies are drawn inside it. The
  // unknown-channels states used to be a card of their own, which is how a
  // minimised dock expanded itself back into a full loading panel.
  const bar = "bottom-4 right-4 h-auto w-[min(18rem,calc(100vw-2rem))]"
  // On a narrow screen a 380px corner panel is most of the viewport anyway, so
  // it takes the whole screen rather than fighting the page for room.
  // Sized to be a usable chat rather than a notification corner: the composer
  // carries a target picker, priority and attachments, and threads have code and
  // images in them. Still capped against the viewport so it never overruns a
  // small screen.
  const frame =
    body === "switcher" || body === "conversation"
      ? isBelowLg
        ? "inset-2"
        : "bottom-4 right-4 w-[min(28rem,calc(100vw-2rem))] h-[min(52rem,calc(100vh-2rem))]"
      : bar

  return (
    <section
      role="dialog"
      aria-label="Chat"
      className={cn(
        // Above the task sheet and the task-ref notice (both z-50 over a z-40
        // backdrop). It has to be: "Message agent" lives INSIDE the task sheet,
        // so at z-40 clicking it opened the dock behind the very sheet you
        // clicked from — the feature was unreachable.
        "fixed z-[60] flex flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl",
        frame
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
        {channelsLoaded ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => setSwitcherOpen((open) => !open)}
            aria-expanded={switcherOpen}
            title="Switch conversation"
          >
            <span className="truncate text-sm font-semibold">
              {selectedChat?.title ?? "Chat"}
            </span>
            <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition", switcherOpen && "rotate-180")} />
          </button>
        ) : (
          // No switcher until the list is real: its one row would be the
          // synthesised project room, and choosing that row persists it over
          // the conversation the dock remembered. The title stays (it is null
          // while nothing is selected, and falls back to "Chat").
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold">
            {selectedChat?.title ?? "Chat"}
          </span>
        )}
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setMinimised((value) => !value)}
          title={minimised ? "Expand" : "Minimise"}
          aria-label={minimised ? "Expand chat" : "Minimise chat"}
        >
          {minimised ? <ChevronUpIcon className="size-4" /> : <MinusIcon className="size-4" />}
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
          title="Close chat"
          aria-label="Close chat"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      {body === "collapsed" ? null : body === "loading" || body === "failed" ? (
        <ChannelsStatus failed={body === "failed"} busy={retrying} onRetry={retryChannels} />
      ) : body === "switcher" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {[
            { label: "Channels", chats: channelChats },
            { label: "Direct messages", chats: directChats },
          ].map((group) =>
            group.chats.length ? (
              <div key={group.label} className="mb-1">
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                {group.chats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                      chat.id === selectedChat?.id && "bg-muted font-medium"
                    )}
                    onClick={() => {
                      onChangeChat(chat.id)
                      setSwitcherOpen(false)
                    }}
                  >
                    <span className="truncate">{chat.title}</span>
                    {chat.unread ? (
                      <span className="shrink-0 rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground">
                        {chat.unread}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {messageError ? (
            <p className="border-b bg-rose-50 px-3 py-1.5 text-xs text-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
              {messageError}
            </p>
          ) : null}
          <AgentsConversationView {...outletContext} variant="compact" />
        </div>
      )}
    </section>
  )
}
