/// The project switcher (design: project-switcher.html). A searchable popover
/// off the sidebar header, also on Ctrl/⌘ P. Every line is live data: the task
/// total and agents online come from the workspace summary, never invented.
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { CheckCheckIcon, CheckIcon, ChevronsUpDownIcon, HomeIcon, KeyRoundIcon, PlusIcon } from "lucide-react"

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

import { useWorkspace, type V3Project } from "../workspace"

function projectLine(p: V3Project): string {
  const tasks = `${p.taskCount} ${p.taskCount === 1 ? "task" : "tasks"}`
  return p.members > 0 ? `${tasks}, ${p.members} ${p.members === 1 ? "member" : "members"}` : tasks
}

function ProjectIcon({ project, active }: { project: Pick<V3Project, "name">; active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
      aria-hidden
    >
      {project.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

export function ProjectSwitcher() {
  const { projects, activeProject, chooseProject, counts } = useWorkspace()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<SidebarMenuButton size="lg" className="aria-expanded:bg-sidebar-accent" title="Switch project (Ctrl P)" />}>
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden>
          <CheckCheckIcon className="size-4" />
        </span>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate text-sm font-semibold">{activeProject?.name ?? "No project yet"}</span>
          <span className="truncate text-xs text-muted-foreground">
            {activeProject ? `${counts.onlineAgents} ${counts.onlineAgents === 1 ? "agent" : "agents"} online` : "Create one to start"}
          </span>
        </span>
        <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-1.5rem))] p-0" align="start" sideOffset={6}>
        <Command>
          <CommandInput placeholder="Find a project" aria-label="Find a project" />
          <CommandList className="max-h-80">
            <CommandEmpty>No project by that name.</CommandEmpty>
            {projects.length > 0 ? (
              <CommandGroup heading="Projects">
                {projects.map((p) => {
                  const active = p.id === activeProject?.id
                  return (
                    <CommandItem
                      key={p.id}
                      value={`${p.name} ${p.code}`}
                      onSelect={() => {
                        chooseProject(p.id)
                        setOpen(false)
                      }}
                      className="gap-3 py-2"
                    >
                      <ProjectIcon project={p} active={active} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{projectLine(p)}</span>
                      </span>
                      {p.agentsOnline > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title="Agents online">
                          <span className="size-1.5 rounded-full bg-running" aria-hidden />
                          {p.agentsOnline}
                        </span>
                      ) : null}
                      <CheckIcon className={cn("size-4", active ? "opacity-100" : "opacity-0")} aria-hidden />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem onSelect={() => go("/v3/projects/new")} className="gap-3">
                <PlusIcon className="text-muted-foreground" />
                New project
              </CommandItem>
              <CommandItem onSelect={() => go("/v3/account/invitations")} className="gap-3">
                <KeyRoundIcon className="text-muted-foreground" />
                Invitations
                {counts.pendingInvites > 0 ? <span className="ml-auto text-xs tabular-nums text-muted-foreground">{counts.pendingInvites}</span> : null}
              </CommandItem>
              <CommandItem onSelect={() => go("/v3/board")} className="gap-3">
                <HomeIcon className="text-muted-foreground" />
                Back to the board
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
