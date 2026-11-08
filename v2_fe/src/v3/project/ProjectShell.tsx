/// The project settings pages' frame: the app shell titled with the project
/// and a tab row across Settings, Instructions, Workflow, Repositories, GitHub
/// and Environments (the design's "<project> settings" pages). Same shape as
/// AccountShell: the row scrolls sideways on phones, the active tab in view.
import { useEffect, useRef, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"

import { cn } from "@/lib/utils"

import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"

const PROJECT_TABS = [
  { id: "settings", label: "Settings" },
  { id: "instructions", label: "Instructions" },
  { id: "workflow", label: "Workflow" },
  { id: "repos", label: "Repositories" },
  { id: "github", label: "GitHub" },
  { id: "endpoints", label: "Environments" },
] as const

export function ProjectShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { pathname } = useLocation()
  const { activeProject, live } = useWorkspace()
  const activeRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [pathname])
  const name = live?.project.name ?? activeProject?.name ?? "Project"
  return (
    <V3Shell title={`${name} settings`} actions={actions}>
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Project settings" className="-mx-4 overflow-x-auto border-b border-border px-4 lg:mx-0 lg:px-0">
          <ul className="flex gap-1">
            {PROJECT_TABS.map((t) => {
              const href = `/v3/project/${t.id}`
              const on = pathname === href
              return (
                <li key={t.id}>
                  <Link
                    ref={on ? activeRef : undefined}
                    to={href}
                    aria-current={on ? "page" : undefined}
                    className={cn("relative flex h-10 items-center px-3 text-sm whitespace-nowrap", on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.label}
                    {on ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" /> : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="mt-8">{children}</div>
      </div>
    </V3Shell>
  )
}

/// A titled block on these pages.
export function Section({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-4", className)}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}
