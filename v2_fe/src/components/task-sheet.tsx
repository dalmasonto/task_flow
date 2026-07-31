import { MessageAttachments } from "@/components/message-attachments"
import { Trash2 as Trash2Icon } from "lucide-react"
import { githubMirrorReason } from "@/lib/github-mirror-state"
import { githubMirrorState } from "@/lib/github-mirror-state"
import { ActivityIcon, AlertCircleIcon, ArrowRightIcon, BotIcon, CheckIcon, ClipboardCheckIcon, Clock3Icon, FileTextIcon, GitBranchIcon, LinkIcon, LockIcon, MessageSquareIcon, PaperclipIcon, PauseIcon, PencilIcon, PlayIcon, ShieldCheckIcon, TimerIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatDockContext } from "@/lib/markdown-contexts"
import { GithubNeedsConnectError, commentOnIssueAsMe, createTaskflowTaskRelation, deleteTaskflowTaskRelation, fetchGithubProjectStatus, githubConnectUrl, publishTaskAsIssue, type GithubProjectStatus, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { Link } from "react-router-dom"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { RELATION_KIND_OPTIONS, formatDuration, getFallbackTaskActivity, getLiveTaskActivity, getLiveTaskRelations, getLiveTaskReviews, getLiveTaskSessions, getRunningLiveTaskSession, getTaskAttachments, getTaskDescription, getTaskLinks, getTaskNotes, getTaskRelations, getTaskSessionTotalSeconds, getTaskSessions, isAgentOnline, liveId } from "@/lib/live-mappers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { columns, nextStatus, priorityClass, relationTone, statusLabel, type ColumnId, type Project, type Task, type TaskLink, type TaskRelation, type TaskSession } from "@/lib/workspace-view"
import { reviewDecisionClass, reviewDecisionLabel } from "@/lib/workspace-view"
import { type TaskflowTaskRelationKind, type TaskflowTaskStatus } from "@/api/client"
import { useContext, useEffect, useState, type ReactNode } from "react"
import { useLivenessNow } from "@/hooks/use-liveness-now"


export function TaskDetailSheet({
  task,
  project,
  projectTasks,
  liveWorkspace,
  onClose,
  onEdit,
  onDelete,
  onMove,
  onOpenTask,
  onOpenReview,
  onOpenMessage,
  onStartSession,
  onPauseSession,
  onStopSession,
  onUploadAttachment,
  onAddComment,
  offBoard = false,
}: {
  task: Task
  project: Project
  projectTasks: Task[]
  liveWorkspace?: TaskflowWorkspace | null
  /// True when this task was rendered from the server's row because the loaded
  /// board does not hold it. Everything the workspace owns is then UNKNOWN, not
  /// empty, and the sheet must say so instead of reporting an absence.
  offBoard?: boolean
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onMove: (status: ColumnId) => void
  onOpenTask: (taskId: string) => void
  onOpenReview: () => void
  onOpenMessage: () => void
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
  onUploadAttachment: (files: File[]) => void
  onAddComment: (body: string) => Promise<void>
}) {
  const currentStatus = columns.find((column) => column.id === task.status)
  const attachments = liveWorkspace ? getTaskAttachments(task, liveWorkspace) : []
  // Two-step delete: the first click arms it, the second confirms — no
  // AlertDialog component exists and window.confirm is off-brand.
  const [confirmDelete, setConfirmDelete] = useState(false)
  // #39: linking this task to another. Realtime echoes the new/removed row back
  // into liveWorkspace, so `relations` below updates without a refetch.
  const [relationTarget, setRelationTarget] = useState<string>("")
  const [relationKind, setRelationKind] = useState<TaskflowTaskRelationKind>("blocks")
  const [relationBusy, setRelationBusy] = useState(false)
  const [relationError, setRelationError] = useState<string | null>(null)

  const handleAddRelation = async () => {
    const projectId = liveId(project.id)
    const sourceId = liveId(task.id)
    const targetId = Number(relationTarget)
    if (!projectId || !sourceId || !targetId) return
    setRelationBusy(true)
    setRelationError(null)
    try {
      await createTaskflowTaskRelation({
        project: projectId,
        source_task: sourceId,
        target_task: targetId,
        kind: relationKind,
      })
      setRelationTarget("")
    } catch (error) {
      // A duplicate (same source/target/kind) trips the unique constraint — a 400
      // whose detail explains it. Surface the reason rather than failing silently.
      setRelationError(error instanceof Error ? error.message : "Could not link the task.")
    } finally {
      setRelationBusy(false)
    }
  }

  const handleRemoveRelation = async (relationId: number) => {
    setRelationError(null)
    try {
      await deleteTaskflowTaskRelation(relationId)
    } catch (error) {
      setRelationError(error instanceof Error ? error.message : "Could not remove the link.")
    }
  }
  const sessions = liveWorkspace ? getLiveTaskSessions(task, liveWorkspace) : getTaskSessions(task)
  const runningSession = liveWorkspace ? getRunningLiveTaskSession(task, liveWorkspace) : undefined
  const totalSessionSeconds = liveWorkspace ? getTaskSessionTotalSeconds(task, liveWorkspace) : null
  const relations = liveWorkspace ? getLiveTaskRelations(task, projectTasks, liveWorkspace) : getTaskRelations(task, projectTasks)
  const activity = liveWorkspace ? getLiveTaskActivity(task, liveWorkspace) : getFallbackTaskActivity(task)
  const reviews = liveWorkspace ? getLiveTaskReviews(task, liveWorkspace) : []
  const links = getTaskLinks(task, project)
  const description = getTaskDescription(task)
  const notes = getTaskNotes(task)

  // GitHub: the published issue (from the live row, or just-published locally),
  // plus this project's status which gates the publish/comment controls.
  const rawTask = liveWorkspace?.tasks.find((row) => String(row.id) === task.id)
  // #55: "Message agent" shows whenever this task HAS an agent operator —
  // liveness is shown, not required.
  //
  // Gating on isAgentOnline (as this first did) made the button all but
  // invisible: the Stop hook closes an agent's session at the end of every turn,
  // so between turns — exactly when someone is browsing the board — every agent
  // reads as offline. And messaging an offline agent is the NORMAL case here,
  // not a broken one: messages queue and the agent picks them up via
  // check_messages on its next turn. That is how humans direct agents in this
  // project. The dot reports presence; it does not withhold the affordance.
  const sheetLivenessNow = useLivenessNow()
  const chatDock = useContext(ChatDockContext)
  const operatorAgentId = rawTask?.operator_agent_id ?? null
  const operatorAgentOnline = Boolean(
    operatorAgentId != null &&
      liveWorkspace &&
      isAgentOnline(
        operatorAgentId,
        liveWorkspace.agents,
        liveWorkspace.agentSessions,
        sheetLivenessNow
      )
  )
  const [ghStatus, setGhStatus] = useState<GithubProjectStatus | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [ghActionError, setGhActionError] = useState<string | null>(null)
  const [localIssue, setLocalIssue] = useState<{ number: number; url: string } | null>(null)
  const [postedActivityIds, setPostedActivityIds] = useState<Set<string>>(new Set())
  const [postingActivityId, setPostingActivityId] = useState<string | null>(null)
  useEffect(() => {
    const projectId = liveId(project.id)
    if (projectId === null) return
    let active = true
    void fetchGithubProjectStatus(projectId)
      .then((status) => {
        if (active) setGhStatus(status)
      })
      .catch(() => {
        if (active) setGhStatus(null)
      })
    return () => {
      active = false
    }
  }, [project.id])
  const issueNumber = localIssue?.number ?? rawTask?.github_issue_number ?? null
  const issueUrl = localIssue?.url ?? rawTask?.github_issue_url ?? null
  const canCommentAsMe = Boolean(issueNumber && ghStatus?.user_connected && ghStatus?.post_as_me)
  // #25: one resolver drives the banner, the per-row button, and the composer
  // checkbox — so a blocked gate is stated once instead of silently hiding three
  // different controls.
  const mirrorState = githubMirrorState(ghStatus, issueNumber)
  const mirrorReason = githubMirrorReason(mirrorState)

  // #53: leave a comment on the task — stored as a `commented` activity item, so
  // it flows into the activity feed (and can then be pushed to the GitHub issue).
  const [commentDraft, setCommentDraft] = useState("")
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  // Mirror the comment to the linked GitHub issue on submit. Defaults on when
  // eligible (published issue + connected + opted in), so a comment posts with
  // one action instead of a second click on the per-row button.
  const [alsoPostToGithub, setAlsoPostToGithub] = useState(true)
  const submitComment = async () => {
    const body = commentDraft.trim()
    if (!body || commentBusy) return
    setCommentBusy(true)
    setCommentError(null)
    try {
      await onAddComment(body)
      setCommentDraft("")
      // The comment is recorded; the GitHub mirror is best-effort on top. If it
      // fails, the per-row "Post to issue" button remains for a retry. Auto-mirror
      // forces it regardless of the checkbox.
      if ((alsoPostToGithub || Boolean(ghStatus?.auto_mirror)) && canCommentAsMe) {
        const projectId = liveId(project.id)
        const taskId = liveId(task.id)
        if (projectId !== null && taskId !== null) {
          await commentOnIssueAsMe(projectId, taskId, body)
        }
      }
    } catch (error) {
      setCommentError(
        error instanceof GithubNeedsConnectError
          ? "Comment saved, but connect GitHub / enable “post as me” to mirror it."
          : error instanceof Error
            ? error.message
            : "Could not post the comment.",
      )
    } finally {
      setCommentBusy(false)
    }
  }

  // Shared by the header chip and the activity banner, so "publish" behaves
  // identically wherever it is offered.
  const handlePublish = async () => {
    const projectId = liveId(project.id)
    const taskId = liveId(task.id)
    if (projectId === null || taskId === null) return
    setPublishing(true)
    setGhActionError(null)
    try {
      const result = await publishTaskAsIssue(projectId, taskId)
      setLocalIssue({ number: result.issue_number, url: result.issue_url })
    } catch (error) {
      setGhActionError(
        error instanceof GithubNeedsConnectError
          ? "Connect GitHub to publish."
          : (error as Error).message,
      )
    } finally {
      setPublishing(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close task details"
        className="fixed inset-0 z-40 bg-foreground/10"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title} details`}
        className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-[1.35rem] border bg-card shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:top-4 sm:w-[min(54rem,calc(100vw-2rem))] sm:border-x sm:border-b"
      >
        <header
          className="relative shrink-0 overflow-hidden px-5 pb-7 pt-5"
          style={{
            background:
              "radial-gradient(circle at 18% 0%, color-mix(in oklab, var(--primary) 30%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent 74%)",
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(180deg,transparent,var(--card))]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{task.id}</p>
                <span className="rounded-full bg-background/75 px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border/80">
                  {project.name}
                </span>
              </div>
              <h2 className="mt-2 max-w-2xl text-2xl font-semibold leading-8">{task.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1", priorityClass(task.priority))}>
                  {task.priority}
                </span>
                <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {currentStatus?.title}
                </span>
                <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border">
                  {task.updated}
                </span>
                {issueNumber && issueUrl ? (
                  <a
                    href={issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-border hover:underline"
                  >
                    <GitBranchIcon className="size-3.5" />
                    {`#${issueNumber}`}
                  </a>
                ) : ghStatus?.project_linked ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={publishing || !ghStatus.can_publish}
                    title={ghStatus.can_publish ? "Open a GitHub issue for this task" : "Link GitHub and connect the owner account first"}
                    onClick={() => void handlePublish()}
                  >
                    <GitBranchIcon className="size-3.5" />
                    {publishing ? "Publishing…" : "Publish as issue"}
                  </Button>
                ) : null}
              </div>
              {ghActionError ? <p className="mt-2 text-xs text-destructive">{ghActionError}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {confirmDelete ? null : (
                <Button variant="ghost" size="sm" onClick={onEdit}>
                  <PencilIcon className="size-4" />
                  Edit
                </Button>
              )}
              {confirmDelete ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setConfirmDelete(false)
                      onDelete()
                    }}
                  >
                    Confirm delete
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <XIcon />
              </Button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="space-y-4">
              <section className="rounded-lg border bg-background p-4">
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Info label="Owner" value={task.owner} />
                  <Info label="Due" value={task.due} />
                  <Info label="Estimate" value={task.estimate} />
                  <Info
                    label="Operator"
                    value={task.operatorName}
                    // #55: message the agent running this task without leaving
                    // the sheet. Shown for any agent operator; the dot reports
                    // whether it is live right now, which is information rather
                    // than a reason to withhold the button.
                    action={
                      operatorAgentId != null && chatDock ? (
                        <button
                          type="button"
                          className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                          onClick={() => chatDock.openAgentChat(operatorAgentId)}
                          title={
                            operatorAgentOnline
                              ? `Message ${task.operatorName} (online)`
                              : `Message ${task.operatorName} — offline, it will pick this up on its next turn`
                          }
                        >
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              operatorAgentOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
                            )}
                          />
                          <MessageSquareIcon className="size-3.5" />
                          Message agent
                        </button>
                      ) : null
                    }
                  />
                  <Info label="Created by" value={task.createdBy} />
                </div>
              </section>

              <TaskDetailSection
                icon={<FileTextIcon className="size-4 text-primary" />}
                title="Description"
              >
                <MarkdownRenderer content={description} />
              </TaskDetailSection>

              <TaskDetailSection
                icon={<MessageSquareIcon className="size-4 text-primary" />}
                title="Notes"
              >
                <MarkdownRenderer content={notes} />
              </TaskDetailSection>

              <TaskDetailSection
                icon={<PaperclipIcon className="size-4 text-primary" />}
                title="Attachments"
                action={
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition hover:bg-muted">
                    <PaperclipIcon className="size-3.5" />
                    Attach
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        if (files.length) onUploadAttachment(files)
                        event.target.value = ""
                      }}
                    />
                  </label>
                }
              >
                {attachments.length ? (
                  <MessageAttachments attachments={attachments} />
                ) : offBoard ? (
                  <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                    Attachments can&rsquo;t be shown — this task isn&rsquo;t on the loaded board.
                    Open its project to see them.
                  </p>
                ) : (
                  <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                    No attachments yet. Attach an image to give the agent visual context.
                  </p>
                )}
              </TaskDetailSection>

              <TaskDetailSection
                icon={<ShieldCheckIcon className="size-4 text-amber-700" />}
                title="Human Review Gate"
                action={
                  <Button size="sm" onClick={onOpenReview}>
                    <ClipboardCheckIcon />
                    Decide
                  </Button>
                }
              >
                <MarkdownRenderer content={task.review} />

                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    {reviews.length ? `Reviews (${reviews.length})` : "Reviews"}
                  </p>
                  {reviews.length ? (
                    reviews.map((review) => (
                      <div key={review.id} className="rounded-lg border bg-background/60 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-semibold">{review.reviewerLabel}</span>
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                                reviewDecisionClass(review.decision)
                              )}
                            >
                              {reviewDecisionLabel(review.decision)}
                            </span>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">{review.time}</span>
                        </div>
                        {review.body ? (
                          <MarkdownRenderer content={review.body} compact className="mt-2 [&_p]:text-sm" />
                        ) : (
                          <p className="mt-2 text-sm italic text-muted-foreground">No note left.</p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No human reviews yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>

              <TaskDetailSection
                icon={<GitBranchIcon className="size-4 text-primary" />}
                title="Task Relations"
              >
                <div className="space-y-2">
                  {relations.length ? (
                    relations.map((relation) => (
                      <TaskRelationRow
                        key={relation.id}
                        relation={relation}
                        onOpenTask={onOpenTask}
                        onRemove={
                          relation.relationId != null
                            ? () => handleRemoveRelation(relation.relationId as number)
                            : undefined
                        }
                      />
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live task relations have been linked yet.
                    </p>
                  )}
                </div>

                {/* #39: link this task to another — pick a kind and a target. */}
                {liveWorkspace && liveId(task.id)
                  ? (() => {
                      const targetItems = projectTasks
                        .filter((candidate) => candidate.id !== task.id)
                        .map((candidate) => ({ id: liveId(candidate.id), title: candidate.title }))
                        .filter((candidate): candidate is { id: number; title: string } => candidate.id != null)
                        .map((candidate) => ({
                          value: String(candidate.id),
                          label: `#${candidate.id} · ${candidate.title}`,
                        }))
                      return (
                        <div className="mt-3 space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
                          <p className="text-xs font-medium text-muted-foreground">Link another task</p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              value={relationKind}
                              onValueChange={(value) => setRelationKind(value as TaskflowTaskRelationKind)}
                              items={RELATION_KIND_OPTIONS}
                            >
                              <SelectTrigger className="h-8 w-auto gap-1 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {RELATION_KIND_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select
                              value={relationTarget}
                              onValueChange={(value) => setRelationTarget(value ?? "")}
                              items={targetItems}
                            >
                              <SelectTrigger className="h-8 min-w-[11rem] flex-1 gap-1 text-xs">
                                <SelectValue placeholder="Choose a task…" />
                              </SelectTrigger>
                              <SelectContent>
                                {targetItems.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              size="sm"
                              onClick={handleAddRelation}
                              disabled={!relationTarget || relationBusy}
                            >
                              {relationBusy ? "Linking…" : "Link"}
                            </Button>
                          </div>
                          {relationError ? <p className="text-xs text-destructive">{relationError}</p> : null}
                        </div>
                      )
                    })()
                  : null}
              </TaskDetailSection>

              <TaskDetailSection
                icon={<TimerIcon className="size-4 text-primary" />}
                title="Sessions"
                action={
                  liveWorkspace ? (
                    <TaskSessionControls
                      task={task}
                      hasRunningSession={Boolean(runningSession)}
                      onStartSession={onStartSession}
                      onPauseSession={onPauseSession}
                      onStopSession={onStopSession}
                    />
                  ) : undefined
                }
              >
                {totalSessionSeconds != null ? (
                  <div className="mb-3 grid gap-2 rounded-lg border bg-muted/35 p-3 text-sm sm:grid-cols-3">
                    <Info label="Total focus" value={formatDuration(totalSessionSeconds)} />
                    <Info label="Sessions" value={String(sessions.length)} />
                    <Info label="Current" value={runningSession ? "Running" : "Idle"} />
                  </div>
                ) : null}
                <div className="space-y-2">
                  {sessions.length ? (
                    sessions.map((session) => (
                      <TaskSessionRow key={session.id} session={session} />
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live sessions are attached to this task yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>

              <TaskDetailSection
                icon={<ActivityIcon className="size-4 text-primary" />}
                title="Activity"
              >
                {mirrorReason ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <GitBranchIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0">{mirrorReason}</span>
                    {mirrorState.kind === "unpublished" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={publishing || !ghStatus?.can_publish}
                        title={
                          ghStatus?.can_publish
                            ? "Open a GitHub issue for this task"
                            : "Link GitHub and connect the owner account first"
                        }
                        onClick={() => void handlePublish()}
                      >
                        {publishing ? "Publishing…" : "Publish as issue"}
                      </Button>
                    ) : mirrorState.kind === "not_connected" ? (
                      <a
                        className="underline underline-offset-2 hover:text-primary"
                        href={githubConnectUrl("/dashboard/board")}
                      >
                        Connect GitHub
                      </a>
                    ) : (
                      <Link to="/dashboard/api" className="underline underline-offset-2 hover:text-primary">
                        Project GitHub settings
                      </Link>
                    )}
                  </div>
                ) : null}
                <div className="mb-3 rounded-lg border bg-background p-2 shadow-sm">
                  <textarea
                    rows={2}
                    className="max-h-40 min-h-9 w-full resize-y bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
                    placeholder="Leave a comment…"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      // Cmd/Ctrl+Enter submits; plain Enter keeps a newline.
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault()
                        void submitComment()
                      }
                    }}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {commentError ? (
                        <span className="text-destructive">{commentError}</span>
                      ) : (
                        <>Posts to the task's activity. ⌘/Ctrl+Enter to send.</>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {mirrorState.kind === "unknown" ? null : (
                        <label
                          className={cn(
                            "flex items-center gap-1.5 text-[11px]",
                            mirrorState.kind === "ready" || mirrorState.kind === "auto"
                              ? "text-muted-foreground"
                              : "text-muted-foreground/60",
                          )}
                          title={
                            mirrorReason ??
                            (mirrorState.kind === "auto"
                              ? "Auto-mirror is on for this project — comments post to the issue automatically"
                              : `Also post this comment to GitHub issue #${issueNumber} as you`)
                          }
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={mirrorState.kind === "auto" || (alsoPostToGithub && mirrorState.kind === "ready")}
                            disabled={mirrorState.kind !== "ready"}
                            onChange={(event) => setAlsoPostToGithub(event.target.checked)}
                          />
                          {issueNumber ? `Post to issue #${issueNumber}` : "Post to issue"}
                          {mirrorState.kind === "auto" ? " (auto)" : ""}
                        </label>
                      )}
                      <Button size="xs" disabled={commentBusy || !commentDraft.trim()} onClick={() => void submitComment()}>
                        {commentBusy ? "Posting…" : "Comment"}
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  {activity.length ? (
                    activity.map((event) => (
                      <div key={event.id} className="flex gap-3">
                        <Clock3Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <MarkdownRenderer content={event.detail} compact className="[&_p]:text-sm" />
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{event.actor}</span>
                            <span>{event.action.replace(/_/g, " ")}</span>
                            <span>{event.time}</span>
                            {mirrorState.kind === "unknown" ? null : mirrorState.kind === "auto" ? (
                              <span className="ml-auto text-muted-foreground/80">Mirrored automatically</span>
                            ) : postedActivityIds.has(String(event.id)) ? (
                              <span className="ml-auto text-emerald-600 dark:text-emerald-400">Posted to issue</span>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                className="ml-auto"
                                disabled={mirrorState.kind !== "ready" || postingActivityId === String(event.id)}
                                title={
                                  mirrorReason ?? `Post this to GitHub issue #${issueNumber} as you`
                                }
                                onClick={async () => {
                                  const projectId = liveId(project.id)
                                  const taskId = liveId(task.id)
                                  if (projectId === null || taskId === null) return
                                  setPostingActivityId(String(event.id))
                                  setGhActionError(null)
                                  try {
                                    await commentOnIssueAsMe(projectId, taskId, event.detail)
                                    setPostedActivityIds((prev) => new Set(prev).add(String(event.id)))
                                  } catch (error) {
                                    setGhActionError(
                                      error instanceof GithubNeedsConnectError
                                        ? "Connect GitHub and enable “post as me”."
                                        : (error as Error).message,
                                    )
                                  } finally {
                                    setPostingActivityId(null)
                                  }
                                }}
                              >
                                <GitBranchIcon className="size-3.5" />
                                {postingActivityId === String(event.id)
                                  ? "Posting…"
                                  : issueNumber
                                    ? `Post to #${issueNumber}`
                                    : "Post to issue"}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                      No live activity has been recorded for this task yet.
                    </p>
                  )}
                </div>
              </TaskDetailSection>
            </div>

            <aside className="space-y-3">
              <section className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <LockIcon className="size-4 text-primary" />
                  Agent Access
                </div>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Authenticate the workspace before linking agents, claims, or external accounts.
                </p>
                <div className="mt-3 grid gap-2">
                  <Button size="sm">
                    <ShieldCheckIcon />
                    Authenticate
                  </Button>
                  <Button variant="outline" size="sm" disabled>
                    <BotIcon />
                    Link Agent
                  </Button>
                  <Button variant="outline" size="sm" onClick={onOpenMessage}>
                    <MessageSquareIcon />
                    Message Room
                  </Button>
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <LinkIcon className="size-4 text-primary" />
                  Links
                </div>
                <div className="mt-3 space-y-2">
                  {links.map((link) => (
                    <TaskLinkRow key={link.label} link={link} />
                  ))}
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Move Task</p>
                <div className="mt-3 grid gap-2">
                  {columns.map((column) => (
                    <MoveTaskButton
                      key={column.id}
                      column={column}
                      active={task.status === column.id}
                      onClick={() => onMove(column.id)}
                    />
                  ))}
                </div>
              </section>

              <section className="rounded-lg border bg-background p-3">
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Tags</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {task.tags.map((tag) => (
                    <span key={tag} className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-background px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onMove("blocked")}>
            <PauseIcon />
            Put On Hold
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={() => onMove(nextStatus(task.status))}>
              <ArrowRightIcon />
              Move Forward
            </Button>
          </div>
        </footer>
      </section>
    </>
  )
}


export function TaskDetailSection({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}


export function TaskRelationRow({
  relation,
  onOpenTask,
  onRemove,
}: {
  relation: TaskRelation
  onOpenTask?: (taskId: string) => void
  /// #39: unlink this relation. Absent for synthetic/fallback relations, which
  /// have no row to delete.
  onRemove?: () => void
}) {
  const openable = relation.taskId && onOpenTask
  // The row is a plain container (not one big button) so the remove control can
  // live inside it — a button nested in a button is invalid. The title area is
  // the click target for opening the related task instead.
  return (
    <div className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/30">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {openable ? (
          <button
            type="button"
            className="min-w-0 flex-1 text-left focus-visible:outline-none"
            onClick={() => onOpenTask!(relation.taskId!)}
          >
            <p className="text-sm font-medium hover:text-primary">{relation.title}</p>
            <MarkdownRenderer content={relation.detail} compact className="mt-1" />
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{relation.title}</p>
            <MarkdownRenderer content={relation.detail} compact className="mt-1" />
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", relationTone(relation.type))}>
            {relation.type}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {statusLabel(relation.status)}
          </span>
          {openable ? (
            <button
              type="button"
              onClick={() => onOpenTask!(relation.taskId!)}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20 transition-colors hover:bg-primary/20"
            >
              Open
              <ArrowRightIcon className="size-3" />
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              aria-label="Remove link"
              title="Remove link"
              onClick={onRemove}
              className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}


export function TaskSessionControls({
  task,
  hasRunningSession,
  onStartSession,
  onPauseSession,
  onStopSession,
}: {
  task: Task
  hasRunningSession: boolean
  onStartSession: (task: Task) => void
  onPauseSession: (task: Task) => void
  onStopSession: (task: Task, finalStatus: Extract<TaskflowTaskStatus, "done" | "partial_done" | "blocked">) => void
}) {
  if (!hasRunningSession) {
    return (
      <Button size="sm" onClick={() => onStartSession(task)}>
        <PlayIcon />
        Start
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => onPauseSession(task)}>
        <PauseIcon />
        Pause
      </Button>
      <Button variant="outline" size="sm" onClick={() => onStopSession(task, "partial_done")}>
        <ClipboardCheckIcon />
        Review
      </Button>
      <Button variant="outline" size="sm" onClick={() => onStopSession(task, "blocked")}>
        <AlertCircleIcon />
        Block
      </Button>
      <Button size="sm" onClick={() => onStopSession(task, "done")}>
        <CheckIcon />
        Done
      </Button>
    </div>
  )
}


export function TaskSessionRow({ session }: { session: TaskSession }) {
  const tone =
    session.state === "active"
      ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
      : session.state === "paused"
        ? "bg-amber-100 text-amber-800 ring-amber-200"
        : "bg-slate-100 text-slate-700 ring-slate-200"

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{session.actor}</p>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", tone)}>
          {session.state}
        </span>
      </div>
      <MarkdownRenderer content={session.detail} compact className="mt-1" />
      {/* Left-aligned label/value grid: labels in a fixed first column so
          Started and Duration line up under each other on the left. */}
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-left text-xs">
        <span className="text-muted-foreground">Started</span>
        <span className="font-medium">{session.started}</span>
        <span className="text-muted-foreground">Duration</span>
        <span className="font-medium">{session.duration}</span>
      </div>
    </div>
  )
}


export function TaskLinkRow({ link }: { link: TaskLink }) {
  return (
    <div className="rounded-lg bg-muted/60 p-2.5">
      <p className="text-xs font-semibold text-foreground">{link.label}</p>
      <p className="mt-1 break-all text-[0.72rem] leading-4 text-muted-foreground">{link.value}</p>
      <MarkdownRenderer content={link.detail} compact className="mt-1" />
    </div>
  )
}


export function MoveTaskButton({
  column,
  active,
  onClick,
}: {
  column: (typeof columns)[number]
  active: boolean
  onClick: () => void
}) {
  const Icon = column.icon
  return (
    <Button variant={active ? "default" : "outline"} size="sm" onClick={onClick}>
      <Icon />
      {column.title}
    </Button>
  )
}


export function Info({ label, value, action }: { label: string; value: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-2.5">
      <p className="text-[0.68rem] font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
      {action}
    </div>
  )
}
