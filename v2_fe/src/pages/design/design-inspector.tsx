/// Selection + commenting (§9.5): the breadcrumb inspector, the scope
/// question answered BEFORE dispatch, and the numbered pins anchored to their
/// captured rects.
///
/// Every inbound value here came through postMessage from the sandbox — i.e.
/// hostile input. Render as text only; never inject received HTML into the
/// chrome.

import { useEffect, useMemo, useState } from "react"
import { MessageSquarePlusIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { boardContentOrigin, deviceById, type Artboard } from "@/lib/design-devices"
import {
  type DesignComment,
  type DesignManifest,
  type DesignAgent,
  updateDesignComment,
  fetchDesignComments,
  fetchDesignAgents,
  dispatchDesignComments,
} from "@/lib/design-api"
import { type SelectionState, pinNumber } from "./design-selection"
import { commentsForSelection, selectionName } from "./selection-list"
import { boardsForComment, commentResolutionNote, commentRoute } from "./design-comments"
import { commentsOn, elementLabel, PIN_TONE_CLASS, pinLabels, pinTone } from "./comment-flow-logic"
import { colourUses, rootClasses, typeAndSpacing } from "./inspect-logic"

// ---------------------------------------------------------------------------
// Inspector (right panel)
// ---------------------------------------------------------------------------

export function DesignInspector({
  selections,
  activeIndex,
  manifest,
  labelFor,
  comments,
  onActivate,
  onRemove,
  onClear,
  onWiden,
  labels,
  onComment,
  onAsk,
  onOpenThread,
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
   *  `widenSelection`). REQUIRED, and so is `onFocusComment` below: both were
   *  optional, and an optional handler is exactly how a caller ends up with a
   *  control that looks live and does nothing — the defect this breadcrumb was
   *  fixed for once already, when every crumb was a button whether or not
   *  anything was listening. There is one call site and it passes both, so the
   *  compiler can hold a line no runtime check can: the panel cannot tell a
   *  forgotten handler from a deliberate no-op. */
  onWiden: (index: number) => void
  /** Take the canvas to where a comment was captured. Required for the reason
   *  above; the section below still draws a plain label if a caller ever hands
   *  it none, but this panel always has one. */
  onFocusComment: (comment: DesignComment) => void
  /** #5945: pin numbers, the Comment button (opens the box on the canvas),
   *  "Ask about this element" (the design chat, with the element attached),
   *  and a comment's pin thread. */
  labels: Map<number, string>
  onComment: () => void
  onAsk: () => void
  onOpenThread: (comment: DesignComment) => void
}) {
  // `-1` is the empty list's active index, so this read is the one place that
  // convention is resolved: no index, no active row, no form.
  const active = selections[activeIndex] ?? null
  if (!active) {
    return (
      <div className="flex h-full flex-col overflow-y-auto px-4 py-10 text-center">
        <p className="text-sm font-medium">Nothing selected</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Select, then click any element on the canvas to inspect it, or use the Comment tool (<kbd className="rounded border px-1 font-mono text-xs">C</kbd>) to leave a note on it.
        </p>
      </div>
    )
  }

  const crumbs = active.ancestors.length ? active.ancestors : [active.tag]
  const usage = active.component ? (manifest?.components.find((c) => c.name === active.component) ?? null) : null
  const shownOn = usage ? usage.usedOn.map((r) => labelFor(r)) : [labelFor(active.route)]
  const classes = rootClasses(active.snippet)
  const colours = colourUses(classes)
  const typeClasses = typeAndSpacing(classes)
  const here = commentsOn(comments, active.route, active.elementPath)
  const name = active.component ?? elementLabel(active.elementPath)
  const parentCrumb = crumbs.length - 2

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-active-route={active.route} data-active-element={active.elementPath}>
      {/* Every pick, one row each (also for one: it's where the panel says
          which page the selection is on, and how people learn they can pick
          more). */}
      <SelectionRows selections={selections} activeIndex={activeIndex} labelFor={labelFor} comments={comments} onActivate={onActivate} onRemove={onRemove} />

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-semibold">{name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {active.text ? <>&ldquo;{active.text.slice(0, 60)}&rdquo; on </> : null}
            {labelFor(active.route)}, {active.viewport}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={onComment}>
          <MessageSquarePlusIcon />
          Comment
        </Button>
        <button type="button" onClick={onClear} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Clear the selection" aria-label="Clear the selection">
          <XIcon className="size-3.5" />
        </button>
      </div>

      {/* Breadcrumb: every crumb widens the selection to that ancestor; the
          last one is the selection itself. */}
      <nav aria-label="Element path" className="flex flex-wrap items-center gap-x-1 font-mono text-xs">
        {crumbs.map((crumb, i) => {
          const current = i === crumbs.length - 1
          const canWiden = !current && !!crumb && !!active.ancestorPaths[i]
          return (
            <span key={`${crumb}-${i}`} className="flex items-center gap-1">
              {canWiden ? (
                <button type="button" className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={`Widen selection to ${crumb}`} onClick={() => onWiden(i)}>
                  {crumb}
                </button>
              ) : (
                <span className={cn("rounded px-1", current ? "bg-muted font-semibold text-foreground" : "text-muted-foreground")} title={current ? "Selected element" : undefined}>
                  {crumb}
                </span>
              )}
              {!current && <span className="text-muted-foreground">›</span>}
            </span>
          )
        })}
      </nav>

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-border bg-card p-3 text-sm">
        <dt className="text-muted-foreground">Source</dt>
        <dd className="truncate font-mono text-xs leading-5 text-link">{active.srcRef ?? "generated by a component"}</dd>
        <dt className="text-muted-foreground">Component</dt>
        <dd className="truncate">{active.component ?? "none, page markup"}</dd>
        <dt className="text-muted-foreground">Shows on</dt>
        <dd className="line-clamp-2">{shownOn.join(", ")}</dd>
      </dl>

      {colours.length ? (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Colours</h3>
          <ul className="grid gap-1">
            {colours.map((c) => (
              <li key={`${c.role}-${c.token}`} className="flex items-center gap-2 text-sm">
                <span className="size-3.5 shrink-0 rounded border border-border" style={{ background: `var(--${c.token})` }} aria-hidden />
                <span>{c.role}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{c.token}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {typeClasses.length ? (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Type and spacing</h3>
          <div className="flex flex-wrap gap-1">
            {typeClasses.map((c) => (
              <span key={c} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                {c}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Comments here</h3>
        {here.length ? (
          <ul className="grid gap-1.5">
            {here.map((c) => (
              <li key={c.id} data-comment-here={c.id}>
                <button type="button" onClick={() => onOpenThread(c)} className="flex w-full items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-sm hover:bg-muted/50">
                  <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[11px] font-semibold", PIN_TONE_CLASS[pinTone(c)])}>{labels.get(c.id) ?? "?"}</span>
                  <span className="min-w-0 flex-1 truncate">{c.body}</span>
                  <span className="shrink-0 text-xs text-muted-foreground capitalize">{c.status}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" disabled={parentCrumb < 0 || !active.ancestorPaths[parentCrumb]} onClick={() => onWiden(parentCrumb)}>
          Select parent
        </Button>
        <Button variant="outline" size="sm" onClick={onAsk}>
          Ask about this element
        </Button>
      </div>

      {active.snippet ? (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">Captured HTML</summary>
          <pre className="overflow-x-auto px-2 pb-2 font-mono text-[10px] leading-relaxed text-muted-foreground">{active.snippet}</pre>
        </details>
      ) : null}
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
  /** Controlled list from the page (live via SSE); fetched when omitted — and
   *  the "when omitted" half has NO CALLER today: both call sites in this file
   *  pass `comments`, and so does the only thing that renders `DesignInspector`
   *  (`DesignSurfacePage`), where the prop is required. The self-fetch below is
   *  a fallback that nothing takes, kept rather than deleted because a
   *  controllable list is the component's contract; it is described here so it
   *  is not read as a live second source of comments, which would be the wrong
   *  thing to reason from. */
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

  // The uncontrolled fallback — unreachable as the panel is wired (see the
  // `comments` prop's note): every caller passes the list. Kept because the
  // contract is "controlled or it fetches its own", and the effect is guarded
  // rather than removed so a future caller that omits `comments` still works.
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
      const { sent_comment_ids } = await dispatchDesignComments(projectId, selectedIds, agentId)
      // #1131: only the comments still open when dispatch claimed them are
      // sent; the rest were handled by someone else in the meantime.
      const skipped = selectedIds.length - sent_comment_ids.length
      setSelectedIds([])
      setNotice(`Sent ${sent_comment_ids.length} comment(s) to the agent.${skipped > 0 ? ` ${skipped} had already been handled by someone else.` : ""}`)
      onChanged?.()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dispatch failed.")
      // A 409 means the list is stale; refetch so it shows what happened.
      setSelectedIds([])
      onChanged?.()
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
                  <Checkbox
                    className="relative size-4.5 after:absolute after:-inset-1"
                    checked={selectedIds.includes(c.id)}
                    onCheckedChange={() => toggle(c.id)}
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
  const labels = useMemo(() => pinLabels(comments), [comments])
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
              // #5945: the design's tones: open, sent to an agent, done.
              "absolute z-20 flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[11px] font-bold shadow-md transition-all duration-[120ms] ease-out hover:scale-110",
              PIN_TONE_CLASS[pinTone(comment)],
              selectedPinId === comment.id && "ring-2 ring-white ring-offset-2 ring-offset-accent",
            )}
            style={{
              // The anchor is in the PAGE's px: offset by where the page sits
              // inside its board (header, frame or bezel).
              left: board.x + boardContentOrigin(deviceById(board.deviceId)).x + rect.x + rect.w,
              top: board.y + boardContentOrigin(deviceById(board.deviceId)).y + rect.y,
            }}
          >
            {labels.get(comment.id) ?? pinNumber(comment.id)}
          </button>
        )),
      )}
    </>
  )
}
