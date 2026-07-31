import { useIsBelowLg } from "@/hooks/use-mobile"
import { AgentsConversationView } from "@/components/chat/conversation-view"
import { ChevronDownIcon, ChevronUpIcon, MinusIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { type AuthUser } from "@/lib/auth-api"
import { type Project } from "@/lib/workspace-view"
import { type TaskflowWorkspace } from "@/lib/taskflow-api"
import { useAgentChat } from "@/components/chat/use-agent-chat"
import { useEffect, useState } from "react"


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
  const isBelowLg = useIsBelowLg()

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
  useEffect(() => {
    if (selectedChat || !allChats.length) return
    const first = channelChats[0] ?? directChats[0]
    if (first) onChangeChat(first.id)
  }, [selectedChat, allChats, channelChats, directChats, onChangeChat])

  if (!allChats.length) return null

  // On a narrow screen a 380px corner panel is most of the viewport anyway, so
  // it takes the whole screen rather than fighting the page for room.
  // Sized to be a usable chat rather than a notification corner: the composer
  // carries a target picker, priority and attachments, and threads have code and
  // images in them. Still capped against the viewport so it never overruns a
  // small screen.
  const frame = isBelowLg
    ? "inset-2"
    : "bottom-4 right-4 w-[min(28rem,calc(100vw-2rem))] h-[min(52rem,calc(100vh-2rem))]"

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
        minimised ? "bottom-4 right-4 h-auto w-[min(18rem,calc(100vw-2rem))]" : frame
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
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

      {minimised ? null : switcherOpen ? (
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
