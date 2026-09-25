"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ChevronsUpDownIcon, FolderKanbanIcon, PlusIcon } from "lucide-react"
import { findActiveProject } from "@/lib/active-project"

export type SwitcherProject = {
  id: string
  name: string
  code: string
  health: string
  tint: string
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  onProjectChange,
  onNewProject,
}: {
  projects: SwitcherProject[]
  activeProjectId: string
  onProjectChange: (projectId: string) => void
  onNewProject: () => void
}) {
  const { isMobile } = useSidebar()
  // The shared resolver (lib/active-project), not a local fallback: this was a
  // fourth, independently-written `projects.find(...) ?? projects[0]`. App hands
  // us an already-resolved id, so `null` for the persisted argument is honest.
  const activeProject = findActiveProject(activeProjectId, null, projects)
  if (!activeProject) {
    // No projects yet — keep a visible way to create the first one so a
    // first-time user is never stranded with an empty sidebar.
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" onClick={onNewProject}>
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background/60">
              <PlusIcon className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">New project</span>
              <span className="truncate text-xs text-muted-foreground">No projects yet</span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="h-11 rounded-lg px-2 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <div
              className="flex aspect-square size-8 items-center justify-center rounded-lg text-sidebar-primary-foreground"
              style={{ background: activeProject.tint }}
            >
              <FolderKanbanIcon className="size-4" />
            </div>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeProject.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">{activeProject.health}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-72"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Projects
              </DropdownMenuLabel>
              {projects.map((project, index) => (
                <DropdownMenuItem
                  key={project.id}
                  onClick={() => onProjectChange(project.id)}
                  className="gap-2 p-2"
                >
                  <div
                    className="flex size-6 items-center justify-center rounded-md text-[0.65rem] font-semibold text-[oklch(0.985_0.006_230)]"
                    style={{ background: project.tint }}
                  >
                    {project.code}
                  </div>
                  <div className="grid min-w-0">
                    <span className="truncate">{project.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{project.health}</span>
                  </div>
                  <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="gap-2 p-2" onClick={onNewProject}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">
                  New project
                </div>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
