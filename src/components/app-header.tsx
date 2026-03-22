import { useState, useRef, useCallback, useEffect } from 'react'
import { Link, useNavigate } from 'react-router'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Terminal } from '@/components/terminal'
import { db } from '@/db/database'
import { useAppNotifications, useUnreadCount, markAsRead, markAllAsRead, clearAllNotifications } from '@/hooks/use-app-notifications'
import type { Task, Project, NotificationType } from '@/types'
import { getStatusColor } from '@/lib/status'

const TYPE_ICONS: Record<NotificationType, { icon: string; color: string }> = {
  info: { icon: 'info', color: '#00fbfb' },
  success: { icon: 'check_circle', color: '#69fd5d' },
  warning: { icon: 'warning', color: '#de8eff' },
  error: { icon: 'error', color: '#ff6e84' },
}

export function AppHeader() {
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState<{ tasks: Task[]; projects: Project[] }>({ tasks: [], projects: [] })
  const [isOpen, setIsOpen] = useState(false)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const notifications = useAppNotifications(30)
  const unreadCount = useUnreadCount()
  const [terminalOpen, setTerminalOpen] = useState(false)

  // Ctrl+K or backtick to open terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setTerminalOpen(prev => !prev)
      }
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        setTerminalOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const runSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setResults({ tasks: [], projects: [] })
      setIsOpen(false)
      return
    }
    const lower = query.toLowerCase()

    const [tasks, projects] = await Promise.all([
      db.tasks.filter(t => t.title.toLowerCase().includes(lower)).limit(5).toArray(),
      db.projects.filter(p => p.name.toLowerCase().includes(lower)).limit(3).toArray(),
    ])

    setResults({ tasks, projects })
    setIsOpen(tasks.length > 0 || projects.length > 0)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false)
      inputRef.current?.blur()
    }
  }

  const handleBlur = () => {
    setTimeout(() => setIsOpen(false), 150)
  }

  const handleSelect = (path: string) => {
    setIsOpen(false)
    setSearchQuery('')
    setResults({ tasks: [], projects: [] })
    navigate(path)
  }

  const hasResults = results.tasks.length > 0 || results.projects.length > 0

  const formatTimeAgo = (date: Date) => {
    const diff = Date.now() - new Date(date).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

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
            ref={inputRef}
            type="text"
            placeholder="QUERY_SYSTEM..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); void runSearch(e.target.value) }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-xs font-headline uppercase tracking-widest pl-10 pr-4 py-2 w-64 text-foreground placeholder:text-muted-foreground/50"
          />

          {isOpen && hasResults && (
            <div className="absolute top-full left-0 mt-1 w-80 bg-card/95 backdrop-blur-md border border-border z-50 shadow-lg">
              {results.tasks.length > 0 && (
                <div>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-headline tracking-widest text-muted-foreground uppercase">
                    Tasks
                  </div>
                  {results.tasks.map(task => (
                    <button
                      key={task.id}
                      onMouseDown={() => handleSelect(`/tasks/${task.id}`)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                    >
                      <span
                        className="h-2 w-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: getStatusColor(task.status) }}
                      />
                      <span className="text-xs text-foreground truncate flex-1">{task.title}</span>
                      <span className="text-[10px] text-muted-foreground font-mono flex-shrink-0">
                        #{task.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {results.projects.length > 0 && (
                <div>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-headline tracking-widest text-muted-foreground uppercase border-t border-border">
                    Projects
                  </div>
                  {results.projects.map(project => (
                    <button
                      key={project.id}
                      onMouseDown={() => handleSelect(`/projects/${project.id}`)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                    >
                      <span
                        className="h-2 w-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: project.color }}
                      />
                      <span className="text-xs text-foreground truncate">{project.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {/* Terminal */}
        <button
          onClick={() => setTerminalOpen(true)}
          className="p-2 text-muted-foreground hover:text-secondary hover:bg-accent transition-colors"
          title="Open Terminal (Ctrl+K)"
        >
          <span className="material-symbols-outlined">terminal</span>
        </button>

        {/* Notifications Bell */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="p-2 text-muted-foreground hover:text-primary hover:bg-accent transition-colors relative">
              <span className="material-symbols-outlined">notifications</span>
              {typeof unreadCount === 'number' && unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 bg-destructive text-[10px] font-bold text-white flex items-center justify-center">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-96 p-0 max-h-[500px] flex flex-col" align="end">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-bold uppercase tracking-widest">Notifications</span>
              <div className="flex gap-2">
                {(unreadCount ?? 0) > 0 && (
                  <button
                    onClick={() => markAllAsRead()}
                    className="text-[10px] uppercase tracking-widest text-secondary hover:text-secondary/80 font-bold"
                  >
                    Mark all read
                  </button>
                )}
                {(notifications?.length ?? 0) > 0 && (
                  <button
                    onClick={() => clearAllNotifications()}
                    className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-destructive font-bold"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* List */}
            <div className="overflow-y-auto flex-1">
              {!notifications || notifications.length === 0 ? (
                <div className="py-12 text-center">
                  <span className="material-symbols-outlined text-3xl text-muted-foreground/30 mb-2 block">
                    notifications_off
                  </span>
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    No notifications
                  </p>
                </div>
              ) : (
                notifications.map(n => {
                  const config = TYPE_ICONS[n.type]
                  return (
                    <button
                      key={n.id}
                      onClick={() => n.id && !n.read && markAsRead(n.id)}
                      className={`w-full flex items-start gap-3 px-4 py-3 text-left border-b border-border/50 hover:bg-accent transition-colors ${
                        n.read ? 'opacity-50' : ''
                      }`}
                    >
                      <span
                        className="material-symbols-outlined text-sm mt-0.5 shrink-0"
                        style={{ color: config.color }}
                      >
                        {config.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold uppercase tracking-tight truncate">
                            {n.title}
                          </span>
                          <span className="text-[9px] text-muted-foreground tracking-widest shrink-0">
                            {formatTimeAgo(n.createdAt)}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {n.message}
                        </p>
                      </div>
                      {!n.read && (
                        <span className="w-1.5 h-1.5 bg-secondary rounded-full mt-1.5 shrink-0" />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </PopoverContent>
        </Popover>

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

      {/* Terminal Dialog */}
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <DialogContent className="w-[90vw] max-w-4xl sm:max-w-4xl h-[75vh] p-0 gap-0 bg-background border-secondary/30">
          <DialogTitle className="sr-only">TaskFlow Terminal</DialogTitle>
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-secondary text-sm">terminal</span>
              <span className="text-[10px] uppercase tracking-widest font-bold text-secondary">TaskFlow Terminal</span>
            </div>
            <span className="text-[9px] text-muted-foreground tracking-widest">ESC to close · Ctrl+K to toggle</span>
          </div>
          <Terminal onClose={() => setTerminalOpen(false)} />
        </DialogContent>
      </Dialog>
    </header>
  )
}
