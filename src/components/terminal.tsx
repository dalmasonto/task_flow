import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { db } from '@/db/database'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { logActivity } from '@/hooks/use-activity-log'
import { addNotification } from '@/hooks/use-app-notifications'
import { getStatusLabel } from '@/lib/status'
import { formatDuration } from '@/lib/time'
import { computeSessionDuration } from '@/lib/time'
import { playSuccess, playClick, playError, playTimerStart, playTimerPause, playTaskDone } from '@/lib/sounds'
import { toast } from 'sonner'
import type { TaskStatus, TaskPriority } from '@/types'

interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'success' | 'info'
  text: string
}

const HELP_TEXT = `Available commands:

  tasks [--status <status>] [--project <name>]   List tasks
  projects                                        List projects
  task <id>                                       Show task details

  create task "<title>" [flags]                   Create a task
    --project <id>      Assign to project (use ID from "projects" command)
    --priority <level>  low|medium|high|critical
    --status <status>   not_started|in_progress|paused|blocked
    --desc "<text>"     Description

  create project "<name>" [flags]                 Create a project
    --color <hex>       Accent color (e.g. #de8eff)
    --type <type>       active_project|project_idea
    --desc "<text>"     Description

  start <id>                                      Start timer on task
  pause <id>                                      Pause timer on task
  stop <id> [--done|--partial]                    Stop timer
  status <id> <new_status>                        Change task status
  delete task <id>                                Delete a task
  delete project <id>                             Delete a project
  link <task_id> --project <name|id>              Link task to project
  unlink <task_id>                                Unlink task from project

  clear                                           Clear terminal
  help                                            Show this help
  nav <path>                                      Navigate to page`

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true'
      flags[key] = val
      if (val !== 'true') i++
    }
  }
  return flags
}

function parseQuoted(input: string): { quoted: string; rest: string } {
  const match = input.match(/"([^"]*)"/)
  if (match) {
    return { quoted: match[1], rest: input.replace(match[0], '').trim() }
  }
  return { quoted: '', rest: input }
}

