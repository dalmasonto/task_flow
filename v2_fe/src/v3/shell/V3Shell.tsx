/// The v3 app shell: sidebar, top bar and ⌘K palette, from the design's
/// `tf-shell`. Built only from shadcn primitives; every number in it is live
/// workspace data, never a placeholder.
import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { ChevronRightIcon, ChevronsUpDownIcon, LogOutIcon, PlusIcon, SearchIcon, ServerIcon, SettingsIcon, UserIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { initialsFor } from "@/lib/user-display"
import { cn } from "@/lib/utils"

import { V3_LOGIN } from "../routes"
import { useWorkspace, type V3Workspace } from "../workspace"
import { CommandPalette } from "./CommandPalette"
import { activeNavId, V3_NAV, type NavItem } from "./nav"
import { ProjectSwitcher } from "./ProjectSwitcher"
import { OfflineBanner } from "../system/OfflineBanner"

function NavLink({ item, active, counts }: { item: NavItem; active: boolean; counts: V3Workspace["counts"] }) {
  const n = item.count ? counts[item.count] : 0
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} tooltip={item.label} render={<Link to={item.href} />}>
        <Icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
      {n > 0 ? (
        <SidebarMenuBadge className={cn(item.live && "gap-1 text-muted-foreground")}>
          {item.live ? <span className="size-1.5 rounded-full bg-running" aria-hidden /> : null}
          {n}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
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

/// A truthful feed indicator: green when live, amber while reconnecting, so a
/// dead feed is visible instead of silently stale (same rule as v2's header).
function LiveStatus() {
  const { realtimeStatus, isSyncing, refresh } = useWorkspace()
  const label = isSyncing ? "Syncing" : realtimeStatus === "reconnecting" ? "Reconnecting" : realtimeStatus === "connecting" ? "Connecting" : "Live"
  return (
    <Button variant="ghost" size="sm" onClick={refresh} disabled={isSyncing} title="Refetch the workspace">
      <span
        className={cn(
          "size-2 rounded-full",
          isSyncing || realtimeStatus === "connecting"
            ? "animate-pulse bg-muted-foreground"
            : realtimeStatus === "reconnecting"
              ? "animate-pulse bg-blocked"
              : "bg-running",
        )}
      />
      {label}
    </Button>
  )
}

export function V3Shell({ title, actions, flush, children }: { title: string; actions?: ReactNode; flush?: boolean; children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { counts } = useWorkspace()
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
            <Button size="icon-sm" aria-label="New task" title="New task" onClick={() => navigate("/v3/board?new=task")}>
              <PlusIcon />
            </Button>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {V3_NAV.map((group) => {
            const menu = (
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavLink key={item.id} item={item} active={item.id === active} counts={counts} />
                ))}
              </SidebarMenu>
            )
            if (!group.collapsible) {
              return (
                <SidebarGroup key={group.title}>
                  <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
                  <SidebarGroupContent>{menu}</SidebarGroupContent>
                </SidebarGroup>
              )
            }
            const inGroup = group.items.some((i) => i.id === active)
            return (
              <Collapsible key={`${group.title}-${inGroup}`} defaultOpen={inGroup} className="group/collapsible">
                <SidebarGroup>
                  <SidebarGroupLabel render={<CollapsibleTrigger />}>
                    {group.title}
                    <ChevronRightIcon className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
                  </SidebarGroupLabel>
                  <CollapsibleContent>
                    <SidebarGroupContent>{menu}</SidebarGroupContent>
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
            )
          })}
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
          <h1 className="truncate text-sm font-medium">{title}</h1>
          <Badge variant="outline" className="hidden sm:inline-flex">
            v3 preview
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <LiveStatus />
          </div>
        </header>
        <OfflineBanner />
        <main className={cn("min-h-0 flex-1 overflow-y-auto", !flush && "p-4 lg:p-6")}>{children}</main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}
