/// The v3 app shell: sidebar, top bar and ⌘K palette, from the design's
/// `tf-shell`. Built only from shadcn primitives; every number in it is live
/// workspace data, never a placeholder.
import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { BotIcon, InboxIcon, ChevronRightIcon, ChevronsUpDownIcon, CircleDotIcon, HashIcon, LogOutIcon, MessageSquareIcon, PlusIcon, SearchIcon, ServerIcon, SettingsIcon, TerminalIcon, UserIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { initialsFor } from "@/lib/user-display"
import { cn } from "@/lib/utils"

import { VIEWS } from "../board/board-logic"
import { ActorAvatar } from "../components/actor-avatar"
import { DetailSheetHost } from "../components/DetailSheet"
import { useDetail } from "../lib/use-detail"
import { V3_LOGIN } from "../routes"
import { useWorkspace, type V3Workspace } from "../workspace"
import { CommandPalette } from "./CommandPalette"
import { activeNavId, V3_NAV, type NavItem } from "./nav"
import { ProjectSwitcher } from "./ProjectSwitcher"
import { badgeText, type LiveAgent, type SidebarChat } from "./sidebar-logic"
import { useSidebarData } from "./use-sidebar-data"
import { OfflineBanner } from "../system/OfflineBanner"

/// tf-shell's group labels: sentence case, muted, not the primitive's small caps.
const LABEL = "text-xs font-medium normal-case text-muted-foreground"

/// A mention badge stays primary even on the active (selected) item, whose
/// own badge style would otherwise win.
const MENTION = "rounded-full bg-primary px-1.5 text-primary-foreground ring-0 peer-data-active/menu-button:bg-primary peer-data-active/menu-button:text-primary-foreground"

type NavCounts = V3Workspace["counts"] & { inbox: number; chat: number; decisions: number }

function NavLink({ item, active, counts, mention }: { item: NavItem; active: boolean; counts: NavCounts; mention: boolean }) {
  const n = item.count ? counts[item.count] : 0
  const Icon = item.icon
  const at = item.id === "chat" && mention
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} tooltip={item.label} render={<Link to={item.href} />}>
        <Icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
      {n > 0 ? (
        <SidebarMenuBadge
          className={cn(item.live && "gap-1 text-muted-foreground", at && MENTION)}
          aria-label={at ? `${n} unread, you are mentioned` : undefined}
        >
          {item.live ? <span className="size-1.5 rounded-full bg-running" aria-hidden /> : null}
          {at ? "@" : null}
          {badgeText(n)}
        </SidebarMenuBadge>
      ) : null}
      {item.id === "board" ? <BoardViews /> : null}
    </SidebarMenuItem>
  )
}

