import { Outlet } from 'react-router'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { FloatingTimerBar } from '@/components/floating-timer-bar'
import { useNotifications } from '@/hooks/use-notifications'

export function RootLayout() {
  useNotifications()

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="flex-1 overflow-y-auto py-4">
          <Outlet />
        </main>
        <FloatingTimerBar />
      </SidebarInset>
    </SidebarProvider>
  )
}
