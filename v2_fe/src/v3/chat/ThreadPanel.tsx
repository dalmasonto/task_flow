/// A chat thread (design: chat-thread.html): the root message, its replies
/// oldest first, and a reply box with "also send to the channel" (#1132).
///
/// The thread is read once over GET .../thread, then kept live from the
/// thread bus (App's one stream publishes every threaded row), so nothing
/// here opens a stream. A reply's audience is computed by the server: the
/// root's author, earlier repliers and anyone mentioned by chip.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { BellIcon, BellOffIcon, SendIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type { AuthUser } from "@/lib/auth-api"
import { MessageAttachments } from "@/components/message-attachments"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { mapStoredAttachment } from "@/lib/live-mappers"
import { sendTaskflowAgentMessage } from "@/lib/taskflow-api"
import { subscribeThreadEvents } from "@/lib/thread-bus"
import { fetchThread, type Thread, type ThreadMessage } from "@/lib/threads-api"
import { markThreadRead, setThreadFollowed } from "@/lib/chat-summary-api"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { focusComposerIn } from "./focus"
import { mergeThread } from "./thread-logic"

function Row({ m, me, now }: { m: ThreadMessage; me: number | null; now: number }) {
  const own = m.sender_kind === "user" && m.sender_user === me
  const name = own ? "You" : m.sender_label
  return (
    <li className="flex gap-2.5">
      <ActorAvatar model={m.sender_kind === "agent" ? guessModel(m.sender_label) : null} name={m.sender_label} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="font-medium">{name}</span> <span className="text-muted-foreground">{timeAgo(m.created_at, now) ?? ""}</span>
          {m.thread_root != null && m.in_channel ? <span className="ml-1.5 text-muted-foreground">· also sent to the channel</span> : null}
          {m.thread_root == null && m.reply_to != null ? <span className="ml-1.5 text-muted-foreground">· replied in the room</span> : null}
        </p>
        <MarkdownRenderer content={m.body_markdown} compact className="text-sm" />
        {m.attachments?.length ? (
          <div className="mt-2">
            <MessageAttachments attachments={m.attachments.map(mapStoredAttachment)} />
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function ThreadPanel({ channel, root, currentUser, onClose, following = null, onFollowChanged, openedByTap = false }: {
  channel: number
  /// #1092: opened by a click or tap (not a deep link), so even a touch
  /// screen may focus the reply box.
  openedByTap?: boolean
  root: number
  currentUser: AuthUser | null
  onClose: () => void
  /// #5983: whether I follow this thread; null on a server without follows
  /// (no Follow button, no read marks).
  following?: boolean | null
  onFollowChanged?: () => void
}) {
  const now = useLivenessNow()
  // #1092: opening a thread puts the cursor in its reply box (same guards as
  // the room composer). The panel is keyed per thread, so this runs per open.
  const replyForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const raf = requestAnimationFrame(() => focusComposerIn(replyForm.current, { byTap: openedByTap }))
    return () => cancelAnimationFrame(raf)
    // Once per open: the panel remounts for another thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const key = `${channel}:${root}`
  const [loaded, setLoaded] = useState<{ key: string; thread: Thread | null; error: string | null } | null>(null)
  const [draft, setDraft] = useState("")
  const [alsoSend, setAlsoSend] = useState(false)
  const [sending, setSending] = useState(false)
  // The root was deleted while open: its replies were released into the
  // channel (a column update, so no live event); say so instead of showing it.
  const [rootDeleted, setRootDeleted] = useState(false)
  const thread = loaded?.key === key ? loaded.thread : null
  // Agents usually answer with a quoted reply in the room (reply_to), not a
  // thread reply, so a thread on their question looked empty. Show those
  // too, in time order with the thread's own replies, marked as such.
  const { live } = useWorkspace()
  const replies = useMemo(() => {
    if (!thread) return []
    const own = new Set(thread.replies.map((r) => r.id))
    const quoted = (live?.agentMessages ?? []).filter(
      (m): m is ThreadMessage => "id" in m && m.channel === channel && m.reply_to === root && m.thread_root == null && !own.has(m.id),
    )
    return [...thread.replies, ...quoted].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id - b.id)
  }, [thread, live?.agentMessages, channel, root])
  const error = loaded?.key === key ? loaded.error : null
  // The toggle answers at once; the list's refetch catches up behind it.
  const [followOverride, setFollowOverride] = useState<boolean | null>(null)
  const isFollowing = following == null ? null : (followOverride ?? following)
  const [followBusy, setFollowBusy] = useState(false)
  const lastReply = thread?.replies.reduce((max, r) => Math.max(max, r.id), 0) ?? 0

  // Reading a followed thread clears its "new replies". Only when already
  // following: the server's read mark also creates a follow, and opening a
  // thread must not quietly follow it.
  useEffect(() => {
    if (!isFollowing || lastReply <= 0) return
    void markThreadRead(channel, root, lastReply).then(() => onFollowChanged?.())
    // onFollowChanged is a stable reload callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, root, lastReply, isFollowing])

  const toggleFollow = async () => {
    if (isFollowing == null || followBusy) return
    const next = !isFollowing
    setFollowBusy(true)
    setFollowOverride(next)
    try {
      setFollowOverride(await setThreadFollowed(channel, root, next))
      onFollowChanged?.()
    } catch (err) {
      setFollowOverride(!next)
      toast.error(err instanceof Error ? err.message : "Couldn't change following.")
    } finally {
      setFollowBusy(false)
    }
  }

  useEffect(() => {
    const ctl = new AbortController()
    fetchThread(channel, root, ctl.signal)
      .then((t) => setLoaded({ key, thread: t, error: null }))
      .catch((e: unknown) => !ctl.signal.aborted && setLoaded({ key, thread: null, error: e instanceof Error ? e.message : "Couldn't load the thread." }))
    return () => ctl.abort()
  }, [channel, root, key])

  // Live replies and deletions from App's stream.
  useEffect(
    () =>
      subscribeThreadEvents((e) => {
        if (e.kind === "delete" && e.id === root) setRootDeleted(true)
        setLoaded((cur) => (cur && cur.key === key && cur.thread ? { ...cur, thread: mergeThread(cur.thread, e, root) } : cur))
      }),
    [key, root],
  )

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const saved = await sendTaskflowAgentMessage({ channel, body_markdown: body, thread_root: root, also_send: alsoSend, client_nonce: crypto.randomUUID() })
      setDraft("")
      setAlsoSend(false)
      // The stream will deliver it too; merging now keeps the reply on screen
      // even if the event is slow, and the merge is idempotent by id.
      setLoaded((cur) => (cur && cur.key === key && cur.thread ? { ...cur, thread: mergeThread(cur.thread, { kind: "upsert", message: saved }, root) } : cur))
    } catch (err) {
      toast.error("Couldn't send the reply", { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSending(false)
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background" aria-label="Thread">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Thread</h2>
        {thread ? (
          <span className="text-xs text-muted-foreground">
            {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
          </span>
        ) : null}
        {isFollowing != null ? (
          <Button
            variant={isFollowing ? "secondary" : "outline"}
            size="sm"
            className="ml-auto"
            aria-pressed={isFollowing}
            disabled={followBusy}
            onClick={() => void toggleFollow()}
            title={isFollowing ? "You get its new replies in Threads. Click to stop." : "Follow to see its new replies in Threads."}
          >
            {isFollowing ? <BellIcon /> : <BellOffIcon />}
            {isFollowing ? "Following" : "Follow"}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" className={isFollowing == null ? "ml-auto" : undefined} aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {rootDeleted ? (
          <p className="text-sm text-muted-foreground">This message was deleted. Its replies are back in the channel; reopen the conversation to see them.</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !thread ? (
          <div className="space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-12" />
          </div>
        ) : (
          <>
            <ul>
              <Row m={thread.root} me={currentUser?.id ?? null} now={now} />
            </ul>
            <div className="my-4 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {replies.length ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : "No replies yet"}
              <span className="h-px flex-1 bg-border" />
            </div>
            <ul className="space-y-4">
              {replies.map((m) => (
                <Row key={m.id} m={m} me={currentUser?.id ?? null} now={now} />
              ))}
            </ul>
          </>
        )}
      </div>
      <form ref={replyForm} onSubmit={(e) => void send(e)} className="space-y-2 border-t border-border p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder="Reply in thread"
          aria-label="Thread reply"
          disabled={!thread || rootDeleted}
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={alsoSend} onCheckedChange={(v) => setAlsoSend(v === true)} />
            Also send to the channel
          </label>
          <Button type="submit" size="sm" className="ml-auto" disabled={!draft.trim() || sending || !thread || rootDeleted}>
            {sending ? <Spinner /> : <SendIcon />}
            Send reply
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Reaches the people and agents in this thread. Mention someone to bring them in.</p>
      </form>
    </aside>
  )
}
