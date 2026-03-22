import { useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { db } from '@/db/database'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { logActivity } from '@/hooks/use-activity-log'
import { addNotification } from '@/hooks/use-app-notifications'
import { getStatusLabel } from '@/lib/status'
import { formatDuration, computeSessionDuration } from '@/lib/time'
import { playSuccess, playClick, playError, playTimerStart, playTimerPause, playTaskDone } from '@/lib/sounds'
import { toast } from 'sonner'
import type { TaskStatus, TaskPriority } from '@/types'

// ANSI color helpers
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgCyan: '\x1b[46m',
  bgMagenta: '\x1b[45m',
}

const COMMANDS = [
  'tasks', 'projects', 'task', 'create', 'start', 'pause', 'stop',
  'status', 'delete', 'link', 'unlink', 'clear', 'help', 'nav',
]

const STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done']
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'critical']

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
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputBuffer = useRef('')
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const navigate = useNavigate()

  const tasks = useTasks()
  const projects = useProjects()
  const tasksRef = useRef(tasks)
  const projectsRef = useRef(projects)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => { projectsRef.current = projects }, [projects])

  const writeln = useCallback((text: string) => {
    termRef.current?.writeln(text)
  }, [])

  const prompt = useCallback(() => {
    termRef.current?.write(`\r\n${C.cyan}${C.bold}> ${C.reset}`)
  }, [])

  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) { prompt(); return }

    historyRef.current.push(trimmed)
    historyIndexRef.current = -1

    const { quoted, rest } = parseQuoted(trimmed)
    const parts = rest.split(/\s+/).filter(Boolean)
    const command = parts[0]?.toLowerCase()
    const args = parts.slice(1)
    const flags = parseFlags(args)
    const tasks = tasksRef.current
    const projects = projectsRef.current

    const findProject = (val: string) =>
      projects?.find(p => String(p.id) === val || p.name.toLowerCase() === val.toLowerCase())

    try {
      switch (command) {
        case 'help': {
          writeln('')
          writeln(`${C.cyan}${C.bold}Available Commands${C.reset}`)
          writeln(`${C.gray}${'─'.repeat(60)}${C.reset}`)
          writeln(`  ${C.green}tasks${C.reset} ${C.gray}[--status <s>] [--project <id>]${C.reset}  List tasks`)
          writeln(`  ${C.green}projects${C.reset}                                List projects`)
          writeln(`  ${C.green}task${C.reset} ${C.white}<id>${C.reset}                              Show task details`)
          writeln('')
          writeln(`  ${C.green}create task${C.reset} ${C.white}"<title>"${C.reset} ${C.gray}[flags]${C.reset}       Create a task`)
          writeln(`    ${C.gray}--project <id>  --priority <level>  --status <status>  --desc "<text>"${C.reset}`)
          writeln(`  ${C.green}create project${C.reset} ${C.white}"<name>"${C.reset} ${C.gray}[flags]${C.reset}    Create a project`)
          writeln(`    ${C.gray}--color <hex>  --type active_project|project_idea  --desc "<text>"${C.reset}`)
          writeln('')
          writeln(`  ${C.green}start${C.reset} ${C.white}<id>${C.reset}     Start timer      ${C.green}pause${C.reset} ${C.white}<id>${C.reset}     Pause timer`)
          writeln(`  ${C.green}stop${C.reset} ${C.white}<id>${C.reset} ${C.gray}[--done|--partial]${C.reset}        Stop & set status`)
          writeln(`  ${C.green}status${C.reset} ${C.white}<id> <new_status>${C.reset}              Change task status`)
          writeln('')
          writeln(`  ${C.green}delete${C.reset} ${C.white}task|project <id>${C.reset}              Delete entity`)
          writeln(`  ${C.green}link${C.reset} ${C.white}<task_id>${C.reset} ${C.gray}--project <id>${C.reset}        Link task to project`)
          writeln(`  ${C.green}unlink${C.reset} ${C.white}<task_id>${C.reset}                      Unlink from project`)
          writeln('')
          writeln(`  ${C.green}nav${C.reset} ${C.white}<path>${C.reset}                            Navigate (e.g. /analytics)`)
          writeln(`  ${C.green}clear${C.reset}                                  Clear terminal`)
          writeln(`  ${C.green}help${C.reset}                                   This help`)
          writeln('')
          writeln(`${C.gray}Statuses: ${STATUSES.join(', ')}${C.reset}`)
          writeln(`${C.gray}Priorities: ${PRIORITIES.join(', ')}${C.reset}`)
          break
        }

        case 'clear': {
          termRef.current?.clear()
          break
        }

        case 'nav': {
          const path = args[0] || '/dashboard'
          navigate(path.startsWith('/') ? path : `/${path}`)
          writeln(`${C.green}Navigating to ${path}${C.reset}`)
          onClose?.()
          break
        }

        case 'tasks': {
          if (!tasks?.length) { writeln(`${C.gray}No tasks found${C.reset}`); break }
          let filtered = [...tasks]
          if (flags.status) filtered = filtered.filter(t => t.status === flags.status)
          if (flags.project) {
            const proj = findProject(flags.project)
            if (proj) filtered = filtered.filter(t => t.projectId === proj.id)
            else { writeln(`${C.red}Project "${flags.project}" not found${C.reset}`); break }
          }
          if (filtered.length === 0) { writeln(`${C.gray}No matching tasks${C.reset}`); break }
          writeln('')
          writeln(`  ${C.bold}${C.white}${'ID'.padEnd(6)} ${'Status'.padEnd(14)} ${'Priority'.padEnd(10)} Title${C.reset}`)
          writeln(`  ${C.gray}${'─'.repeat(60)}${C.reset}`)
          filtered.forEach(t => {
            const statusColor = t.status === 'done' ? C.green : t.status === 'in_progress' ? C.cyan : t.status === 'blocked' ? C.red : C.gray
            writeln(`  ${C.cyan}#${String(t.id).padEnd(5)}${C.reset} ${statusColor}${getStatusLabel(t.status).padEnd(14)}${C.reset} ${C.magenta}${t.priority.padEnd(10)}${C.reset} ${t.title}`)
          })
          writeln(`${C.gray}  ${filtered.length} task(s)${C.reset}`)
          break
        }

        case 'projects': {
          if (!projects?.length) { writeln(`${C.gray}No projects found${C.reset}`); break }
          writeln('')
          writeln(`  ${C.bold}${C.white}${'ID'.padEnd(6)} ${'Type'.padEnd(18)} Name${C.reset}`)
          writeln(`  ${C.gray}${'─'.repeat(50)}${C.reset}`)
          projects.forEach(p => {
            const typeColor = p.type === 'active_project' ? C.cyan : C.magenta
            writeln(`  ${C.cyan}#${String(p.id).padEnd(5)}${C.reset} ${typeColor}${p.type.padEnd(18)}${C.reset} ${p.name}`)
          })
          break
        }

        case 'task': {
          const id = Number(args[0])
          if (!id) { writeln(`${C.red}Usage: task <id>${C.reset}`); break }
          const t = await db.tasks.get(id)
          if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
          const sessions = await db.sessions.where('taskId').equals(id).toArray()
          const totalMs = sessions.reduce((s, sess) => s + computeSessionDuration(sess), 0)
          const proj = t.projectId ? await db.projects.get(t.projectId) : null
          const activeSess = sessions.find(s => !s.end)
          writeln('')
          writeln(`  ${C.bold}${C.cyan}Task #${t.id}${C.reset} ${C.bold}${t.title}${C.reset}`)
          writeln(`  ${C.gray}${'─'.repeat(50)}${C.reset}`)
          const statusColor = t.status === 'done' ? C.green : t.status === 'in_progress' ? C.cyan : t.status === 'blocked' ? C.red : C.yellow
          writeln(`  ${C.gray}Status:${C.reset}     ${statusColor}${getStatusLabel(t.status)}${C.reset}${activeSess ? ` ${C.green}● LIVE${C.reset}` : ''}`)
          writeln(`  ${C.gray}Priority:${C.reset}   ${C.magenta}${t.priority}${C.reset}`)
          writeln(`  ${C.gray}Project:${C.reset}    ${proj ? `${proj.name}` : `${C.gray}Unassigned${C.reset}`}`)
          writeln(`  ${C.gray}Time:${C.reset}       ${C.cyan}${formatDuration(totalMs)}${C.reset}`)
          writeln(`  ${C.gray}Sessions:${C.reset}   ${sessions.length}`)
          if (t.description) writeln(`  ${C.gray}Desc:${C.reset}       ${t.description.slice(0, 80)}${t.description.length > 80 ? '...' : ''}`)
          if (t.tags?.length) writeln(`  ${C.gray}Tags:${C.reset}       ${t.tags.join(', ')}`)
          if (t.dependencies.length) writeln(`  ${C.gray}Deps:${C.reset}       ${t.dependencies.map(d => `#${d}`).join(', ')}`)
          break
        }

        case 'create': {
          const entity = args[0]?.toLowerCase()
          if (entity === 'task') {
            if (!quoted) { writeln(`${C.red}Usage: create task "title" [--project id] [--priority level]${C.reset}`); break }
            const priority = (flags.priority as TaskPriority) || 'medium'
            const status = (flags.status as TaskStatus) || 'not_started'
            let projectId: number | undefined
            if (flags.project) {
              const proj = findProject(flags.project)
              if (proj) projectId = proj.id
              else { writeln(`${C.red}Project "${flags.project}" not found${C.reset}`); break }
            }
            const id = await db.tasks.add({
              title: quoted, status, priority, projectId, dependencies: [],
              description: flags.desc, createdAt: new Date(), updatedAt: new Date(),
            })
            playSuccess()
            toast.success(`Task created: ${quoted}`)
            addNotification('Task Created', quoted, 'success')
            logActivity('task_created', `Created: ${quoted}`, { entityType: 'task', entityId: id as number })
            writeln(`${C.green}✓ Task #${id} created: ${quoted}${C.reset}`)
            break
          }
          if (entity === 'project') {
            if (!quoted) { writeln(`${C.red}Usage: create project "name" [--color #hex] [--type active_project|project_idea]${C.reset}`); break }
            const id = await db.projects.add({
              name: quoted, color: flags.color || '#de8eff',
              type: (flags.type as 'active_project' | 'project_idea') || 'active_project',
              description: flags.desc, createdAt: new Date(),
            })
            playSuccess()
            toast.success(`Project created: ${quoted}`)
            addNotification('Project Created', quoted, 'success')
            logActivity('project_created', `Created: ${quoted}`, { entityType: 'project', entityId: id as number })
            writeln(`${C.green}✓ Project #${id} created: ${quoted}${C.reset}`)
            break
          }
          writeln(`${C.red}Usage: create task|project "name" [flags]${C.reset}`)
          break
        }

        case 'start': {
          const id = Number(args[0])
          if (!id) { writeln(`${C.red}Usage: start <task_id>${C.reset}`); break }
          const t = await db.tasks.get(id)
          if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
          const existing = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (existing) { writeln(`${C.yellow}Task #${id} already has an active session${C.reset}`); break }
          await db.sessions.add({ taskId: id, start: new Date() })
          if (t.status !== 'in_progress') await db.tasks.update(id, { status: 'in_progress', updatedAt: new Date() })
          playTimerStart()
          toast.success(`Timer started: ${t.title}`)
          logActivity('timer_started', `Started: ${t.title}`, { entityType: 'task', entityId: id })
          writeln(`${C.green}▶ Timer started for #${id}: ${t.title}${C.reset}`)
          break
        }

        case 'pause': {
          const id = Number(args[0])
          if (!id) { writeln(`${C.red}Usage: pause <task_id>${C.reset}`); break }
          const t = await db.tasks.get(id)
          if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
          const session = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (!session) { writeln(`${C.yellow}Task #${id} has no active session${C.reset}`); break }
          await db.sessions.update(session.id!, { end: new Date() })
          await db.tasks.update(id, { status: 'paused', updatedAt: new Date() })
          playTimerPause()
          toast.info(`Timer paused: ${t.title}`)
          logActivity('timer_paused', `Paused: ${t.title}`, { entityType: 'task', entityId: id })
          writeln(`${C.magenta}⏸ Timer paused for #${id}: ${t.title}${C.reset}`)
          break
        }

        case 'stop': {
          const id = Number(args[0])
          if (!id) { writeln(`${C.red}Usage: stop <task_id> [--done|--partial]${C.reset}`); break }
          const t = await db.tasks.get(id)
          if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
          const session = await db.sessions.where('taskId').equals(id).filter(s => !s.end).first()
          if (session) await db.sessions.update(session.id!, { end: new Date() })
          const finalStatus = flags.partial ? 'partial_done' : 'done'
          await db.tasks.update(id, { status: finalStatus as TaskStatus, updatedAt: new Date() })
          playTaskDone()
          toast.success(`Task ${finalStatus === 'done' ? 'completed' : 'partial done'}: ${t.title}`)
          logActivity(finalStatus === 'done' ? 'task_completed' : 'task_partial_done', t.title, { entityType: 'task', entityId: id })
          writeln(`${C.green}■ Task #${id} → ${finalStatus.replace('_', ' ')}: ${t.title}${C.reset}`)
          break
        }

        case 'status': {
          const id = Number(args[0])
          const newStatus = args[1] as TaskStatus
          if (!id || !newStatus) { writeln(`${C.red}Usage: status <task_id> <new_status>${C.reset}`); break }
          if (!STATUSES.includes(newStatus)) { writeln(`${C.red}Invalid status. Options: ${STATUSES.join(', ')}${C.reset}`); break }
          const t = await db.tasks.get(id)
          if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
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
          writeln(`${C.green}✓ Task #${id} → ${newStatus}${C.reset}`)
          break
        }

        case 'delete': {
          const entity = args[0]?.toLowerCase()
          const id = Number(args[1])
          if (!id) { writeln(`${C.red}Usage: delete task|project <id>${C.reset}`); break }
          if (entity === 'task') {
            const t = await db.tasks.get(id)
            if (!t) { writeln(`${C.red}Task #${id} not found${C.reset}`); break }
            await db.sessions.where('taskId').equals(id).delete()
            await db.tasks.delete(id)
            playClick()
            toast.success(`Deleted: ${t.title}`)
            logActivity('task_deleted', `Deleted: ${t.title}`, { entityType: 'task' })
            writeln(`${C.red}✗ Task #${id} deleted: ${t.title}${C.reset}`)
          } else if (entity === 'project') {
            const p = await db.projects.get(id)
            if (!p) { writeln(`${C.red}Project #${id} not found${C.reset}`); break }
            await db.projects.delete(id)
            playClick()
            logActivity('project_deleted', `Deleted: ${p.name}`, { entityType: 'project' })
            writeln(`${C.red}✗ Project #${id} deleted: ${p.name}${C.reset}`)
          } else {
            writeln(`${C.red}Usage: delete task|project <id>${C.reset}`)
          }
          break
        }

        case 'link': {
          const taskId = Number(args[0])
          if (!taskId || !flags.project) { writeln(`${C.red}Usage: link <task_id> --project <id>${C.reset}`); break }
          const t = await db.tasks.get(taskId)
          if (!t) { writeln(`${C.red}Task #${taskId} not found${C.reset}`); break }
          const proj = findProject(flags.project)
          if (!proj) { writeln(`${C.red}Project "${flags.project}" not found${C.reset}`); break }
          await db.tasks.update(taskId, { projectId: proj.id, updatedAt: new Date() })
          logActivity('task_linked', `Linked #${taskId} to ${proj.name}`, { entityType: 'task', entityId: taskId })
          writeln(`${C.green}✓ Task #${taskId} linked to ${proj.name}${C.reset}`)
          break
        }

        case 'unlink': {
          const taskId = Number(args[0])
          if (!taskId) { writeln(`${C.red}Usage: unlink <task_id>${C.reset}`); break }
          const t = await db.tasks.get(taskId)
          if (!t) { writeln(`${C.red}Task #${taskId} not found${C.reset}`); break }
          await db.tasks.update(taskId, { projectId: undefined, updatedAt: new Date() })
          logActivity('task_unlinked', `Unlinked #${taskId}`, { entityType: 'task', entityId: taskId })
          writeln(`${C.green}✓ Task #${taskId} unlinked${C.reset}`)
          break
        }

        default:
          playError()
          writeln(`${C.red}Unknown command: "${command}". Type ${C.bold}help${C.reset}${C.red} for commands.${C.reset}`)
      }
    } catch (err) {
      playError()
      writeln(`${C.red}Error: ${err instanceof Error ? err.message : String(err)}${C.reset}`)
    }

    prompt()
  }, [writeln, prompt, navigate, onClose])

  // Autocomplete logic
  const autocomplete = useCallback((partial: string): string | null => {
    const parts = partial.split(/\s+/)
    const current = parts[parts.length - 1]

    // First word — command autocomplete
    if (parts.length === 1) {
      const matches = COMMANDS.filter(c => c.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
      if (matches.length > 1) {
        writeln('')
        writeln(`${C.gray}${matches.join('  ')}${C.reset}`)
        return null
      }
    }

    // Second word after 'nav' — route paths
    if (parts.length === 2 && parts[0] === 'nav') {
      const routes = [
        '/dashboard', '/projects', '/projects/new',
        '/tasks/new', '/tasks/bulk',
        '/analytics', '/analytics/timeline',
        '/activity', '/dependencies', '/archive', '/settings',
      ]
      const matches = routes.filter(r => r.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0]
      if (matches.length > 1) {
        writeln('')
        writeln(`${C.gray}${matches.join('  ')}${C.reset}`)
        return null
      }
    }

    // Second word after 'create' — entity type
    if (parts.length === 2 && parts[0] === 'create') {
      const opts = ['task', 'project']
      const matches = opts.filter(o => o.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
    }

    // Second word after 'delete' — entity type
    if (parts.length === 2 && parts[0] === 'delete') {
      const opts = ['task', 'project']
      const matches = opts.filter(o => o.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
    }

    // After --status flag — status values
    if (parts.length >= 2 && parts[parts.length - 2] === '--status') {
      const matches = STATUSES.filter(s => s.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
      if (matches.length > 1) {
        writeln('')
        writeln(`${C.gray}${matches.join('  ')}${C.reset}`)
        return null
      }
    }

    // After --priority flag — priority values
    if (parts.length >= 2 && parts[parts.length - 2] === '--priority') {
      const matches = PRIORITIES.filter(p => p.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
    }

    // After --type flag — project types
    if (parts.length >= 2 && parts[parts.length - 2] === '--type') {
      const opts = ['active_project', 'project_idea']
      const matches = opts.filter(o => o.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
    }

    // Status command second arg — status values
    if (parts.length === 3 && parts[0] === 'status') {
      const matches = STATUSES.filter(s => s.startsWith(current.toLowerCase()))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + matches[0] + ' '
      if (matches.length > 1) {
        writeln('')
        writeln(`${C.gray}${matches.join('  ')}${C.reset}`)
        return null
      }
    }

    // Flag name autocomplete
    if (current.startsWith('--')) {
      const flagPart = current.slice(2)
      const allFlags = ['project', 'priority', 'status', 'desc', 'color', 'type', 'done', 'partial']
      const matches = allFlags.filter(f => f.startsWith(flagPart))
      if (matches.length === 1) return partial.slice(0, partial.length - current.length) + '--' + matches[0] + ' '
      if (matches.length > 1) {
        writeln('')
        writeln(`${C.gray}${matches.map(m => '--' + m).join('  ')}${C.reset}`)
        return null
      }
    }

    return null
  }, [writeln])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#0e0e0e',
        foreground: '#ffffff',
        cursor: '#00fbfb',
        cursorAccent: '#0e0e0e',
        selectionBackground: '#de8eff40',
        selectionForeground: '#ffffff',
        black: '#0e0e0e',
        red: '#ff6e84',
        green: '#69fd5d',
        yellow: '#ffeb3b',
        blue: '#de8eff',
        magenta: '#de8eff',
        cyan: '#00fbfb',
        white: '#ffffff',
        brightBlack: '#484847',
        brightRed: '#ff6e84',
        brightGreen: '#69fd5d',
        brightYellow: '#ffeb3b',
        brightBlue: '#de8eff',
        brightMagenta: '#b90afc',
        brightCyan: '#00fbfb',
        brightWhite: '#ffffff',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Welcome
    term.writeln(`${C.cyan}${C.bold}TaskFlow Terminal v2.0${C.reset} ${C.gray}— Type "help" for commands, Tab for autocomplete${C.reset}`)
    term.write(`\r\n${C.cyan}${C.bold}> ${C.reset}`)

    // Input handling
    term.onData((data) => {
      const code = data.charCodeAt(0)

      if (data === '\r') {
        // Enter
        term.writeln('')
        const cmd = inputBuffer.current
        inputBuffer.current = ''
        executeCommand(cmd)
      } else if (code === 127 || data === '\b') {
        // Backspace
        if (inputBuffer.current.length > 0) {
          inputBuffer.current = inputBuffer.current.slice(0, -1)
          term.write('\b \b')
        }
      } else if (data === '\t') {
        // Tab — autocomplete
        const result = autocomplete(inputBuffer.current)
        if (result !== null) {
          // Clear current line and rewrite
          const clearLen = inputBuffer.current.length
          term.write('\b \b'.repeat(clearLen))
          inputBuffer.current = result
          term.write(result)
        }
      } else if (data === '\x1b[A') {
        // Arrow up — history
        if (historyRef.current.length === 0) return
        const newIdx = historyIndexRef.current === -1
          ? historyRef.current.length - 1
          : Math.max(0, historyIndexRef.current - 1)
        historyIndexRef.current = newIdx
        const clearLen = inputBuffer.current.length
        term.write('\b \b'.repeat(clearLen))
        const cmd = historyRef.current[newIdx]
        inputBuffer.current = cmd
        term.write(cmd)
      } else if (data === '\x1b[B') {
        // Arrow down — history
        if (historyIndexRef.current === -1) return
        const clearLen = inputBuffer.current.length
        term.write('\b \b'.repeat(clearLen))
        const newIdx = historyIndexRef.current + 1
        if (newIdx >= historyRef.current.length) {
          historyIndexRef.current = -1
          inputBuffer.current = ''
        } else {
          historyIndexRef.current = newIdx
          const cmd = historyRef.current[newIdx]
          inputBuffer.current = cmd
          term.write(cmd)
        }
      } else if (data === '\x1b') {
        // Escape
        onClose?.()
      } else if (code >= 32) {
        // Printable character
        inputBuffer.current += data
        term.write(data)
      }
    })

    // Resize handler
    const observer = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [executeCommand, autocomplete, prompt, onClose])

  return <div ref={containerRef} className="h-full w-full" />
}
