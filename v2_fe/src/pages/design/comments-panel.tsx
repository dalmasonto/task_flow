/// The design comments flow, as designed (design.html, design--comments,
/// design--pin; #5945):
///
/// - `CommentsPanel`: the right panel's Comments tab. Open / Sent / Done, each
///   card saying what it waits on: "Not sent yet → Send to <agent>", "<agent>
///   is working", "Addressed, waiting for you → Resolve".
/// - `CommentPopover`: the on-canvas box the Comment tool opens at the picked
///   element. What should change, scope (just here, or every page that uses
///   the component), who it goes to, and Send or Add to batch.
/// - `PinThread`: the dialog a pin or a card opens: the thread, the agent's
///   note, reply, Resolve or Reopen.
import { useEffect, useMemo, useState } from "react"
import { CheckCircle2Icon, CircleIcon, CrosshairIcon, FilterIcon, SendIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  addCommentReply,
  createDesignComment,
  dispatchDesignComments,
  fetchCommentThread,
  setCommentResolved,
  updateDesignComment,
  type DesignAgent,
  type DesignComment,
  type DesignCommentThread,
  type DesignManifest,
} from "@/lib/design-api"
import { cn } from "@/lib/utils"

import { bucketCounts, bucketOf, cardState, elementLabel, newestFirst, PIN_TONE_CLASS, pinTone, type CommentBucket } from "./comment-flow-logic"
import type { SelectionState } from "./design-selection"
import { useCommentAgent } from "./use-comment-agent"

export type AgentInfo = (id: number | null) => { name: string; online: boolean } | null

function PinBadge({ comment, label, className }: { comment: DesignComment; label: string; className?: string }) {
  return <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[11px] font-semibold", PIN_TONE_CLASS[pinTone(comment)], className)}>{label}</span>
}

