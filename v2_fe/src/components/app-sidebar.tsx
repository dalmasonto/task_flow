"use client"

import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavProjects, type SidebarProject } from "@/components/nav-projects"
import { NavUser } from "@/components/nav-user"
import { ProjectSwitcher, type SwitcherProject } from "@/components/team-switcher"
import type { AuthUser } from "@/lib/auth-api"
import { findActiveProject } from "@/lib/active-project"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  ActivityIcon,
  FileJsonIcon,
  ImageIcon,
  KanbanSquareIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PenToolIcon,
  ShieldCheckIcon,
  UserRoundPlusIcon,
} from "lucide-react"

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  projects: (SidebarProject & SwitcherProject)[]
  activeProjectId: string
  currentUser: AuthUser | null
  pendingReviews: number
  pendingInvites: number
  /// The signed-in user's own invite inbox count (not the active project's
  /// outgoing invites) — shown on the account-facing NavUser badge only.
  myInviteCount: number
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
  myInviteCount,
  onlineAgents,
  onProjectChange,
  onNewProject,
  onInviteProject,
  onArchiveProject,
  onNavigate,
  onLogout,
  ...props
}: AppSidebarProps) {
  // The shared resolver (lib/active-project), not a local fallback: this was a
  // third, independently-written `projects.find(...) ?? projects[0]`, which knew
  // nothing about the user's persisted choice. App hands us an already-resolved
  // id, so `null` for the persisted argument is honest — a display layer has no
  // preference of its own.
  const activeProject = findActiveProject(activeProjectId, null, projects)
  // On mobile the sidebar is a Sheet overlay; navigating away should dismiss it
  // so the destination isn't left behind the overlay. On desktop it stays put.
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])
  const navMain = [
    {
      title: "Dashboard",
      url: "/dashboard/overview",
      icon: <LayoutDashboardIcon />,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Media",
      url: "/dashboard/media",
      icon: <ImageIcon />,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Board",
      url: "/dashboard/board",
      icon: <KanbanSquareIcon />,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Design",
      url: "/dashboard/design",
      icon: <PenToolIcon />,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Chat",
      url: "/dashboard/agents",
      icon: <MessageSquareIcon />,
      badge: onlineAgents ? String(onlineAgents) : undefined,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Reviews",
      url: "/dashboard/reviews",
      icon: <ShieldCheckIcon />,
      badge: pendingReviews ? String(pendingReviews) : undefined,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Activity",
      url: "/dashboard/activity",
      icon: <ActivityIcon />,
      onSelect: closeMobileSidebar,
    },
    {
      title: "Invites",
      url: "/dashboard/invites",
      icon: <UserRoundPlusIcon />,
      badge: pendingInvites ? String(pendingInvites) : undefined,
      onSelect: closeMobileSidebar,
    },
    {
      title: "API Base",
      url: "/dashboard/api",
      icon: <FileJsonIcon />,
      onSelect: closeMobileSidebar,
    },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ProjectSwitcher
          projects={projects}
          activeProjectId={activeProjectId}
          onProjectChange={(projectId) => {
            closeMobileSidebar()
            onProjectChange(projectId)
          }}
          onNewProject={onNewProject}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        {activeProject ? (
          <div className="mx-3 flex items-center gap-2 border-y border-sidebar-border/70 py-2 text-xs text-sidebar-foreground/65 group-data-[collapsible=icon]:hidden">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">{activeProject.health}</span>
            <span className="h-3 w-px shrink-0 bg-sidebar-border" />
            <span className="shrink-0 tabular-nums">{onlineAgents} online</span>
            {pendingReviews ? (
              <>
                <span className="h-3 w-px shrink-0 bg-sidebar-border" />
                <span className="shrink-0 tabular-nums">{pendingReviews} reviews</span>
              </>
            ) : null}
          </div>
        ) : null}
        <NavProjects
          projects={projects}
          activeProjectId={activeProjectId}
          onProjectChange={(projectId) => {
            closeMobileSidebar()
            onProjectChange(projectId)
          }}
          onInviteProject={onInviteProject}
          onArchiveProject={onArchiveProject}
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={currentUser ? { name: currentUser.username, email: currentUser.email } : null}
          pendingInvites={myInviteCount}
          onNavigate={(to) => {
            closeMobileSidebar()
            onNavigate(to)
          }}
          onLogout={onLogout}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
