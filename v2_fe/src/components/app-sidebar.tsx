"use client"

import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavProjects, type SidebarProject } from "@/components/nav-projects"
import { NavUser } from "@/components/nav-user"
import { ProjectSwitcher, type SwitcherProject } from "@/components/team-switcher"
import type { AuthUser } from "@/lib/auth-api"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  Clock3Icon,
  FileJsonIcon,
  KanbanSquareIcon,
  ShieldCheckIcon,
  UserRoundPlusIcon,
} from "lucide-react"

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  projects: (SidebarProject & SwitcherProject)[]
  activeProjectId: string
  currentUser: AuthUser | null
  pendingReviews: number
  pendingInvites: number
  onlineAgents: number
  onProjectChange: (projectId: string) => void
  onNewProject: () => void
  onInviteProject: (projectId: string) => void
  onArchiveProject: (projectId: string) => void
  onNavigate: (to: string) => void
  onLogout: () => void
}

export function AppSidebar({
  projects,
  activeProjectId,
  currentUser,
  pendingReviews,
  pendingInvites,
  onlineAgents,
  onProjectChange,
  onNewProject,
  onInviteProject,
  onArchiveProject,
  onNavigate,
  onLogout,
  ...props
}: AppSidebarProps) {
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]
  const navMain = [
    {
      title: "Board",
      url: "/dashboard/board",
      icon: <KanbanSquareIcon />,
    },
    {
      title: "Agents",
      url: "/dashboard/agents",
      icon: <BotIcon />,
      badge: String(onlineAgents),
    },
    {
      title: "Reviews",
      url: "/dashboard/reviews",
      icon: <ShieldCheckIcon />,
      badge: String(pendingReviews),
    },
    {
      title: "Activity",
      url: "/dashboard/activity",
      icon: <ActivityIcon />,
    },
    {
      title: "Invites",
      url: "/dashboard/invites",
      icon: <UserRoundPlusIcon />,
      badge: pendingInvites ? String(pendingInvites) : undefined,
    },
    {
      title: "API Base",
      url: "/dashboard/api",
      icon: <FileJsonIcon />,
    },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ProjectSwitcher
          projects={projects}
          activeProjectId={activeProjectId}
          onProjectChange={onProjectChange}
          onNewProject={onNewProject}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        {activeProject ? (
          <div className="mx-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3 text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold uppercase tracking-normal text-sidebar-foreground/60">Project pulse</p>
                <p className="mt-1 truncate text-sm font-medium">{activeProject.health}</p>
              </div>
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-[oklch(0.985_0.006_230)]"
                style={{ background: activeProject.tint }}
              >
                {activeProject.code}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-md bg-sidebar/70 p-2">
                <div className="flex items-center gap-1.5 text-sidebar-foreground/60">
                  <BotIcon className="size-3.5" />
                  Agents
                </div>
                <p className="mt-1 font-semibold">{onlineAgents}</p>
              </div>
              <div className="rounded-md bg-sidebar/70 p-2">
                <div className="flex items-center gap-1.5 text-sidebar-foreground/60">
                  <CheckCircle2Icon className="size-3.5" />
                  Reviews
                </div>
                <p className="mt-1 font-semibold">{pendingReviews}</p>
              </div>
              <div className="rounded-md bg-sidebar/70 p-2">
                <div className="flex items-center gap-1.5 text-sidebar-foreground/60">
                  <Clock3Icon className="size-3.5" />
                  Invites
                </div>
                <p className="mt-1 font-semibold">{pendingInvites}</p>
              </div>
            </div>
          </div>
        ) : null}
        <NavProjects
          projects={projects}
          activeProjectId={activeProjectId}
          onProjectChange={onProjectChange}
          onInviteProject={onInviteProject}
          onArchiveProject={onArchiveProject}
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={currentUser ? { name: currentUser.username, email: currentUser.email } : null}
          pendingInvites={pendingInvites}
          onNavigate={onNavigate}
          onLogout={onLogout}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
