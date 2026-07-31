import { reviewDecisionClass, reviewDecisionLabel } from "@/lib/workspace-view"
import { Button } from "@/components/ui/button"
import { ClipboardCheckIcon, ShieldCheckIcon } from "lucide-react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { PageShell } from "@/components/layout"
import { cn } from "@/lib/utils"
import { priorityClass, statusLabel, type Task } from "@/lib/workspace-view"
import { type ReviewFeedItem } from "@/lib/live-mappers"






export function ReviewsPage({
  tasks,
  reviews,
  onReview,
}: {
  tasks: Task[]
  reviews: ReviewFeedItem[]
  onReview: (taskId: string) => void
}) {
  // reviews arrives newest-first, so the first match per task id is the latest
  // real review for that task.
  const latestReviewByTask = new Map<string, ReviewFeedItem>()
  for (const review of reviews) {
    if (!latestReviewByTask.has(review.taskId)) latestReviewByTask.set(review.taskId, review)
  }

  return (
    <PageShell
      eyebrow="Human in the loop"
      title="Review Queue"
      description="Review gates collect decisions that should not be left to autonomous execution."
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Pending Decisions</h2>
              <p className="mt-1 text-xs text-muted-foreground">{tasks.length} tasks are waiting for a human decision.</p>
            </div>
          </div>
          {tasks.length ? (
            <div className="scrollbar-y overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead className="bg-muted/55 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Task</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Owner</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Latest review</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Due</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const latest = latestReviewByTask.get(task.id)
                    return (
                    <tr key={task.id} className="border-t">
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", priorityClass(task.priority))}>
                            {task.priority}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {statusLabel(task.status)}
                          </span>
                        </div>
                        <p className="mt-2 font-medium">{task.title}</p>
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">
                        <p className="font-medium text-foreground">{task.owner}</p>
                        <p className="mt-1 text-xs">{task.operatorName}</p>
                      </td>
                      <td className="max-w-md px-4 py-3 align-top text-muted-foreground">
                        {latest ? (
                          <div className="space-y-1.5">
                            <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(latest.decision))}>
                              {reviewDecisionLabel(latest.decision)}
                            </span>
                            {latest.body ? (
                              <MarkdownRenderer content={latest.body} compact className="[&_p]:line-clamp-2 [&_p]:text-sm" />
                            ) : null}
                            <p className="text-xs text-muted-foreground">{latest.reviewerLabel} · {latest.time}</p>
                          </div>
                        ) : task.description?.trim() ? (
                          <MarkdownRenderer content={task.description} compact className="[&_p]:line-clamp-2 [&_p]:text-sm" />
                        ) : (
                          <span className="text-xs">No review recorded yet.</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground">{task.due}</td>
                      <td className="px-4 py-3 text-right align-top">
                        <Button size="sm" onClick={() => onReview(task.id)}>
                          <ClipboardCheckIcon />
                          Decide
                        </Button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">No pending human reviews.</div>
          )}
        </section>
        <aside className="space-y-3">
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardCheckIcon className="size-4 text-primary" />
              Recent reviews
            </div>
            {reviews.length ? (
              <ul className="mt-4 space-y-3">
                {reviews.slice(0, 8).map((review) => (
                  <li key={review.id} className="rounded-lg bg-muted/55 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1", reviewDecisionClass(review.decision))}>
                        {reviewDecisionLabel(review.decision)}
                      </span>
                      <span className="text-xs text-muted-foreground">{review.time}</span>
                    </div>
                    <p className="mt-2 truncate text-sm font-medium">{review.taskTitle}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{review.reviewerLabel}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No review decisions recorded yet.</p>
            )}
          </section>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheckIcon className="size-4 text-primary" />
              How reviews work
            </div>
            <div className="mt-4 space-y-3">
              <ReviewRule title="Approve" detail="Records an approval and marks the task done." />
              <ReviewRule title="Request changes" detail="Sends the task back to active work with the reviewer note attached." />
            </div>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}


export function ReviewRule({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}
