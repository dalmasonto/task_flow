import { useState, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { db } from '@/db/database'
import type { Task, Project } from '@/types'
import { getStatusColor } from '@/lib/status'

export function AppHeader() {
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState<{ tasks: Task[]; projects: Project[] }>({ tasks: [], projects: [] })
  const [isOpen, setIsOpen] = useState(false)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

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
    // Small delay so clicks on results fire first
    setTimeout(() => setIsOpen(false), 150)
  }

  const handleSelect = (path: string) => {
    setIsOpen(false)
    setSearchQuery('')
    setResults({ tasks: [], projects: [] })
    navigate(path)
  }

  const hasResults = results.tasks.length > 0 || results.projects.length > 0

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
