/// Environments (design: project-endpoints.html): the servers this project
/// runs on. Agents read the default one when they test an API.
///
/// Read-only for now. Since #1137 nobody can write these rows through REST
/// (a viewer could have pointed agents at their own server), and the
/// owner/admin add / edit / remove / set-default handlers are with the backend
/// owner. Health is whatever the server last recorded; a local address can't
/// be checked from the server, so it says so instead.
import { ServerIcon } from "lucide-react"

import type { TaskflowProjectApiEndpoint } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { isLocalUrl, sortEndpoints } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

const ENV_LABEL: Record<TaskflowProjectApiEndpoint["environment"], string> = { production: "Production", staging: "Staging", preview: "Preview", local: "Local" }

const HEALTH: Record<TaskflowProjectApiEndpoint["health"], { label: string; dot: string }> = {
  healthy: { label: "Healthy", dot: "bg-done" },
  degraded: { label: "Slow", dot: "bg-blocked" },
  down: { label: "Down", dot: "bg-destructive" },
  unknown: { label: "Not checked", dot: "bg-muted-foreground/40" },
}

export function ProjectEndpointsPage() {
  const { live } = useWorkspace()
  const now = useLivenessNow()
  const rows = sortEndpoints(live?.apiEndpoints ?? [])

  return (
    <ProjectShell>
      <Section title="Environments" description="The servers this project runs on. Agents read the default one when they test an API.">
        {!live ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : rows.length ? (
          <ul className="divide-y rounded-xl border bg-card">
            {rows.map((e) => {
              const local = isLocalUrl(e.base_url)
              const h = HEALTH[e.health] ?? HEALTH.unknown
              return (
                <li key={e.id} className="grid gap-1 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{e.label}</span>
                    <Badge variant="outline">{ENV_LABEL[e.environment] ?? e.environment}</Badge>
                    {e.is_default ? <Badge>Default</Badge> : null}
                    {!local ? (
                      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn("size-2 rounded-full", h.dot)} aria-hidden />
                        {h.label}
                      </span>
                    ) : null}
                  </div>
                  <code className="truncate font-mono text-xs text-muted-foreground">{e.base_url}</code>
                  <p className="text-xs text-muted-foreground">
                    {local ? "Local addresses aren't checked from our server." : e.last_checked_at ? `Checked ${timeAgo(e.last_checked_at, now)?.toLowerCase()}.` : "Not checked yet."}
                  </p>
                  {e.notes_markdown ? <p className="text-xs">{e.notes_markdown}</p> : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>No environments yet</EmptyTitle>
              <EmptyDescription>{live.project.default_api_base_url ? `Agents use ${live.project.default_api_base_url} for now.` : "Agents have no API address to test against yet."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <p className="text-sm text-muted-foreground">Adding, editing and removing environments is coming. Only owners and admins will be able to change them.</p>
      </Section>
    </ProjectShell>
  )
}
