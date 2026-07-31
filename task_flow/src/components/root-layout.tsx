import { Outlet } from 'react-router'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { FloatingTimerBar } from '@/components/floating-timer-bar'
import { Toaster } from '@/components/ui/sonner'
import { useNotifications } from '@/hooks/use-notifications'

export function RootLayout() {
  useNotifications()

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="flex-1 overflow-y-auto pt-4" style={{ paddingBottom: 'max(1rem, var(--timer-bar-height, 0px))' }}>
          <Outlet />
        </main>
        <FloatingTimerBar />
      </SidebarInset>
      <Toaster position="bottom-right" />
    </SidebarProvider>
  )
}
