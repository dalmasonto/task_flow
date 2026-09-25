/// Selection + commenting (§9.5): the breadcrumb inspector, the scope
/// question answered BEFORE dispatch, and the numbered pins anchored to their
/// captured rects.
///
/// Every inbound value here came through postMessage from the sandbox — i.e.
/// hostile input. Render as text only; never inject received HTML into the
/// chrome.

import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { type Artboard } from "@/lib/design-devices"
import {
  type DesignComment,
  type DesignManifest,
  type DesignAgent,
  createDesignComment,
  updateDesignComment,
  fetchDesignComments,
  fetchDesignAgents,
  dispatchDesignComments,
  type CommentScope,
} from "@/lib/design-api"
import { type SelectionState, pinNumber } from "./design-selection"
import { boardsForComment, commentResolutionNote, commentRoute } from "./design-comments"

// ---------------------------------------------------------------------------
// Inspector (right panel)
// ---------------------------------------------------------------------------

export function DesignInspector({
  selection,
  manifest,
  projectId,
  onDeselect,
  onCommentCreated,
  onWiden,
  onFocusComment,
}: {
  selection: SelectionState | null
  manifest: DesignManifest | null
  projectId: number
  onDeselect: () => void
  onCommentCreated: (comment: DesignComment) => void
  /** Re-anchor the selection to the crumb at this index (see `widenSelection`). */
  onWiden?: (index: number) => void
  /** Take the canvas to where a comment was captured. */
  onFocusComment?: (comment: DesignComment) => void
}) {
  if (!selection) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <PanelTitle>Inspector</PanelTitle>
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          Hit <code>C</code> and click any element to select it. <code>Esc</code> deselects.
        </p>
        <CommentsListSection projectId={projectId} onFocus={onFocusComment} />
      </div>
    )
  }

  // Keyed by the selection: a new selection remounts the form with fresh
  // scope/body state — no setState-in-effect reset dance.
  const formKey = `${selection.route}|${selection.elementPath}|${selection.component ?? ""}`
  const crumbs = selection.ancestors.length ? selection.ancestors : [selection.tag]
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PanelTitle onClose={onDeselect}>Inspector</PanelTitle>

      {/* Breadcrumb — every crumb widens the selection upward. The LAST crumb is
          the selection itself, so it is current state, not a control; the ones
          before it widen to that ancestor. A crumb is only offered as a button
          when the frame sent its path (`ancestorPaths`) — a label alone cannot
          be turned back into an element, so a button there would be the dead
          control this breadcrumb used to be. */}
      <nav className="flex flex-wrap items-center gap-x-1 px-3 py-2 font-mono text-[11px]">
        {crumbs.map((crumb, i) => {
          const current = i === crumbs.length - 1
          const canWiden = !current && !!onWiden && !!selection.ancestorPaths[i]
          const crumbClass = cn(
            "rounded px-1",
            current ? "bg-accent/10 font-semibold text-accent" : "text-muted-foreground",
            canWiden && "hover:bg-muted",
          )
          return (
            <span key={`${crumb}-${i}`} className="flex items-center gap-1">
              {canWiden ? (
                <button
                  type="button"
                  className={crumbClass}
                  title={`Widen selection to ${crumb}`}
                  onClick={() => onWiden(i)}
                >
                  {crumb}
                </button>
              ) : (
                <span className={crumbClass} title={current ? "Selected element" : undefined}>
                  {crumb}
                </span>
              )}
              {!current && <span className="text-muted-foreground">›</span>}
            </span>
          )
        })}
      </nav>

      <CommentForm
        key={formKey}
        selection={selection}
        manifest={manifest}
        projectId={projectId}
        onCreated={onCommentCreated}
      />

      {selection.snippet ? (
        <details className="mx-3 mt-3 rounded-lg border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">
            Captured HTML
          </summary>
          <pre className="overflow-x-auto px-2 pb-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {selection.snippet}
          </pre>
        </details>
      ) : null}

      <CommentsListSection projectId={projectId} onFocus={onFocusComment} />
    </div>
  )
}

