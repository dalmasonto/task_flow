import { useEffect, useRef } from 'react'
import { db } from '@/db/database'
import { useSetting } from '@/hooks/use-settings'
import type { TaskStatus, TaskPriority, ProjectType, ActivityAction } from '@/types'

function baseUrl(port: number) { return `http://localhost:${port}` }

async function initialSync(port: number, retries = 5, delay = 1500): Promise<void> {
  const syncUrl = `${baseUrl(port)}/sync`
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(syncUrl)
      if (!res.ok) continue
      const data = await res.json()

      if (data.tasks?.length) await db.tasks.bulkPut(data.tasks.map((t: Record<string, unknown>) => parseTask(t)))
      if (data.projects?.length) await db.projects.bulkPut(data.projects.map((p: Record<string, unknown>) => parseProject(p)))
      if (data.sessions?.length) await db.sessions.bulkPut(data.sessions.map((s: Record<string, unknown>) => parseSession(s)))
      if (data.activityLogs?.length) await db.activityLogs.bulkPut(data.activityLogs.map((a: Record<string, unknown>) => parseActivityLog(a)))
      if (data.agentMessages?.length) await db.agentMessages.bulkPut(data.agentMessages.map((m: Record<string, unknown>) => parseAgentMessage(m)))

      console.log('[useSync] initial sync complete')
      return
    } catch {
      // Server not ready yet — wait and retry
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay))
    }
  }
  console.log('[useSync] initial sync skipped — server not available')
}

const RECONNECT_DELAY = 3000
const MAX_RECONNECT_DELAY = 30000

/** Attach all SSE event listeners to an EventSource */
function attachListeners(source: EventSource, sseUrl: string) {
  source.addEventListener('connected', () => {
    console.log('[useSync] SSE connected to', sseUrl)
  })

  source.addEventListener('task_created', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) {
      const task = parseTask(payload)
      console.log('[useSync] putting task:', task.id, task.title)
      db.tasks.put(task)
    }
  })

  source.addEventListener('task_updated', (e) => {
    console.log('[useSync] task_updated event received')
    const { payload } = JSON.parse(e.data)
    if (payload) db.tasks.put(parseTask(payload))
  })

  source.addEventListener('task_status_changed', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.tasks.put(parseTask(payload))
  })

  source.addEventListener('task_completed', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.tasks.put(parseTask(payload))
  })

  source.addEventListener('task_partial_done', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.tasks.put(parseTask(payload))
  })

  source.addEventListener('task_deleted', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload?.id) db.tasks.delete(payload.id)
  })

  source.addEventListener('tasks_bulk_created', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload?.tasks) db.tasks.bulkPut(payload.tasks.map(parseTask))
  })

  source.addEventListener('project_created', async (e) => {
    console.log('[useSync] project_created event received')
    const { payload } = JSON.parse(e.data)
    if (payload) {
      const project = parseProject(payload)
      console.log('[useSync] putting project:', project.id, project.name)
      try {
        await db.projects.put(project)
        const count = await db.projects.count()
        console.log('[useSync] project put success, total projects in Dexie:', count)
      } catch (err) {
        console.error('[useSync] project put FAILED:', err)
      }
    }
  })

  source.addEventListener('project_updated', (e) => {
    console.log('[useSync] project_updated event received')
    const { payload } = JSON.parse(e.data)
    if (payload) db.projects.put(parseProject(payload))
  })

  source.addEventListener('project_deleted', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload?.id) db.projects.delete(payload.id)
  })

  source.addEventListener('timer_started', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) {
      if (payload.session) db.sessions.put(parseSession(payload.session))
      if (payload.task_id) db.tasks.update(payload.task_id, { status: 'in_progress', updatedAt: new Date() })
    }
  })

  source.addEventListener('timer_paused', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) {
      if (payload.session) db.sessions.put(parseSession(payload.session))
      if (payload.task_id) db.tasks.update(payload.task_id, { status: 'paused', updatedAt: new Date() })
    }
  })

  source.addEventListener('timer_stopped', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) {
      if (payload.session) db.sessions.put(parseSession(payload.session))
      if (payload.task_id && payload.task_status) {
        db.tasks.update(payload.task_id, { status: payload.task_status, updatedAt: new Date() })
      }
    }
  })

  source.addEventListener('settings_saved', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload?.key !== undefined) {
      db.settings.where('key').equals(payload.key).modify({ value: payload.value })
        .catch(() => db.settings.add({ key: payload.key, value: payload.value }))
    }
  })

  source.addEventListener('notifications_cleared', () => {
    db.notifications.clear()
  })

  source.addEventListener('notifications_all_read', () => {
    db.notifications.toCollection().modify({ read: true })
  })

  source.addEventListener('activity_logged', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.activityLogs.put(parseActivityLog(payload))
  })

  source.addEventListener('activity_cleared', () => {
    db.activityLogs.clear()
  })

  source.addEventListener('agent_question', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.agentMessages.put(parseAgentMessage(payload))
  })

  source.addEventListener('agent_question_answered', (e) => {
    const { payload } = JSON.parse(e.data)
    if (payload) db.agentMessages.put(parseAgentMessage(payload))
  })

  source.addEventListener('data_cleared', async () => {
    try {
      await db.tasks.clear()
      await db.projects.clear()
      await db.sessions.clear()
      await db.notifications.clear()
      await db.activityLogs.clear()
      await db.agentMessages.clear()
      console.log('[useSync] data_cleared: all Dexie tables cleared')
    } catch (err) {
      console.error('[useSync] data_cleared failed:', err)
    }
  })
}

