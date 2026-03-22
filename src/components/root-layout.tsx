import { Outlet } from 'react-router'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'

export function RootLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {/* AppHeader will be added in Task 10 */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
        {/* FloatingTimerBar will be added in Phase 3 */}
      </SidebarInset>
    </SidebarProvider>
  )
}