/// The scope question (§9.5.4) + comment composer. The default is `instance`
/// — the reversible choice; blast radius is visible before the action.
function CommentForm({
  selection,
  manifest,
  projectId,
  onCreated,
}: {
  selection: SelectionState
  manifest: DesignManifest | null
  projectId: number
  onCreated: (comment: DesignComment) => void
}) {
  const [scope, setScope] = useState<CommentScope>("instance")
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const groupName = `scope-${selection.route}-${selection.elementPath}`

  // The blast radius, visible BEFORE the action.
  const usage = useMemo(
    () =>
      selection.component
        ? manifest?.components.find((c) => c.name === selection.component) ?? null
        : null,
    [manifest, selection],
  )
  const usedOnCount = scope === "component" ? (usage?.usedOn.length ?? 0) : 1

  const submit = async () => {
    const trimmed = body.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const comment = await createDesignComment(projectId, {
        page_path: selection.route,
        component_name: selection.component,
        element_path: selection.elementPath,
        src_ref: selection.srcRef,
        viewport: selection.viewport,
        rect: selection.rect,
        snippet: selection.snippet,
        body: trimmed,
        scope,
      })
      onCreated(comment)
      setBody("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the comment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="mx-3 rounded-lg border bg-card p-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-mono text-[11px] text-foreground">{selection.tag}</span>
          {selection.component ? (
            <>
              {" · inside "}
              <span className="font-mono text-[11px] text-foreground">{selection.component}</span>
            </>
          ) : null}
        </p>
        {usage && usage.usedOn.length > 1 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">Used on {usage.usedOn.length} pages</p>
        ) : null}
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs">
          <input
            type="radio"
            name={groupName}
            checked={scope === "component"}
            onChange={() => setScope("component")}
            disabled={!usage}
          />
          <span>
            Change everywhere
            <span className="ml-1 text-muted-foreground">
              ({usage ? `${usage.usedOn.length} pages · edits ${usage.name}` : "no component"})
            </span>
          </span>
        </label>
        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs">
          <input
            type="radio"
            name={groupName}
            checked={scope === "instance"}
            onChange={() => setScope("instance")}
          />
          <span>
            Change on this page only
            <span className="ml-1 text-muted-foreground">(expressed as attributes)</span>
          </span>
        </label>
      </div>

      <div className="mx-3 mt-3 flex flex-col gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={
            scope === "component"
              ? `What should change about ${selection.component} everywhere?`
              : "What should change here?"
          }
          rows={4}
          className="w-full resize-none rounded-lg border bg-transparent p-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            Affects {usedOnCount} page{usedOnCount === 1 ? "" : "s"}
          </span>
          <Button size="sm" disabled={!body.trim() || submitting} onClick={() => void submit()}>
            Comment
            <span className="ml-1 hidden rounded border px-1 font-mono text-[10px] opacity-70 sm:inline">
              ⌘⏎
            </span>
          </Button>
        </div>
      </div>
    </>
  )
}