function AgentSelect({ agents, value, onChange, className }: { agents: DesignAgent[]; value: number | null; onChange: (id: number) => void; className?: string }) {
  const items = Object.fromEntries(agents.map((a) => [String(a.id), a.display_name]))
  return (
    <Select items={items} value={value == null ? null : String(value)} onValueChange={(v) => v && onChange(Number(v))}>
      <SelectTrigger className={cn("h-8", className)} aria-label="Send to">
        <SelectValue placeholder={agents.length ? "Pick an agent" : "No agents linked"} />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>
            {a.display_name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------- the tab

export function CommentsPanel({
  projectId,
  comments,
  labels,
  agents,
  agentInfo,
  currentRoute,
  onFocus,
  onOpenThread,
  onChanged,
}: {
  projectId: number
  comments: DesignComment[]
  labels: Map<number, string>
  agents: DesignAgent[]
  agentInfo: AgentInfo
  /// The page in view, for "this page only".
  currentRoute: string | null
  onFocus: (c: DesignComment) => void
  onOpenThread: (c: DesignComment) => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<CommentBucket>("open")
  const [thisPage, setThisPage] = useState(false)
  const [agentId, setAgentId] = useCommentAgent(agents)
  const [busy, setBusy] = useState<number | null>(null)
  const scoped = thisPage && currentRoute ? comments.filter((c) => c.page_path === currentRoute) : comments
  const counts = bucketCounts(scoped)
  const inTab = newestFirst(scoped.filter((c) => bucketOf(c) === tab))
  // The Open tab also shows what's out with agents below it, as designed.
  const sentBelow = tab === "open" ? newestFirst(scoped.filter((c) => bucketOf(c) === "sent")) : []

  async function send(c: DesignComment) {
    if (agentId == null) return toast.error("Link an agent to this project first.")
    setBusy(c.id)
    try {
      const { sent_comment_ids } = await dispatchDesignComments(projectId, [c.id], agentId)
      if (!sent_comment_ids.length) toast.info("Someone else already handled that comment.")
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send it.")
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  async function act(c: DesignComment, run: () => Promise<unknown>) {
    setBusy(c.id)
    try {
      await run()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the comment.")
    } finally {
      setBusy(null)
    }
  }

  const card = (c: DesignComment) => {
    const st = cardState(c, agentInfo(c.sent_to_agent))
    return (
      <li key={c.id} className="rounded-xl border border-border bg-card p-3">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 text-left"
          title="Show its pin and open the thread"
          onClick={() => {
            onFocus(c)
            onOpenThread(c)
          }}
        >
          <PinBadge comment={c} label={labels.get(c.id) ?? "?"} />
          <span className="shrink-0 text-sm font-medium hover:underline">{c.page_path || "component"}</span>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{c.component_name ?? elementLabel(c.element_path)}</span>
          {c.orphaned ? <span className="ml-auto shrink-0 text-xs text-destructive">moved</span> : null}
        </button>
        <p className="mt-1.5 line-clamp-3 text-sm whitespace-pre-line">{c.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {st.kind === "unsent" ? (
            <>
              <span className="text-muted-foreground">Not sent yet</span>
              <span className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="xs" disabled={busy === c.id} onClick={() => void act(c, () => updateDesignComment(projectId, c.id, { status: "dismissed" }))}>
                  Dismiss
                </Button>
                <Button size="xs" disabled={busy === c.id || agentId == null} onClick={() => void send(c)}>
                  {busy === c.id ? <Spinner /> : <SendIcon />}
                  Send to {agents.find((a) => a.id === agentId)?.display_name ?? "agent"}
                </Button>
              </span>
            </>
          ) : st.kind === "working" ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-link">
                <span className="size-1.5 animate-pulse rounded-full bg-link" aria-hidden />
                {st.agent} is working
              </span>
              <button type="button" className="ml-auto text-link hover:underline" onClick={() => onOpenThread(c)}>
                Thread
              </button>
            </>
          ) : st.kind === "sent" ? (
            <>
              <span className="text-muted-foreground">Sent{st.agent ? ` to ${st.agent}` : ""}, waiting for it to pick up</span>
              <button type="button" className="ml-auto text-link hover:underline" onClick={() => onOpenThread(c)}>
                Thread
              </button>
            </>
          ) : st.kind === "addressed" ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-running">
                <CheckCircle2Icon className="size-3.5" aria-hidden />
                Addressed, waiting for you
              </span>
              <Button variant="outline" size="xs" className="ml-auto" disabled={busy === c.id} onClick={() => void act(c, () => setCommentResolved(projectId, c.id, true))}>
                Resolve
              </Button>
              {st.note ? <p className="w-full rounded-md bg-muted/60 p-2 text-muted-foreground">{st.note}</p> : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <CircleIcon className="size-3" aria-hidden />
              {st.kind === "resolved" ? "Resolved" : "Dismissed"}
            </span>
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-2" role="tablist" aria-label="Filter comments">
        {(["open", "sent", "done"] as const).map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={tab === b}
            onClick={() => setTab(b)}
            className={cn("h-7 rounded-full border px-3 text-xs", tab === b ? "border-foreground bg-foreground font-medium text-background" : "border-border text-muted-foreground hover:text-foreground")}
          >
            {b === "open" ? "Open" : b === "sent" ? "Sent" : "Done"} {counts[b]}
          </button>
        ))}
        <Button variant={thisPage ? "secondary" : "ghost"} size="icon-sm" className="ml-auto" aria-pressed={thisPage} aria-label={thisPage ? "Showing this page only" : "Showing every page"} title={thisPage ? "This page only" : "All pages"} onClick={() => setThisPage((v) => !v)}>
          <FilterIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {inTab.length ? <ul className="grid gap-2">{inTab.map(card)}</ul> : <p className="py-6 text-center text-sm text-muted-foreground">{tab === "open" ? "No open comments. Use the Comment tool (C) to add one." : tab === "sent" ? "Nothing is out with an agent." : "Nothing resolved or dismissed yet."}</p>}
        {sentBelow.length ? (
          <>
            <p className="pt-1 text-xs font-medium text-muted-foreground">Sent</p>
            <ul className="grid gap-2">{sentBelow.map(card)}</ul>
          </>
        ) : null}
        {comments.length ? (
          <>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Unsent comments go to</span>
              <AgentSelect agents={agents} value={agentId} onChange={setAgentId} className="w-auto flex-1" />
            </div>
            <p className="text-xs text-muted-foreground">Click a comment to open its thread. Dismissed comments are under Done.</p>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- popover

export function CommentPopover({
  projectId,
  selection,
  manifest,
  agents,
  left,
  top,
  onClose,
  onCreated,
  onQueue,
}: {
  projectId: number
  selection: SelectionState
  manifest: DesignManifest | null
  agents: DesignAgent[]
  /// Where to draw it, in px over the canvas (under the element). Kept inside
  /// the canvas by the caller's clamp.
  left: number
  top: number
  onClose: () => void
  onCreated: () => void
  onQueue: (id: number) => void
}) {
  const [body, setBody] = useState("")
  const [everywhere, setEverywhere] = useState(false)
  const [agentId, setAgentId] = useCommentAgent(agents)
  const [busy, setBusy] = useState<"send" | "queue" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const usage = useMemo(() => (selection.component ? (manifest?.components.find((c) => c.name === selection.component) ?? null) : null), [manifest, selection.component])
  const pages = usage?.usedOn.length ?? 0

  async function save(mode: "send" | "queue") {
    const text = body.trim()
    if (!text || busy) return
    if (mode === "send" && agentId == null) return setError("Link an agent to this project first, or add it to the batch.")
    setBusy(mode)
    setError(null)
    try {
      const c = await createDesignComment(projectId, {
        page_path: selection.route,
        component_name: selection.component,
        element_path: selection.elementPath,
        src_ref: selection.srcRef,
        viewport: selection.viewport,
        rect: selection.rect,
        snippet: selection.snippet,
        body: text,
        scope: everywhere && usage ? "component" : "instance",
      })
      if (mode === "send") await dispatchDesignComments(projectId, [c.id], agentId!)
      else onQueue(c.id)
      toast.success(mode === "send" ? `Sent to ${agents.find((a) => a.id === agentId)?.display_name ?? "the agent"}` : "Added to the batch")
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the comment.")
      onCreated()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      role="dialog"
      aria-label={`Comment on ${selection.tag}`}
      // React Flow: don't pan, zoom or drag from inside the box.
      className="nodrag nopan nowheel absolute z-30 w-80 rounded-2xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-2xl"
      style={{ left: `clamp(8px, ${left}px, calc(100% - 20rem - 8px))`, top: `clamp(8px, ${top}px, calc(100% - 22rem))` }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save("send")
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <CrosshairIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{selection.component ?? elementLabel(selection.elementPath)}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <Textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What should change?" aria-label="What should change?" className="resize-none" />
      <div className="mt-3 inline-flex rounded-md border border-border p-0.5 text-xs" role="radiogroup" aria-label="Scope">
        <button type="button" role="radio" aria-checked={!everywhere} onClick={() => setEverywhere(false)} className={cn("rounded px-2 py-1", !everywhere ? "bg-accent font-medium" : "text-muted-foreground")}>
          Just here
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={everywhere}
          disabled={!usage}
          title={usage ? `Change ${usage.name} everywhere it's used` : "Not inside a component"}
          onClick={() => setEverywhere(true)}
          className={cn("rounded px-2 py-1 disabled:opacity-50", everywhere ? "bg-accent font-medium" : "text-muted-foreground")}
        >
          {usage ? `All ${pages} ${pages === 1 ? "page" : "pages"}` : "Every page"}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">To</span>
        <AgentSelect agents={agents} value={agentId} onChange={setAgentId} className="flex-1" />
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" disabled={!body.trim() || !!busy} onClick={() => void save("queue")}>
          {busy === "queue" ? <Spinner /> : null}
          Add to batch
        </Button>
        <Button size="sm" disabled={!body.trim() || !!busy} onClick={() => void save("send")}>
          {busy === "send" ? <Spinner /> : <SendIcon />}
          Send
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Ctrl Enter sends. Esc closes.</p>
    </div>
  )
}

// ---------------------------------------------------------------- pin thread

export function PinThread({
  projectId,
  comment,
  label,
  agentInfo,
  onClose,
  onShowPin,
  onChanged,
}: {
  projectId: number
  comment: DesignComment
  label: string
  agentInfo: AgentInfo
  onClose: () => void
  onShowPin: () => void
  onChanged: () => void
}) {
  const [thread, setThread] = useState<DesignCommentThread | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const ctl = new AbortController()
    fetchCommentThread(projectId, comment.id, ctl.signal)
      .then((t) => setThread(t))
      .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : "Couldn't load the thread."))
    return () => ctl.abort()
  }, [projectId, comment.id, comment.status, tick])

  const st = cardState(comment, agentInfo(comment.sent_to_agent))
  const bucket = bucketOf(comment)

  async function send() {
    const text = reply.trim()
    if (!text) return
    setBusy(true)
    try {
      await addCommentReply(projectId, comment.id, text)
      setReply("")
      setTick((t) => t + 1)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the reply.")
    } finally {
      setBusy(false)
    }
  }

  async function resolve(next: boolean) {
    setBusy(true)
    try {
      await setCommentResolved(projectId, comment.id, next)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the comment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] w-[min(44rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 v3:p-0" showCloseButton={false}>
        <div className="flex items-start gap-3 border-b border-border p-4">
          <PinBadge comment={comment} label={label} className="mt-0.5 size-6 text-xs" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="line-clamp-2 text-base">{comment.body}</DialogTitle>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span>{comment.page_path || "component"}</span>
              <span className="font-mono">{comment.component_name ?? elementLabel(comment.element_path)}</span>
              {comment.src_ref ? <span className="font-mono">{comment.src_ref}</span> : null}
              <span>{comment.viewport}</span>
            </p>
          </div>
          <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium", bucket === "open" ? "bg-primary/10 text-primary" : st.kind === "addressed" ? "bg-running/10 text-running" : bucket === "sent" ? "bg-link/10 text-link" : "bg-muted text-muted-foreground")}>
            {st.kind === "unsent" ? "Open" : st.kind === "working" || st.kind === "sent" ? "Sent" : st.kind === "addressed" ? "Addressed" : st.kind === "resolved" ? "Resolved" : "Dismissed"}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="grid min-h-0 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="max-h-[50svh] min-h-0 space-y-3 overflow-y-auto p-4">
            <div className="text-sm">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{comment.author}</span>
                {thread?.sent_to ? `, sent to ${thread.sent_to.label}` : ""}
              </p>
              <p className="mt-0.5 whitespace-pre-line">{comment.body}</p>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {!thread && !error ? <Spinner /> : null}
            {thread?.replies.map((r) => (
              <div key={r.id} className="text-sm">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.author_label}</span>
                  {r.created_at ? ` · ${new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
                  {r.page_version != null ? ` · v${r.page_version}` : ""}
                </p>
                <p className="mt-0.5 whitespace-pre-line">{r.body}</p>
              </div>
            ))}
            {comment.resolution_note ? (
              <div className="rounded-lg bg-muted/60 p-2.5 text-sm">
                <p className="text-xs font-medium text-muted-foreground">The agent&apos;s note</p>
                <p className="mt-0.5 whitespace-pre-line">{comment.resolution_note}</p>
              </div>
            ) : null}
            {st.kind === "working" ? <p className="text-xs text-link">{st.agent} is working on it</p> : null}
          </div>
          <div className="space-y-3 border-t border-border p-4 text-sm sm:border-t-0 sm:border-l">
            <dl className="grid gap-1.5 text-xs">
              <dt className="text-muted-foreground">Assigned</dt>
              <dd>{thread?.sent_to?.label ?? "Not sent yet"}</dd>
              <dt className="text-muted-foreground">Scope</dt>
              <dd>{comment.scope === "component" ? `Every page using ${comment.component_name ?? "it"}` : "Just this page"}</dd>
            </dl>
            <Button variant="outline" size="sm" className="w-full" onClick={onShowPin}>
              Show pin on canvas
            </Button>
          </div>
        </div>
        <div className="space-y-2 border-t border-border p-4">
          <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Reply in this thread" aria-label="Reply in this thread" className="resize-none" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()} />
          <div className="flex flex-wrap items-center gap-2">
            {bucket === "done" || st.kind === "addressed" ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolve(false)}>
                Reopen
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">{thread?.sent_to ? `${thread.sent_to.label} gets your reply in its terminal.` : "Replies stay with the comment."}</span>
            <span className="ml-auto flex gap-2">
              {st.kind === "addressed" ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void resolve(true)}>
                  <CheckCircle2Icon />
                  Resolve
                </Button>
              ) : null}
              <Button size="sm" disabled={busy || !reply.trim()} onClick={() => void send()}>
                {busy ? <Spinner /> : <SendIcon />}
                Reply
              </Button>
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
