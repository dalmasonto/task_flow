"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { MoreHorizontalIcon, FolderIcon, ArrowRightIcon, ArchiveIcon } from "lucide-react"

export type SidebarProject = {
  id: string
  name: string
  code: string
  taskCount: number
  health: string
  tint: string
}

export function NavProjects({
  projects,
  activeProjectId,
  onProjectChange,
  onInviteProject,
  onArchiveProject,
}: {
  projects: SidebarProject[]
  activeProjectId: string
  onProjectChange: (projectId: string) => void
  onInviteProject: (projectId: string) => void
  onArchiveProject: (projectId: string) => void
}) {
  const { isMobile } = useSidebar()
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarMenu>
        {projects.map((item) => (
          <SidebarMenuItem key={item.name}>
            <SidebarMenuButton
              className="h-auto py-2 pr-8"
              isActive={item.id === activeProjectId}
              onClick={() => onProjectChange(item.id)}
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[0.55rem] font-semibold text-[oklch(0.985_0.006_230)]"
                style={{ background: item.tint }}
              >
                {item.code}
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate">{item.name}</span>
                <span className="truncate text-[0.68rem] text-sidebar-foreground/55">
                  {item.taskCount} tasks · {item.health}
                </span>
              </span>
            </SidebarMenuButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuAction
                    showOnHover
                    className="aria-expanded:bg-muted"
                  />
                }
              >
                <MoreHorizontalIcon
                />
                <span className="sr-only">More</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-fit"
                side={isMobile ? "bottom" : "right"}
                align={isMobile ? "end" : "start"}
              >
                <DropdownMenuItem onClick={() => onProjectChange(item.id)}>
                  <FolderIcon
                  />
                  <span>View Project</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onInviteProject(item.id)}>
                  <ArrowRightIcon
                  />
                  <span>Invite People</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onArchiveProject(item.id)}>
                  <ArchiveIcon
                  />
                  <span>Archive Project</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
        <SidebarMenuItem>
          <SidebarMenuButton className="text-sidebar-foreground/70">
            <MoreHorizontalIcon className="text-sidebar-foreground/70" />
            <span>{projects.length} projects</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