/// The design's saved views under Board. They are the board's own presets
/// (board-logic VIEWS); views people save themselves need a backend.
function BoardViews() {
  return (
    <SidebarMenuSub>
      {VIEWS.filter((v) => v.id !== "all").map((v) => (
        <SidebarMenuSubItem key={v.id}>
          <SidebarMenuSubButton render={<Link to={`/v3/board?view=${v.id}`} />}>
            <span>{v.label}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  )
}

/// A titled sidebar section that folds, like the design's `<details class="tf-sec">`.
/// Sections are labels-only, so rail mode hides them.
function Section({ title, count, action, children }: { title: string; count?: string; action?: { label: string; to: string }; children: ReactNode }) {
  return (
    <Collapsible defaultOpen className="group/section group-data-[collapsible=icon]:hidden">
      <SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className={cn(LABEL, "gap-1")}>
          <ChevronRightIcon className="transition-transform group-data-[open]/section:rotate-90" />
          {title}
          {count ? <span className="ml-1 tabular-nums group-data-[open]/section:hidden">{count}</span> : null}
        </SidebarGroupLabel>
        {action ? (
          <SidebarGroupAction title={action.label} aria-label={action.label} render={<Link to={action.to} />}>
            <PlusIcon />
          </SidebarGroupAction>
        ) : null}
        <CollapsibleContent>
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

const LIVE_SHOWN = 3
const CHATS_SHOWN = 8

function LiveNow({ agents }: { agents: LiveAgent[] }) {
  if (!agents.length) return null
  const shown = agents.slice(0, LIVE_SHOWN)
  const rest = agents.slice(LIVE_SHOWN)
  return (
    <Section title="Live now" count={String(agents.length)}>
      <SidebarMenu>
        {shown.map((a) => (
          <SidebarMenuItem key={a.id}>
            <SidebarMenuButton size="lg" className="h-auto py-1.5" render={<Link to={`/v3/agents/${a.id}`} />} title={`${a.name}, ${a.doing}`}>
              <ActorAvatar model={a.model} name={a.name} status={a.doing === "Online" ? "idle" : "running"} size="sm" />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-sm font-medium">{a.name}</span>
                <span className="truncate text-xs text-muted-foreground">{a.doing}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
        {rest.length ? (
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className="text-xs text-muted-foreground" render={<Link to="/v3/agents" />}>
              <span className="flex -space-x-1">
                {rest.slice(0, 4).map((a) => (
                  <ActorAvatar key={a.id} model={a.model} name={a.name} size="xs" />
                ))}
              </span>
              {rest.length} more online
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </Section>
  )
}

function ChatBadge({ row }: { row: SidebarChat }) {
  if (row.unread <= 0) return null
  const at = row.mentions > 0
  return (
    <SidebarMenuBadge
      className={cn("rounded-full px-1.5", at ? MENTION : "bg-muted text-muted-foreground")}
      aria-label={`${row.unread} unread${at ? ", you are mentioned" : ""}`}
    >
      {at ? "@" : null}
      {badgeText(row.unread)}
    </SidebarMenuBadge>
  )
}

function ChatSection({ title, rows, pathname, action, avatars }: { title: string; rows: SidebarChat[]; pathname: string; action: { label: string; to: string }; avatars?: boolean }) {
  if (!rows.length) return null
  const unread = rows.filter((r) => r.unread > 0).length
  // Unread first so nothing waiting falls below the fold, then the list's order.
  const ordered = [...rows].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0))
  const shown = ordered.slice(0, CHATS_SHOWN)
  return (
    <Section title={title} count={unread ? `${unread} unread` : undefined} action={action}>
      <SidebarMenu>
        {shown.map((r) => (
          <SidebarMenuItem key={r.id}>
            <SidebarMenuButton isActive={pathname === r.href} render={<Link to={r.href} />} className={cn(r.unread ? "font-medium" : "text-sidebar-foreground/75")}>
              {avatars ? <ActorAvatar model={r.agentModel} name={r.title} status={r.agentId != null ? (r.online ? "running" : "offline") : undefined} size="xs" /> : <HashIcon className="text-muted-foreground" />}
              <span>{r.title}</span>
            </SidebarMenuButton>
            <ChatBadge row={r} />
          </SidebarMenuItem>
        ))}
        {ordered.length > CHATS_SHOWN ? (
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className="text-xs text-muted-foreground" render={<Link to="/v3/chat" />}>
              All {ordered.length} in Chat
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </Section>
  )
}

/// The design's Create (+) menu: everything you can start from anywhere.
function CreateMenu() {
  const detail = useDetail()
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" aria-label="Create" title="Create" />}>
        <PlusIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuItem onClick={() => detail.open({ kind: "new-task", status: "not_started" })}>
          <CircleDotIcon />
          New task
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/v3/chat?new=dm")}>
          <MessageSquareIcon />
          New message
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/v3/chat?new=room")}>
          <HashIcon />
          New room
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/v3/agents/launch")}>
          <TerminalIcon />
          Launch an agent
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/v3/agents/new")}>
          <BotIcon />
          Add an agent
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/// Rail mode keeps who is live in view: their avatars under the nav.
function RailAgents({ agents }: { agents: LiveAgent[] }) {
  if (!agents.length) return null
  return (
    <SidebarGroup className="hidden group-data-[collapsible=icon]:flex">
      <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" />
      <div className="flex flex-col items-center gap-2">
        {agents.map((a) => (
          <Link key={a.id} to={`/v3/agents/${a.id}`} title={`${a.name}, ${a.doing}`} aria-label={`${a.name}, ${a.doing}`}>
            <ActorAvatar model={a.model} name={a.name} status={a.doing === "Online" ? "idle" : "running"} size="sm" />
          </Link>
        ))}
      </div>
    </SidebarGroup>
  )
}

function UserMenu() {
  const { currentUser, logout } = useWorkspace()
  const navigate = useNavigate()
  const name = currentUser?.username ?? "…"
  const initials = currentUser ? initialsFor({ username: currentUser.username, email: currentUser.email }) : "…"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="aria-expanded:bg-sidebar-accent" />}>
        <Avatar className="size-8">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="truncate text-xs text-muted-foreground">{currentUser?.email ?? ""}</span>
        </span>
        <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" side="top" align="start">
        <DropdownMenuItem onClick={() => navigate("/v3/account/profile")}>
          <UserIcon />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/v3/account/settings")}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/v3/account/servers")}>
          <ServerIcon />
          Servers and accounts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void logout().then(() => navigate(V3_LOGIN, { replace: true }))
          }}
        >
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/// A truthful feed indicator. The design has none, so it only shows when the
/// feed is NOT live (reconnecting, syncing): a dead feed must be visible
/// rather than silently stale (same rule as v2's header), a healthy one quiet.
function LiveStatus() {
  const { realtimeStatus, isSyncing, refresh } = useWorkspace()
  if (!isSyncing && realtimeStatus === "live") return null
  const label = isSyncing ? "Syncing" : realtimeStatus === "reconnecting" ? "Reconnecting" : "Connecting"
  return (
    <Button variant="ghost" size="sm" onClick={refresh} disabled={isSyncing} title="Refetch the workspace">
      <span className={cn("size-2 animate-pulse rounded-full", realtimeStatus === "reconnecting" ? "bg-blocked" : "bg-muted-foreground")} />
      {label}
    </Button>
  )
}

/// tf-shell's header chip: who is live, linking to Agents.
function LiveChip({ agents }: { agents: LiveAgent[] }) {
  if (!agents.length) return null
  return (
    <Link to="/v3/agents" className="hidden items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-0.5 hover:bg-accent sm:flex" aria-label={`${agents.length} agents live`} title={agents.map((a) => a.name).join(", ")}>
      <span className="flex -space-x-1">
        {agents.slice(0, 3).map((a) => (
          <ActorAvatar key={a.id} model={a.model} name={a.name} size="xs" className="ring-1 ring-background" />
        ))}
      </span>
      <span className="size-1.5 rounded-full bg-running" aria-hidden />
      <span className="text-xs tabular-nums">{agents.length}</span>
    </Link>
  )
}

/// tf-shell's inbox bell, with a dot while something waits on you.
function InboxBell({ waiting }: { waiting: number }) {
  return (
    <Button variant="ghost" size="icon-sm" className="relative" aria-label={waiting ? `Inbox, ${waiting} waiting on you` : "Inbox"} title="Inbox" render={<Link to="/v3/inbox" />}>
      <InboxIcon />
      {waiting ? <span className="absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden /> : null}
    </Button>
  )
}

export function V3Shell({ title, actions, flush, children }: { title: ReactNode; actions?: ReactNode; flush?: boolean; children: ReactNode }) {
  const { pathname } = useLocation()
  const { counts } = useWorkspace()
  const side = useSidebarData()
  const navCounts: NavCounts = { ...counts, inbox: side.inbox, chat: side.chat.unread, decisions: side.decisions }
  const active = activeNavId(pathname)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <ProjectSwitcher />
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="flex items-center gap-1.5 group-data-[collapsible=icon]:hidden">
            <Button variant="outline" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={() => setPaletteOpen(true)}>
              <SearchIcon />
              Search
              <Kbd className="ml-auto">Ctrl K</Kbd>
            </Button>
            <CreateMenu />
          </div>
        </SidebarHeader>
        <SidebarContent>
          {V3_NAV.map((group, gi) => {
            const menu = (
              <SidebarMenu>
                {group.items
                  .filter((item) => !item.paletteOnly)
                  .map((item) => (
                    <NavLink key={item.id} item={item} active={item.id === active} counts={navCounts} mention={side.chat.mention} />
                  ))}
              </SidebarMenu>
            )
            const block = !group.collapsible ? (
              <SidebarGroup key={group.title}>
                <SidebarGroupLabel className={LABEL}>{group.title}</SidebarGroupLabel>
                <SidebarGroupContent>{menu}</SidebarGroupContent>
              </SidebarGroup>
            ) : (
              <Collapsible key={`${group.title}-${group.items.some((i) => i.id === active)}`} defaultOpen={group.items.some((i) => i.id === active)} className="group/collapsible">
                <SidebarGroup>
                  <SidebarGroupLabel className={LABEL} render={<CollapsibleTrigger />}>
                    {group.title}
                    <ChevronRightIcon className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
                  </SidebarGroupLabel>
                  <CollapsibleContent>
                    <SidebarGroupContent>{menu}</SidebarGroupContent>
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
            )
            // The design puts Live now straight under Work.
            return gi === 0 ? (
              <div key={group.title} className="contents">
                {block}
                <LiveNow agents={side.agents} />
              </div>
            ) : (
              block
            )
          })}
          <RailAgents agents={side.agents} />
          <ChatSection title="Rooms" rows={side.rooms} pathname={pathname} action={{ label: "New room", to: "/v3/chat?new=room" }} />
          <ChatSection title="Direct messages" rows={side.dms} pathname={pathname} action={{ label: "New message", to: "/v3/chat?new=dm" }} avatars />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <h1 className="truncate text-base font-semibold">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <LiveStatus />
            <LiveChip agents={side.agents} />
            <InboxBell waiting={side.inbox} />
          </div>
        </header>
        <OfflineBanner />
        <main className={cn("min-h-0 flex-1 overflow-y-auto", !flush && "p-4 lg:p-6")}>{children}</main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <DetailSheetHost />
    </SidebarProvider>
  )
}