export function Terminal({ onClose }: { onClose?: () => void }) {
  const [lines, setLines] = useState<TerminalLine[]>([
    { type: 'info', text: 'TaskFlow Terminal v1.0 — Type "help" for commands' },
  ])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const tasks = useTasks()
  const projects = useProjects()
  const tasksRef = useRef(tasks)
  const projectsRef = useRef(projects)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => { projectsRef.current = projects }, [projects])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [lines])

  const addLine = useCallback((type: TerminalLine['type'], text: string) => {
    setLines(prev => [...prev, { type, text }])
  }, [])

  const execute = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return

    addLine('input', `> ${trimmed}`)
    setHistory(prev => [...prev, trimmed])
    setHistoryIndex(-1)

    const { quoted, rest } = parseQuoted(trimmed)
    const parts = rest.split(/\s+/).filter(Boolean)
    const command = parts[0]?.toLowerCase()
    const args = parts.slice(1)
    const flags = parseFlags(args)

    try {
      switch (command) {
        case 'help': {
          addLine('info', HELP_TEXT)
          break
        }

        case 'clear': {
          setLines([{ type: 'info', text: 'Terminal cleared' }])
          break
        }

        case 'nav': {
          const path = args[0] || '/dashboard'
          navigate(path.startsWith('/') ? path : `/${path}`)
          addLine('success', `Navigating to ${path}`)
          onClose?.()
          break
        }

        case 'tasks': {
          if (!tasksRef.current?.length) { addLine('info', 'No tasks found'); break }
          let filtered = [...tasksRef.current]
          if (flags.status) {
            filtered = filtered.filter(t => t.status === flags.status)
          }
          if (flags.project) {
            const proj = projectsRef.current?.find(p => String(p.id) === flags.project || p.name.toLowerCase() === flags.project.toLowerCase())
            if (proj) filtered = filtered.filter(t => t.projectId === proj.id)
            else { addLine('error', `Project "${flags.project}" not found`); break }
          }
          if (filtered.length === 0) { addLine('info', 'No matching tasks'); break }
          const header = `  ${'ID'.padEnd(6)} ${'Status'.padEnd(14)} ${'Priority'.padEnd(10)} Title`
          addLine('info', header)
          addLine('info', '  ' + '─'.repeat(60))
          filtered.forEach(t => {
            addLine('output', `  #${String(t.id).padEnd(5)} ${getStatusLabel(t.status).padEnd(14)} ${t.priority.padEnd(10)} ${t.title}`)
          })
          break
        }

        case 'projects': {
          if (!projectsRef.current?.length) { addLine('info', 'No projects found'); break }
          const header = `  ${'ID'.padEnd(6)} ${'Type'.padEnd(18)} Name`
          addLine('info', header)
          addLine('info', '  ' + '─'.repeat(50))
          projectsRef.current.forEach(p => {
            addLine('output', `  #${String(p.id).padEnd(5)} ${p.type.padEnd(18)} ${p.name}`)
          })
          break
        }

        case 'task': {
          const id = Number(args[0])
          if (!id) { addLine('error', 'Usage: task <id>'); break }
          const t = await db.tasks.get(id)
          if (!t) { addLine('error', `Task #${id} not found`); break }
          const sessions = await db.sessions.where('taskId').equals(id).toArray()
          const totalMs = sessions.reduce((s, sess) => s + computeSessionDuration(sess), 0)
          const proj = t.projectId ? await db.projects.get(t.projectId) : null
          addLine('info', `  Task #${t.id}: ${t.title}`)
          addLine('output', `  Status:     ${getStatusLabel(t.status)}`)
          addLine('output', `  Priority:   ${t.priority}`)
          addLine('output', `  Project:    ${proj?.name ?? 'Unassigned'}`)
          addLine('output', `  Time:       ${formatDuration(totalMs)}`)
          addLine('output', `  Sessions:   ${sessions.length}`)
          if (t.description) addLine('output', `  Desc:       ${t.description.slice(0, 80)}${t.description.length > 80 ? '...' : ''}`)
          if (t.tags?.length) addLine('output', `  Tags:       ${t.tags.join(', ')}`)
          break
        }

        case 'create': {
          const entity = args[0]?.toLowerCase()
          if (entity === 'task') {
            if (!quoted) { addLine('error', 'Usage: create task "title" [--project name] [--priority level] [--desc "text"]'); break }
            const priority = (flags.priority as TaskPriority) || 'medium'
            const status = (flags.status as TaskStatus) || 'not_started'
            let projectId: number | undefined
            if (flags.project) {
              const proj = projectsRef.current?.find(p => String(p.id) === flags.project || p.name.toLowerCase() === flags.project.toLowerCase())
              if (proj) projectId = proj.id
              else { addLine('error', `Project "${flags.project}" not found`); break }
            }
            const id = await db.tasks.add({
              title: quoted,
              status,
              priority,
              projectId,
              dependencies: [],
              description: flags.desc,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            playSuccess()
            toast.success(`Task created: ${quoted}`)
            addNotification('Task Created', quoted, 'success')
            logActivity('task_created', `Created: ${quoted}`, { entityType: 'task', entityId: id as number })
            addLine('success', `Task #${id} created: ${quoted}`)
            break
          }
          if (entity === 'project') {
            if (!quoted) { addLine('error', 'Usage: create project "name" [--color #hex] [--type active_project|project_idea] [--desc "text"]'); break }
            const id = await db.projects.add({
              name: quoted,
              color: flags.color || '#de8eff',
              type: (flags.type as 'active_project' | 'project_idea') || 'active_project',
              description: flags.desc,
              createdAt: new Date(),
            })
            playSuccess()
            toast.success(`Project created: ${quoted}`)
            addNotification('Project Created', quoted, 'success')
            logActivity('project_created', `Created: ${quoted}`, { entityType: 'project', entityId: id as number })
            addLine('success', `Project #${id} created: ${quoted}`)
            break
          }
          addLine('error', 'Usage: create task|project "name" [flags]')
          break
        }

        case 'start': {
          const id = Number(args[0])
          if (!id) { addLine('error', 'Usage: start <task_id>'); break }
          const t = await db.tasks.get(id)
          if (!t) { addLine('error', `Task #${id} not found`); break }
          const existing = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (existing) { addLine('info', `Task #${id} already has an active session`); break }
          await db.sessions.add({ taskId: id, start: new Date() })
          if (t.status !== 'in_progress') {
            await db.tasks.update(id, { status: 'in_progress', updatedAt: new Date() })
          }
          playTimerStart()
          toast.success(`Timer started: ${t.title}`)
          logActivity('timer_started', `Started: ${t.title}`, { entityType: 'task', entityId: id })
          addLine('success', `Timer started for task #${id}: ${t.title}`)
          break
        }

        case 'pause': {
          const id = Number(args[0])
          if (!id) { addLine('error', 'Usage: pause <task_id>'); break }
          const t = await db.tasks.get(id)
          if (!t) { addLine('error', `Task #${id} not found`); break }
          const session = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (!session) { addLine('info', `Task #${id} has no active session`); break }
          await db.sessions.update(session.id!, { end: new Date() })
          await db.tasks.update(id, { status: 'paused', updatedAt: new Date() })
          playTimerPause()
          toast.info(`Timer paused: ${t.title}`)
          logActivity('timer_paused', `Paused: ${t.title}`, { entityType: 'task', entityId: id })
          addLine('success', `Timer paused for task #${id}: ${t.title}`)
          break
        }

        case 'stop': {
          const id = Number(args[0])
          if (!id) { addLine('error', 'Usage: stop <task_id> [--done|--partial]'); break }
          const t = await db.tasks.get(id)
          if (!t) { addLine('error', `Task #${id} not found`); break }
          const session = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (session) await db.sessions.update(session.id!, { end: new Date() })
          const finalStatus = flags.partial ? 'partial_done' : 'done'
          await db.tasks.update(id, { status: finalStatus as TaskStatus, updatedAt: new Date() })
          playTaskDone()
          toast.success(`Task ${finalStatus === 'done' ? 'completed' : 'partial done'}: ${t.title}`)
          logActivity(finalStatus === 'done' ? 'task_completed' : 'task_partial_done', `${t.title}`, { entityType: 'task', entityId: id })
          addLine('success', `Task #${id} marked ${finalStatus.replace('_', ' ')}: ${t.title}`)
          break
        }

        case 'status': {
          const id = Number(args[0])
          const newStatus = args[1] as TaskStatus
          if (!id || !newStatus) { addLine('error', 'Usage: status <task_id> <new_status>'); break }
          const t = await db.tasks.get(id)
          if (!t) { addLine('error', `Task #${id} not found`); break }
          // Handle session lifecycle
          if (newStatus === 'in_progress') {
            const existing = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
            if (!existing) await db.sessions.add({ taskId: id, start: new Date() })
          } else if (newStatus === 'done' || newStatus === 'partial_done') {
            const active = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
            if (active) await db.sessions.update(active.id!, { end: new Date() })
          }
          await db.tasks.update(id, { status: newStatus, updatedAt: new Date() })
          playClick()
          toast(`Task #${id} → ${newStatus.replace(/_/g, ' ')}`)
          logActivity('task_status_changed', `${t.title} → ${newStatus.replace(/_/g, ' ')}`, { entityType: 'task', entityId: id })
          addLine('success', `Task #${id} status → ${newStatus}`)
          break
        }

        case 'delete': {
          const entity = args[0]?.toLowerCase()
          const id = Number(args[1])
          if (!id) { addLine('error', 'Usage: delete task|project <id>'); break }
          if (entity === 'task') {
            const t = await db.tasks.get(id)
            if (!t) { addLine('error', `Task #${id} not found`); break }
            await db.sessions.where('taskId').equals(id).delete()
            await db.tasks.delete(id)
            playClick()
            toast.success(`Deleted: ${t.title}`)
            logActivity('task_deleted', `Deleted: ${t.title}`, { entityType: 'task' })
            addLine('success', `Task #${id} deleted: ${t.title}`)
          } else if (entity === 'project') {
            const p = await db.projects.get(id)
            if (!p) { addLine('error', `Project #${id} not found`); break }
            await db.projects.delete(id)
            playClick()
            logActivity('project_deleted', `Deleted: ${p.name}`, { entityType: 'project' })
            addLine('success', `Project #${id} deleted: ${p.name}`)
          } else {
            addLine('error', 'Usage: delete task|project <id>')
          }
          break
        }

        case 'link': {
          const taskId = Number(args[0])
          if (!taskId || !flags.project) { addLine('error', 'Usage: link <task_id> --project <name|id>'); break }
          const t = await db.tasks.get(taskId)
          if (!t) { addLine('error', `Task #${taskId} not found`); break }
          const proj = projectsRef.current?.find(p => String(p.id) === flags.project || p.name.toLowerCase() === flags.project.toLowerCase())
          if (!proj) { addLine('error', `Project "${flags.project}" not found`); break }
          await db.tasks.update(taskId, { projectId: proj.id, updatedAt: new Date() })
          logActivity('task_linked', `Linked task #${taskId} to ${proj.name}`, { entityType: 'task', entityId: taskId })
          addLine('success', `Task #${taskId} linked to project: ${proj.name}`)
          break
        }

        case 'unlink': {
          const taskId = Number(args[0])
          if (!taskId) { addLine('error', 'Usage: unlink <task_id>'); break }
          const t = await db.tasks.get(taskId)
          if (!t) { addLine('error', `Task #${taskId} not found`); break }
          await db.tasks.update(taskId, { projectId: undefined, updatedAt: new Date() })
          logActivity('task_unlinked', `Unlinked task #${taskId}`, { entityType: 'task', entityId: taskId })
          addLine('success', `Task #${taskId} unlinked from project`)
          break
        }

        default:
          playError()
          addLine('error', `Unknown command: "${command}". Type "help" for available commands.`)
      }
    } catch (err) {
      playError()
      addLine('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
    }

    setInput('')
  }, [addLine, navigate, onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      execute(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIndex)
      setInput(history[newIndex])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === -1) return
      const newIndex = historyIndex + 1
      if (newIndex >= history.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(newIndex)
        setInput(history[newIndex])
      }
    } else if (e.key === 'Escape') {
      onClose?.()
    }
  }

  const lineColor = (type: TerminalLine['type']) => {
    switch (type) {
      case 'input': return 'text-secondary'
      case 'output': return 'text-foreground'
      case 'error': return 'text-destructive'
      case 'success': return 'text-tertiary'
      case 'info': return 'text-muted-foreground'
    }
  }

  return (
    <div
      className="flex flex-col h-full bg-background font-mono text-sm select-text"
      onClick={() => {
        // Only focus input if user isn't selecting text
        if (!window.getSelection()?.toString()) {
          inputRef.current?.focus()
        }
      }}
    >
      {/* Output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
        {lines.map((line, i) => (
          <pre key={i} className={`${lineColor(line.type)} whitespace-pre-wrap break-words`}>
            {line.text}
          </pre>
        ))}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-card/50">
        <span className="text-secondary font-bold shrink-0">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent border-0 focus:ring-0 text-sm font-mono text-foreground p-0 placeholder:text-muted-foreground/30"
          placeholder='Type a command... (try "help")'
          autoFocus
        />
      </div>
    </div>
  )
}
