/// One activity entry in full (#5907 item 12), in the right-hand detail
/// sheet: who did it and when, the whole message, the task it's about, and
/// the raw tool payload. Read by id, so it works from any page that links
/// `?activity=<id>`, and the live feed's copy is used when it's already here.
import { Link } from "react-router-dom"
import { ActivityIcon, WrenchIcon } from "lucide-react"

import type { TaskflowTaskActivity } from "@/api/client"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Skeleton } from "@/components/ui/skeleton"
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { useLoad } from "../lib/use-load"
import { useDetail } from "../lib/use-detail"
import { useWorkspace } from "../workspace"
import { verbOf } from "./activity-logic"

/// The payload, pretty-printed when it's JSON.
function payload(raw: string | null): string | null {
  if (!raw?.trim()) return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function ActivityDetail({ id }: { id: number }) {
  const { live, projectTasks } = useWorkspace()
  const { href } = useDetail()
  const known = live?.taskActivity.find((r) => r.id === id)
  const loaded = useLoad(known ? null : `activity:${id}`, () => taskflowApi.get(taskflowTables.taskActivity, id) as Promise<TaskflowTaskActivity>)
  const row = known ?? loaded.data

  if (!row) {
    return loaded.error ? (
      <p className="text-sm text-destructive">Couldn&apos;t load this entry. It may have been removed, or be in another project.</p>
    ) : (
      <div className="space-y-3" aria-busy="true" aria-label="Loading the entry">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    )
  }

  const { verb, tool } = verbOf(row.action)
  const title = row.task != null ? projectTasks.find((t) => Number(t.id) === row.task)?.title : undefined
  const body = row.body_markdown?.trim()
  const meta = payload(row.metadata_json)
  const when = row.created_at ? new Date(row.created_at) : null

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        {row.actor_kind === "system" ? (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ActivityIcon className="size-4" />
          </span>
        ) : (
          <ActorAvatar model={row.actor_kind === "agent" ? guessModel(row.actor_label) : null} name={row.actor_label || "Someone"} size="md" />
        )}
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-medium">{row.actor_label || "Someone"}</span> {tool ? `ran ${verb}` : verb}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.actor_kind === "agent" ? "Agent" : row.actor_kind === "user" ? "Person" : "System"}
            {when ? (
              <>
                {" · "}
                <time dateTime={row.created_at ?? undefined}>{when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}</time>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
        <dt className="text-muted-foreground">Action</dt>
        <dd className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
          {tool ? <WrenchIcon className="size-3 shrink-0" aria-hidden /> : null}
          <span className="truncate">{row.action}</span>
        </dd>
        {row.task != null ? (
          <>
            <dt className="text-muted-foreground">Task</dt>
            <dd className="min-w-0 truncate">
              <Link to={href({ kind: "task", id: String(row.task) })} className="font-medium hover:underline">
                #{row.task}
              </Link>
              {title ? <span className="text-muted-foreground"> {title}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>

      {body ? (
        <section aria-label="Message">
          <h3 className="mb-2 text-sm font-semibold">Message</h3>
          <MarkdownRenderer content={body} className="text-sm" />
        </section>
      ) : null}

      {meta ? (
        <section aria-label="Details">
          <h3 className="mb-2 text-sm font-semibold">Details</h3>
          <pre className="max-h-[50svh] overflow-auto rounded-lg border border-border bg-terminal p-3 font-mono text-xs leading-relaxed text-terminal-foreground">{meta}</pre>
        </section>
      ) : null}

      {!body && !meta ? <p className="text-sm text-muted-foreground">Nothing more was recorded for this entry.</p> : null}
    </div>
  )
}
