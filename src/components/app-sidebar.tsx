import * as React from "react"
import { NavLink, useMatch, useResolvedPath } from "react-router"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { useSetting } from "@/hooks/use-settings"

const navItems = [
  { label: "Dashboard", to: "/dashboard", icon: "dashboard" },
  { label: "Projects", to: "/projects", icon: "grid_view" },
  { label: "Analytics", to: "/analytics", icon: "insights" },
  { label: "Activity Pulse", to: "/activity", icon: "monitoring" },
  { label: "Dependencies", to: "/dependencies", icon: "account_tree" },
  { label: "Archive", to: "/archive", icon: "archive" },
]

function SidebarNavLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })

  return (
    <SidebarMenuItem>
      <NavLink
        to={to}
        className={`flex items-center gap-4 px-3 py-2 uppercase text-sm tracking-widest font-headline transition-all duration-200 border-l-2 ${
          match
            ? "text-secondary border-secondary"
            : "text-gray-500 border-transparent hover:text-secondary/80"
        }`}
      >
        <span className="material-symbols-outlined text-lg">{icon}</span>
        <span>{label}</span>
      </NavLink>
    </SidebarMenuItem>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const operatorName = useSetting('operatorName')
  const systemName = useSetting('systemName')

  return (
    <Sidebar variant="sidebar" {...props}>
      <SidebarHeader className="px-4 pt-6 pb-2">
        <p className="text-xs uppercase tracking-widest text-on-surface-variant">
          {operatorName}
        </p>
        <p className="text-xl font-extrabold tracking-tighter italic text-primary font-headline">
          {systemName}
        </p>
        <p className="text-[10px] uppercase tracking-widest text-on-surface-variant">
          V2.0.4
        </p>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-2">
            {navItems.map((item) => (
              <SidebarNavLink key={item.to} {...item} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-2" style={{ paddingBottom: 'calc(1rem + var(--timer-bar-height, 0px))' }}>
        <SidebarMenu>
          <SidebarNavLink to="/settings" icon="settings" label="Settings" />
        </SidebarMenu>

        <div className="flex gap-2">
          <NavLink
            to="/tasks/new"
            className="flex-1 flex items-center justify-center bg-primary text-primary-foreground font-bold text-xs uppercase tracking-widest py-3 transition-all duration-200 hover:shadow-[0_0_20px_rgba(222,142,255,0.4)]"
          >
            <span className="material-symbols-outlined text-lg mr-2">add</span>
            New Task
          </NavLink>
          <NavLink
            to="/tasks/bulk"
            className="flex items-center justify-center bg-secondary/10 text-secondary font-bold text-xs uppercase tracking-widest px-3 py-3 border border-secondary/30 transition-all duration-200 hover:bg-secondary/20"
            title="Bulk add tasks"
          >
            <span className="material-symbols-outlined text-lg">playlist_add</span>
          </NavLink>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
