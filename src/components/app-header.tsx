import { Link } from 'react-router'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-6 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="flex items-center gap-4">
        <SidebarTrigger className="-ml-2 text-muted-foreground hover:text-primary" />
        <Separator orientation="vertical" className="h-6" />
        <div className="relative hidden sm:block">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-muted-foreground text-sm">
            search
          </span>
          <input
            type="text"
            placeholder="QUERY_SYSTEM..."
            className="bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-xs font-headline uppercase tracking-widest pl-10 pr-4 py-2 w-64 text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button className="p-2 text-muted-foreground hover:text-primary hover:bg-accent transition-colors">
          <span className="material-symbols-outlined">notifications</span>
        </button>
        <Link
          to="/settings"
          className="p-2 text-muted-foreground hover:text-primary hover:bg-accent transition-colors"
        >
          <span className="material-symbols-outlined">settings</span>
        </Link>
        <div className="h-8 w-8 bg-accent border border-border flex items-center justify-center">
          <span className="text-[10px] font-bold text-primary">USR</span>
        </div>
      </div>
    </header>
  )
}
