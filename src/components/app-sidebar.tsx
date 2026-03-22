import * as React from "react"
import { NavLink } from "react-router"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

const navItems = [
  { label: "Terminal", to: "/dashboard", icon: "terminal" },
  { label: "Projects", to: "/projects", icon: "grid_view" },
  { label: "Analytics", to: "/analytics", icon: "insights" },
  { label: "Dependencies", to: "/dependencies", icon: "account_tree" },
  { label: "Archive", to: "/archive", icon: "archive" },
]

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-4 py-3 px-3 uppercase text-sm tracking-widest font-headline transition-all duration-200 border-l-2 ${
    isActive
      ? "text-secondary border-secondary"
      : "text-gray-500 border-transparent hover:text-secondary/80"
  }`
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="sidebar" {...props}>
      <SidebarHeader className="px-4 pt-6 pb-2">
        <p className="text-xs uppercase tracking-widest text-on-surface-variant">
          Operator-01
        </p>
        <p className="text-xl font-extrabold tracking-tighter italic text-primary font-headline">
          TASKFLOW_OS
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
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild>
                  <NavLink to={item.to} className={navLinkClass}>
                    <span className="material-symbols-outlined text-lg">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-2 pb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <NavLink to="/settings" className={navLinkClass}>
                <span className="material-symbols-outlined text-lg">
                  settings
                </span>
                <span>Settings</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <NavLink
          to="/tasks/new"
          className="flex items-center justify-center w-full bg-primary text-primary-foreground font-bold text-xs uppercase tracking-widest py-3 transition-all duration-200 hover:shadow-[0_0_20px_rgba(222,142,255,0.4)]"
        >
          <span className="material-symbols-outlined text-lg mr-2">add</span>
          New Task
        </NavLink>
      </SidebarFooter>
    </Sidebar>
  )
}