export function PanelTitle({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
      {onClose ? (
        <button onClick={onClose} className="rounded p-0.5 hover:bg-muted" title="Deselect (Esc)">
          ✕
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Comments list (right panel bottom / grouped by route)
// ---------------------------------------------------------------------------

export function CommentsListSection({
  projectId,
  comments: controlledComments,
  onChanged,
  onFocus,
}: {
  projectId: number
  /** Controlled list from the page (live via SSE); fetched when omitted. */
  comments?: DesignComment[]
  onChanged?: () => void
  onFocus?: (comment: DesignComment) => void
}) {
  const [localComments, setLocalComments] = useState<DesignComment[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [agents, setAgents] = useState<DesignAgent[]>([])
  const [agentId, setAgentId] = useState<number | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId || controlledComments) return
    let cancelled = false
    fetchDesignComments(projectId)
      .then((rows) => !cancelled && setLocalComments(rows))
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [projectId, controlledComments])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetchDesignAgents(projectId)
      .then((rows) => {
        if (cancelled) return
        setAgents(rows)
        setAgentId((cur) => cur ?? rows[0]?.id ?? null)
      })
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [projectId])

  const list = controlledComments ?? localComments
  if (!list?.length) return null

  const openOnes = list.filter((c) => c.status === "open")
  const toggle = (id: number) =>
    setSelectedIds((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]))

  const sendToAgent = async () => {
    if (!selectedIds.length || !agentId || dispatching) return
    setDispatching(true)
    setNotice(null)
    try {
      await dispatchDesignComments(projectId, selectedIds, agentId)
      setSelectedIds([])
      setNotice(`Sent ${selectedIds.length} comment(s) to the agent.`)
      onChanged?.()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dispatch failed.")
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div className="mt-4 border-t">
      <PanelTitle>Comments ({list.length})</PanelTitle>
      <div className="space-y-2 p-3">
        {list.map((c) => {
          const note = commentResolutionNote(c)
          return (
            <div key={c.id} className="rounded-lg border p-2 text-xs">
              <div className="flex items-center gap-1.5">
                {c.status === "open" ? (
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    title="Select for dispatch"
                  />
                ) : null}
                <span
                  className={cn(
                    "inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    c.status === "open" && "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
                    c.status === "sent" && "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
                    c.status === "addressed" &&
                      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
                    c.status === "dismissed" && "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
                  )}
                >
                  {c.status}
                </span>
                {/* The label is a control only when a caller wired one: an
                    unhandled button is indistinguishable from a broken one. */}
                {onFocus ? (
                  <button
                    type="button"
                    className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    title={`Show ${commentRoute(c)} on the canvas`}
                    onClick={() => onFocus(c)}
                  >
                    {commentRoute(c)}
                  </button>
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground">{commentRoute(c)}</span>
                )}
                {c.orphaned ? <span className="ml-auto text-[10px] text-destructive">orphaned</span> : null}
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-line">{c.body}</p>
              {note ? (
                <p className="mt-1 rounded bg-muted/60 p-1.5 text-[11px] italic">{note}</p>
              ) : null}
              {c.status === "open" ? (
                <div className="mt-1.5 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={async () => {
                      await updateDesignComment(projectId, c.id, { status: "dismissed" }).catch(() => null)
                      onChanged?.()
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}

        {/* Dispatch bar — visible whenever there is something open to send. */}
        {openOnes.length > 0 ? (
          <div className="flex items-center gap-1.5 rounded-lg border bg-card p-2">
            <select
              className="h-7 flex-1 rounded border bg-transparent px-1 text-xs"
              value={agentId ?? ""}
              onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
            >
              {agents.length === 0 ? <option value="">No agents linked</option> : null}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!selectedIds.length || !agentId || dispatching}
              onClick={() => void sendToAgent()}
              title="Send selected comments into the agent's tmux session"
            >
              Send to agent ({selectedIds.length})
            </Button>
          </div>
        ) : null}
        {notice ? <p className="text-[11px] text-muted-foreground">{notice}</p> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pins — rendered INSIDE the scaled world container by the canvas.
// ---------------------------------------------------------------------------

export function CommentPins({
  comments,
  boards,
  selectedPinId,
  onSelectPin,
}: {
  comments: DesignComment[]
  /** Every known artboard, so a comment shows on each device view of its route. */
  boards: Artboard[]
  selectedPinId: number | null
  onSelectPin: (comment: DesignComment) => void
}) {
  const parsed = useMemo(
    () =>
      comments.map((c) => {
        let rect = { x: 24, y: 24, w: 48, h: 48 }
        try {
          const r = JSON.parse(c.rect) as { x?: number; y?: number; w?: number; h?: number }
          rect = { x: r.x ?? 24, y: r.y ?? 24, w: r.w ?? 48, h: r.h ?? 48 }
        } catch {
          /* keep fallback */
        }
        return { comment: c, rect }
      }),
    [comments],
  )

  return (
    <>
      {parsed.map(({ comment, rect }) =>
        boardsForComment(boards, comment).map((board) => (
          <button
            key={`${comment.id}@${board.key}`}
            onClick={(e) => {
              e.stopPropagation()
              onSelectPin(comment)
            }}
            title={comment.body}
            className={cn(
              "absolute z-20 flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[11px] font-bold text-white shadow-md transition-all duration-[120ms] ease-out hover:scale-110",
              comment.status === "addressed"
                ? "bg-emerald-600"
                : comment.status === "sent"
                  ? "bg-blue-600"
                  : comment.orphaned
                    ? "bg-zinc-500"
                    : "bg-accent",
              selectedPinId === comment.id && "ring-2 ring-white ring-offset-2 ring-offset-accent",
            )}
            style={{
              left: board.x + rect.x + rect.w,
              top: board.y + rect.y,
            }}
          >
            {pinNumber(comment.id)}
          </button>
        )),
      )}
    </>
  )
}