export function useSync() {
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const port = useSetting('serverPort')

  useEffect(() => {
    let killed = false
    let delay = RECONNECT_DELAY

    function connect() {
      if (killed) return

      const sseUrl = `${baseUrl(port)}/events`

      // Close previous connection if any
      if (sourceRef.current) {
        sourceRef.current.close()
        sourceRef.current = null
      }

      console.log('[useSync] connecting to', sseUrl)
      const source = new EventSource(sseUrl)
      sourceRef.current = source

      attachListeners(source, sseUrl)

      source.addEventListener('connected', () => {
        // Reset backoff on successful connection
        delay = RECONNECT_DELAY
      })

      source.onerror = () => {
        const state = source.readyState
        const label = state === 0 ? 'CONNECTING' : state === 1 ? 'OPEN' : 'CLOSED'
        console.warn(`[useSync] SSE error — readyState: ${label}`)

        if (state === EventSource.CLOSED && !killed) {
          // Native EventSource won't reconnect from CLOSED — do it ourselves
          source.close()
          sourceRef.current = null
          console.log(`[useSync] SSE closed — reconnecting in ${delay / 1000}s`)
          reconnectTimer.current = setTimeout(connect, delay)
          // Exponential backoff capped at MAX_RECONNECT_DELAY
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY)
        }
      }
    }

    // Initial sync then connect
    initialSync(port).then(connect)

    return () => {
      killed = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (sourceRef.current) {
        sourceRef.current.close()
        sourceRef.current = null
      }
    }
  }, [port])
}

// Parse MCP server format (snake_case, JSON strings, ISO dates) to Dexie format (camelCase, arrays, Date objects)
function parseTask(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    title: raw.title as string,
    description: raw.description != null ? (raw.description as string) : undefined,
    status: raw.status as TaskStatus,
    priority: raw.priority as TaskPriority,
    projectId: raw.project_id != null ? (raw.project_id as number) : undefined,
    dependencies: parseJsonField(raw.dependencies, []),
    links: parseJsonField(raw.links, []),
    tags: parseJsonField(raw.tags, []),
    dueDate: raw.due_date != null ? new Date(raw.due_date as string) : undefined,
    estimatedTime: raw.estimated_time != null ? (raw.estimated_time as number) : undefined,
    createdAt: new Date(raw.created_at as string),
    updatedAt: new Date(raw.updated_at as string),
  }
}

function parseProject(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    name: raw.name as string,
    color: raw.color as string,
    type: raw.type as ProjectType,
    description: raw.description != null ? (raw.description as string) : undefined,
    createdAt: new Date(raw.created_at as string),
  }
}

function parseSession(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    taskId: raw.task_id as number,
    start: new Date(raw.start as string),
    end: raw.end ? new Date(raw.end as string) : undefined,
  }
}

function parseActivityLog(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    action: raw.action as ActivityAction,
    title: raw.title as string,
    detail: raw.detail != null ? (raw.detail as string) : undefined,
    entityType: raw.entity_type != null ? (raw.entity_type as 'task' | 'project' | 'session' | 'system') : undefined,
    entityId: raw.entity_id != null ? (raw.entity_id as number) : undefined,
    createdAt: new Date(raw.created_at as string),
  }
}

function parseAgentMessage(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    projectId: raw.project_id as number,
    question: raw.question as string,
    context: raw.context != null ? (raw.context as string) : undefined,
    choices: raw.choices != null ? parseJsonField(raw.choices, []) : undefined,
    response: raw.response != null ? (raw.response as string) : undefined,
    status: raw.status as 'pending' | 'answered' | 'dismissed',
    createdAt: new Date(raw.created_at as string),
    answeredAt: raw.answered_at ? new Date(raw.answered_at as string) : undefined,
  }
}

function parseJsonField(value: unknown, fallback: unknown[]) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return fallback
}
