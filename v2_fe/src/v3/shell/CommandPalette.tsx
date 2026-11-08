/// The ⌘K palette (design: command-palette.html): tasks, agents with their
/// quick actions, actions, and every page. Reads App's live state only; the
/// palette never fetches. "Ask an agent" arrives with the v3 chat (group 5).
import { useLocation, useNavigate } from "react-router-dom"
import { MessageSquareIcon, MoonIcon, PencilIcon, PlusIcon, SunIcon, TerminalIcon } from "lucide-react"

import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { detailHref } from "../lib/detail-params"
import { useWorkspace } from "../workspace"
import { V3_NAV } from "./nav"
import { paletteAgents, paletteTasks, taskSearchValue } from "./palette-logic"
import { toggleTheme, useIsDark } from "./theme-action"

const STATUS_DOT: Record<string, string> = {
  not_started: "bg-muted-foreground/50",
  in_progress: "bg-running",
  review: "bg-review",
  blocked: "bg-blocked",
  done: "bg-done",
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const { projects, activeProject, projectTasks, live, chooseProject } = useWorkspace()
  const now = useLivenessNow()
  const agents = live ? paletteAgents(live.agents, live.agentSessions, now) : []
  const tasks = paletteTasks(projectTasks)
  const dark = useIsDark()

  const go = (to: string) => {
    onOpenChange(false)
    navigate(to)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Search tasks, agents and pages, or run an action">
      {/* This shadcn version's CommandDialog doesn't provide the cmdk root itself. */}
      <Command>
        <CommandInput placeholder="Search tasks, agents and pages" />
        <CommandList className="max-h-[min(28rem,70vh)]">
          <CommandEmpty>Nothing matches. Try a task number like #721.</CommandEmpty>

          {tasks.length > 0 ? (
            <CommandGroup heading={activeProject ? `Tasks in ${activeProject.name}` : "Tasks"}>
              {tasks.map((t) => (
                <CommandItem key={t.id} value={taskSearchValue(t)} onSelect={() => go(detailHref(pathname, search, { kind: "task", id: t.id }))} className="gap-2.5">
                  <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[t.status] ?? "bg-muted-foreground/50")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">#{t.id}</span> {t.title}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {agents.length > 0 ? (
            <CommandGroup heading="Agents">
              {agents.map((a) => (
                <CommandItem key={a.id} value={`agent ${a.name}`} onSelect={() => go(`/v3/chat?agent=${a.id}`)} className="gap-2.5">
                  <ActorAvatar model={a.model} name={a.name} status={a.status} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.detail}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      <MessageSquareIcon className="size-3" aria-hidden />
                      Message
                    </span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        go(`/v3/agents/${a.id}`)
                      }}
                    >
                      <TerminalIcon className="size-3" aria-hidden />
                      Terminal
                    </button>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          <CommandGroup heading="Actions">
            <CommandItem value="new task create" onSelect={() => go(detailHref(pathname, search, { kind: "new-task", status: "not_started" }))}>
              <PlusIcon />
              New task
            </CommandItem>
            <CommandItem value="start a dm message direct" onSelect={() => go("/v3/chat?new=dm")}>
              <PencilIcon />
              Start a DM with a person or agent
            </CommandItem>
            <CommandItem value="new project create" onSelect={() => go("/v3/projects/new")}>
              <PlusIcon />
              New project
            </CommandItem>
            <CommandItem
              value="switch theme dark light mode"
              onSelect={() => {
                onOpenChange(false)
                void toggleTheme()
              }}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
              Switch theme to {dark ? "light" : "dark"}
            </CommandItem>
          </CommandGroup>

          {V3_NAV.map((group) => (
            <CommandGroup key={group.title} heading={`Jump to: ${group.title}`}>
              {group.items.map((item) => (
                <CommandItem key={item.id} value={`go ${group.title} ${item.label}`} onSelect={() => go(item.href)}>
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}

          {projects.length > 1 ? (
            <CommandGroup heading="Switch project">
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`project ${p.name}`}
                  onSelect={() => {
                    chooseProject(p.id)
                    onOpenChange(false)
                  }}
                >
                  <span className="truncate">{p.name}</span>
                  {p.id === activeProject?.id ? <CommandShortcut>Current</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
