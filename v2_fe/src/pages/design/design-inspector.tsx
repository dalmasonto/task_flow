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
import { commentsForSelection, selectionName } from "./selection-list"
import { boardsForComment, commentResolutionNote, commentRoute } from "./design-comments"

// ---------------------------------------------------------------------------
// Inspector (right panel)
// ---------------------------------------------------------------------------

export function DesignInspector({
  selections,
  activeIndex,
  manifest,
  projectId,
  labelFor,
  comments,
  onActivate,
  onRemove,
  onClear,
  onCommentsChanged,
  onWiden,
  onFocusComment,
}: {
  /** Every selection made on the canvas, in the order they were picked. */
  selections: SelectionState[]
  /** Which of them the form below edits — an index into `selections`. */
  activeIndex: number
  manifest: DesignManifest | null
  projectId: number
  /** A page's display name, resolved by the CALLER through `pageLabel` (the
   *  same resolver the canvas and the comment rows use, so a renamed page
   *  cannot read one way here and another way everywhere else). */
  labelFor: (route: string) => string
  /** Every comment on the project — the per-row "already commented" badge AND
   *  the Comments list at the bottom of this panel, which is the same list on
   *  purpose (see `onCommentsChanged`). The caller owns it: it fetches it, and
   *  it refreshes it on create and on the design-comments SSE event. */
  comments: DesignComment[]
  onActivate: (index: number) => void
  onRemove: (index: number) => void
  /** Drop every selection (the panel's ✕). */
  onClear: () => void
  /** The project's comments changed — one was created, dismissed or dispatched.
   *  The caller refetches the live list it hands back in as `comments`. ONE
   *  callback rather than a separate one per cause, because the badge above and
   *  the list below answer ONE question ("which of these have I already
   *  commented on?") and two ways to answer it is how a badge ends up counting a
   *  comment the list has not drawn yet — read as "not mapped yet" when it means
   *  "not loaded yet", so the human comments twice. */
  onCommentsChanged: () => void
  /** Re-anchor the ACTIVE selection to the crumb at this index (see
   *  `widenSelection`). */
  onWiden?: (index: number) => void
  /** Take the canvas to where a comment was captured. */
  onFocusComment?: (comment: DesignComment) => void
}) {
  // `-1` is the empty list's active index, so this read is the one place that
  // convention is resolved: no index, no active row, no form.
  const active = selections[activeIndex] ?? null
  if (!active) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <PanelTitle>Inspector</PanelTitle>
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          Hit <code>C</code> and click any element to select it — pick as many as
          you like, on as many pages. Each one gets its own comment.
        </p>
        <CommentsListSection
          projectId={projectId}
          comments={comments}
          onChanged={onCommentsChanged}
          onFocus={onFocusComment}
        />
      </div>
    )
  }

  // Keyed by the selection: a new selection remounts the form with fresh
  // scope/body state — no setState-in-effect reset dance. Which selection that
  // is follows the ACTIVE row, so switching rows in the list above re-targets
  // the form the same way picking a new element does.
  const formKey = `${active.route}|${active.elementPath}|${active.component ?? ""}`
  const crumbs = active.ancestors.length ? active.ancestors : [active.tag]
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PanelTitle onClose={onClear}>Inspector</PanelTitle>

      {/* The selections, one row each. Rendered for a single selection too: the
          row is the only place the PANEL says which page the selection is on
          (the breadcrumb below is element ancestry, which is a different
          question), and the list is how the human learns they can pick more. */}
      <SelectionRows
        selections={selections}
        activeIndex={activeIndex}
        labelFor={labelFor}
        comments={comments}
        onActivate={onActivate}
        onRemove={onRemove}
      />

      {/* Breadcrumb — every crumb widens the ACTIVE selection upward. The LAST
          crumb is the selection itself, so it is current state, not a control;
          the ones before it widen to that ancestor. A crumb is only offered as
          a button when the frame sent its path (`ancestorPaths`) — a label
          alone cannot be turned back into an element, so a button there would
          be the dead control this breadcrumb used to be. */}
      <nav className="flex flex-wrap items-center gap-x-1 px-3 py-2 text-[11px]">
        {crumbs.map((crumb, i) => {
          const current = i === crumbs.length - 1
          const canWiden = !current && !!onWiden && !!active.ancestorPaths[i]
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
        selection={active}
        manifest={manifest}
        projectId={projectId}
        // The comment itself is the caller's to insert if it wants it; today it
        // refetches, which is also what the list below needs on a dismiss or a
        // dispatch — one refresh, one list.
        onCreated={() => onCommentsChanged()}
      />

      {active.snippet ? (
        <details className="mx-3 mt-3 rounded-lg border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">
            Captured HTML
          </summary>
          <pre className="overflow-x-auto px-2 pb-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {active.snippet}
          </pre>
        </details>
      ) : null}

      <CommentsListSection
        projectId={projectId}
        comments={comments}
        onChanged={onCommentsChanged}
        onFocus={onFocusComment}
      />
    </div>
  )
}

/// One row per selection: which page it is on, what was selected, whether it
/// has a comment yet, and how to make it active or drop it.
///
/// The route is on EVERY row because a selection can be captured on any page
/// open on the canvas, and a list of component names with no page beside them
/// cannot be mapped — `nav` names a dozen different components without it,
/// which is the whole reason several selections across pages were asked for.
/// The label is resolved through `labelFor` (the caller's `pageLabel`) and the
/// raw path rides beside it: the label is what the human recognises, the path
/// is what the agent is sent and what the canvas row headers show.
///
/// The badge is a count, not a second list: the point is to see at a glance
/// which rows are already covered. `comments` is the project's live list (the
/// page fetches it and refreshes it on create/SSE), and the match is by route
/// AND element path — see `commentsForSelection`, which is also where the
/// comment row's own field spellings are read.
function SelectionRows({
  selections,
  activeIndex,
  labelFor,
  comments,
  onActivate,
  onRemove,
}: {
  selections: SelectionState[]
  activeIndex: number
  labelFor: (route: string) => string
  comments: DesignComment[]
  onActivate: (index: number) => void
  onRemove: (index: number) => void
}) {
  // Index-aligned with `selections`, and recomputed when either input changes
  // rather than on every render: panning the canvas re-renders this page on
  // each pointermove, and the join is a scan of every comment per row. (Same
  // reason `CommentPins` memoizes its parse.)
  const counts = useMemo(
    () => selections.map((selection) => commentsForSelection(comments, selection).length),
    [comments, selections],
  )

  return (
    <div className="mx-3 mt-2 space-y-0.5 rounded-lg border bg-card p-1">
      {selections.map((selection, i) => {
        const isActive = i === activeIndex
        const count = counts[i] ?? 0
        return (
          <div
            // The row's identity, not its position: `selection-list` keeps one
            // row per (route, elementPath), so this is unique — and removing a
            // row from the middle must not re-key the rows below it.
            key={`${selection.route}|${selection.elementPath}`}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1",
              isActive ? "bg-accent/10" : "hover:bg-muted",
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(i)}
              aria-current={isActive ? "true" : undefined}
              title={isActive ? "The selection being commented on" : "Comment on this selection"}
              className="min-w-0 flex-1 text-left"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "truncate text-xs",
                    isActive ? "font-medium text-accent" : "text-foreground/80",
                  )}
                >
                  {selectionName(selection)}
                </span>
                {count > 0 ? (
                  // Neutral on purpose. The panel's coloured pills are comment
                  // STATUSES (amber open, blue sent, emerald addressed) a few
                  // inches below this row, and this count is of comments in any
                  // status at all — borrowing one of those colours would say
                  // something the badge does not mean. The number is the
                  // signal; the title spells it out.
                  <span
                    className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium text-foreground/70"
                    title={`${count} comment${count === 1 ? "" : "s"} on this selection`}
                  >
                    {count}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 flex items-baseline gap-1 text-[10px] text-muted-foreground">
                <span className="truncate">{labelFor(selection.route)}</span>
                <span className="truncate font-mono opacity-70">{selection.route}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Remove this selection"
            >
              ✕
            </button>
          </div>
        )
      })}
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
          <span className="text-[11px] text-foreground">{selection.tag}</span>
          {selection.component ? (
            <>
              {" · inside "}
              <span className="text-[11px] text-foreground">{selection.component}</span>
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
        // The Inspector's ✕, which now clears the WHOLE selection list (each
        // row has its own ✕ for one) — and not Esc, which only leaves picking
        // mode. The old title promised a shortcut that never existed.
        <button onClick={onClose} className="rounded p-0.5 hover:bg-muted" title="Clear all selections">
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
