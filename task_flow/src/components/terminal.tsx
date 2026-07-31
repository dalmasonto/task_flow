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
import { syncTaskUpdate, syncTaskDelete, syncProjectDelete } from '@/lib/sync-api'
import { handleSessionsForStatusChange } from '@/lib/session-lifecycle'
import { addNotification } from '@/hooks/use-app-notifications'
import { getStatusLabel } from '@/lib/status'
import { formatDuration, computeSessionDuration } from '@/lib/time'
import { playSuccess, playClick, playError, playTimerStart, playTimerPause, playTaskDone } from '@/lib/sounds'
import { useSetting, updateSetting } from '@/hooks/use-settings'
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
  'tasks', 'projects', 'task', 'project', 'create', 'start', 'pause', 'stop',
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
  const historyLoaded = useRef(false)
  const navigate = useNavigate()

  const tasks = useTasks()
  const projects = useProjects()
  const operatorName = useSetting('operatorName')
  const systemName = useSetting('systemName')
  const savedHistory = useSetting('terminalHistory')

  // Load saved history once
  useEffect(() => {
    if (!historyLoaded.current && savedHistory.length > 0) {
      historyRef.current = [...savedHistory]
      historyLoaded.current = true
    }
  }, [savedHistory])
  const operatorRef = useRef(operatorName)
  const systemRef = useRef(systemName)
  useEffect(() => { operatorRef.current = operatorName }, [operatorName])
  useEffect(() => { systemRef.current = systemName }, [systemName])
  const tasksRef = useRef(tasks)
  const projectsRef = useRef(projects)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => { projectsRef.current = projects }, [projects])

  const writeln = useCallback((text: string) => {
    termRef.current?.writeln(text)
  }, [])

  const prompt = useCallback(() => {
    const sys = systemRef.current
    const op = operatorRef.current
    termRef.current?.write(`\r\n${C.cyan}${C.bold}${sys}${C.reset}${C.gray}@${C.reset}${C.green}${op}${C.reset}${C.white}$ ${C.reset}`)
  }, [])

  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) { prompt(); return }

    // Deduplicate: remove existing occurrence, push to end
    historyRef.current = historyRef.current.filter(h => h !== trimmed)
    historyRef.current.push(trimmed)
    // Cap at 100 entries
    if (historyRef.current.length > 100) {
      historyRef.current = historyRef.current.slice(-100)
    }
    historyIndexRef.current = -1
    // Persist to settings
    updateSetting('terminalHistory', [...historyRef.current])

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
          // Helper to align: pad visible text to col width, then description
          const col = 42
          const row = (cmd: string, vis: number, desc: string) => {
            const pad = ' '.repeat(Math.max(1, col - vis))
            return `  ${cmd}${pad}${C.gray}${desc}${C.reset}`
          }
          writeln('')
          writeln(`${C.cyan}${C.bold}  Available Commands${C.reset}`)
          writeln(`  ${C.gray}${'─'.repeat(58)}${C.reset}`)
          writeln('')
          // visible char counts:
          // "tasks [--status <s>] [--project <id>]" = 38
          // "projects"                              = 8
          // "task <id>"                             = 9
          // "create task "<title>" [flags]"         = 29
          // "create project "<name>" [flags]"       = 31
          // "start <id>"                            = 10
          // "pause <id>"                            = 10
          // "stop <id> [--done|--partial]"          = 28
          // "status <id> <new_status>"              = 23
          // "delete task|project <id>"              = 23
          // "link <task_id> --project <id>"         = 28
          // "unlink <task_id>"                      = 15
          // "nav <path>"                            = 10
          // "clear"                                 = 5
          // "help"                                  = 4
          writeln(`  ${C.cyan}${C.bold}Querying${C.reset}`)
          writeln(row(`${C.green}tasks${C.reset} ${C.gray}[--status <s>] [--project <id>]${C.reset}`, 38, 'List tasks'))
          writeln(row(`${C.green}projects${C.reset}`, 8, 'List projects'))
          writeln(row(`${C.green}task${C.reset} ${C.white}<id>${C.reset}`, 9, 'Show task details'))
          writeln(row(`${C.green}project${C.reset} ${C.white}<id>${C.reset}`, 12, 'Show project details'))
          writeln('')
          writeln(`  ${C.cyan}${C.bold}Creating${C.reset}`)
          writeln(row(`${C.green}create task${C.reset} ${C.white}"<title>"${C.reset} ${C.gray}[flags]${C.reset}`, 29, 'Create a task'))
          writeln(`    ${C.gray}Flags: --project <id>  --priority <lvl>  --status <s>  --desc "<text>"${C.reset}`)
          writeln(row(`${C.green}create project${C.reset} ${C.white}"<name>"${C.reset} ${C.gray}[flags]${C.reset}`, 31, 'Create a project'))
          writeln(`    ${C.gray}Flags: --color <hex>  --type <t>  --desc "<text>"${C.reset}`)
          writeln('')
          writeln(`  ${C.cyan}${C.bold}Timer${C.reset}`)
          writeln(row(`${C.green}start${C.reset} ${C.white}<id>${C.reset}`, 10, 'Start timer on task'))
          writeln(row(`${C.green}pause${C.reset} ${C.white}<id>${C.reset}`, 10, 'Pause timer on task'))
          writeln(row(`${C.green}stop${C.reset} ${C.white}<id>${C.reset} ${C.gray}[--done|--partial]${C.reset}`, 28, 'Stop timer & set final status'))
          writeln('')
          writeln(`  ${C.cyan}${C.bold}Managing${C.reset}`)
          writeln(row(`${C.green}status${C.reset} ${C.white}<id> <new_status>${C.reset}`, 23, 'Change task status'))
          writeln(row(`${C.green}delete${C.reset} ${C.white}task|project <id>${C.reset}`, 23, 'Delete entity'))
          writeln(row(`${C.green}link${C.reset} ${C.white}<task_id>${C.reset} ${C.gray}--project <id>${C.reset}`, 28, 'Link task to project'))
          writeln(row(`${C.green}unlink${C.reset} ${C.white}<task_id>${C.reset}`, 15, 'Unlink from project'))
          writeln('')
          writeln(`  ${C.cyan}${C.bold}System${C.reset}`)
          writeln(row(`${C.green}nav${C.reset} ${C.white}<path>${C.reset}`, 10, 'Navigate (Tab for routes)'))
          writeln(row(`${C.green}clear${C.reset}`, 5, 'Clear terminal'))
          writeln(row(`${C.green}help${C.reset}`, 4, 'Show this help'))
          writeln('')
          writeln(`  ${C.gray}Statuses:   ${C.white}${STATUSES.join(`${C.gray}, ${C.white}`)}${C.reset}`)
          writeln(`  ${C.gray}Priorities: ${C.white}${PRIORITIES.join(`${C.gray}, ${C.white}`)}${C.reset}`)
          writeln(`  ${C.gray}Tab${C.reset} for autocomplete  ${C.gray}↑↓${C.reset} for history  ${C.gray}Esc${C.reset} to close`)
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
          writeln('')
          writeln(`  ${C.dim}click to edit ▸${C.reset} ${C.cyan}${C.bold}nav /tasks/${t.id}${C.reset}`)
          break
        }

        case 'project': {
          const id = Number(args[0])
          if (!id) { writeln(`${C.red}Usage: project <id>${C.reset}`); break }
          const p = await db.projects.get(id)
          if (!p) { writeln(`${C.red}Project #${id} not found${C.reset}`); break }
          const projectTasks = tasks?.filter(t => t.projectId === id) || []
          const doneTasks = projectTasks.filter(t => t.status === 'done').length
          const inProgress = projectTasks.filter(t => t.status === 'in_progress').length
          writeln('')
          writeln(`  ${C.bold}${C.cyan}Project #${p.id}${C.reset} ${C.bold}${p.name}${C.reset}`)
          writeln(`  ${C.gray}${'─'.repeat(50)}${C.reset}`)
          const typeColor = p.type === 'active_project' ? C.cyan : C.magenta
          writeln(`  ${C.gray}Type:${C.reset}       ${typeColor}${p.type.replace('_', ' ')}${C.reset}`)
          writeln(`  ${C.gray}Color:${C.reset}      ${p.color || 'none'}`)
          if (p.description) writeln(`  ${C.gray}Desc:${C.reset}       ${p.description.slice(0, 80)}${p.description.length > 80 ? '...' : ''}`)
          writeln(`  ${C.gray}Tasks:${C.reset}      ${projectTasks.length} total, ${C.green}${doneTasks} done${C.reset}, ${C.cyan}${inProgress} active${C.reset}`)
          writeln('')
          writeln(`  ${C.dim}click to edit ▸${C.reset} ${C.cyan}${C.bold}nav /projects/${p.id}${C.reset}`)
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
          if (t.status === 'done') { playError(); writeln(`${C.red}Task #${id} is marked as done. Use ${C.bold}status ${id} in_progress${C.reset}${C.red} to reopen it first.${C.reset}`); break }
          await handleSessionsForStatusChange(id, 'in_progress')
          if (t.status !== 'in_progress') {
            await db.tasks.update(id, { status: 'in_progress', updatedAt: new Date() })
            syncTaskUpdate(id, { status: 'in_progress' })
          }
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
          await handleSessionsForStatusChange(id, 'paused')
          await db.tasks.update(id, { status: 'paused', updatedAt: new Date() })
          syncTaskUpdate(id, { status: 'paused' })
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
          const finalStatus = flags.partial ? 'partial_done' : 'done'
          await handleSessionsForStatusChange(id, finalStatus as TaskStatus)
          await db.tasks.update(id, { status: finalStatus as TaskStatus, updatedAt: new Date() })
          syncTaskUpdate(id, { status: finalStatus })
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
          const now = new Date()
          await handleSessionsForStatusChange(id, newStatus)
          await db.tasks.update(id, { status: newStatus, updatedAt: now })
          syncTaskUpdate(id, { status: newStatus })
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
            syncTaskDelete(id)
            // Delete from local IndexedDB
            await db.sessions.where('taskId').equals(id).delete()
            await db.tasks.delete(id)
            playClick()
            toast.success(`Deleted: ${t.title}`)
            logActivity('task_deleted', `Deleted: ${t.title}`, { entityType: 'task' })
            writeln(`${C.red}✗ Task #${id} deleted: ${t.title}${C.reset}`)
          } else if (entity === 'project') {
            const p = await db.projects.get(id)
            if (!p) { writeln(`${C.red}Project #${id} not found${C.reset}`); break }
            syncProjectDelete(id)
            // Delete from local IndexedDB
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
          syncTaskUpdate(taskId, { projectId: proj.id })
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
          syncTaskUpdate(taskId, { projectId: null })
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

    // Clickable nav commands — clicking writes the command to the input line
    // provideLinks bufferLineNumber is 1-based, getLine() is 0-based
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const match = text.match(/nav \/\S+/)
        if (match && match.index !== undefined) {
          callback([{
            text: match[0],
            range: {
              start: { x: match.index + 1, y: bufferLineNumber },
              end: { x: match.index + match[0].length, y: bufferLineNumber },
            },
            activate(_event: MouseEvent, linkText: string) {
              const clearLen = inputBuffer.current.length
              if (clearLen > 0) term.write('\b \b'.repeat(clearLen))
              inputBuffer.current = linkText
              term.write(linkText)
            },
          }])
        } else {
          callback(undefined)
        }
      },
    })

    // Welcome
    const op = operatorRef.current
    const sys = systemRef.current
    term.writeln('')
    term.writeln(`  ${C.cyan}${C.bold}${sys}${C.reset}${C.gray}@${C.reset}${C.green}${op}${C.reset}  ${C.gray}•  ${new Date().toLocaleString()}${C.reset}`)
    term.writeln(`  ${C.gray}Type${C.reset} ${C.green}help${C.reset} ${C.gray}for commands${C.reset}  ${C.dim}•${C.reset}  ${C.green}Tab${C.reset} ${C.gray}autocomplete${C.reset}  ${C.dim}•${C.reset}  ${C.green}↑↓${C.reset} ${C.gray}history${C.reset}  ${C.dim}•${C.reset}  ${C.green}Esc${C.reset} ${C.gray}close${C.reset}`)
    term.writeln('')
    term.write(`${C.cyan}${C.bold}${sys}${C.reset}${C.gray}@${C.reset}${C.green}${op}${C.reset}${C.white}$ ${C.reset}`)

    // Input handling
    term.onData((data) => {
      const code = data.charCodeAt(0)

      if (data === '\r') {
        // Enter
        term.write('\r\n')
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
