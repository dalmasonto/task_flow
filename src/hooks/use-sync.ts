import { useEffect, useRef } from 'react'
import { db } from '@/db/database'

const BASE_URL = 'http://localhost:3456'
const SSE_URL = `${BASE_URL}/events`
const SYNC_URL = `${BASE_URL}/sync`

async function initialSync() {
  try {
    const res = await fetch(SYNC_URL)
    if (!res.ok) return
    const data = await res.json()

    if (data.tasks?.length) {
      const tasks = data.tasks.map((t: Record<string, unknown>) => parseTask(t))
      await db.tasks.bulkPut(tasks)
    }
    if (data.projects?.length) {
      const projects = data.projects.map((p: Record<string, unknown>) => parseProject(p))
      await db.projects.bulkPut(projects)
    }
    if (data.sessions?.length) {
      const sessions = data.sessions.map((s: Record<string, unknown>) => parseSession(s))
      await db.sessions.bulkPut(sessions)
    }
  } catch {
    // MCP server not running — skip initial sync
  }
}

export function useSync() {
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    // Load existing MCP data into Dexie on first connect
    initialSync()

    const source = new EventSource(SSE_URL)
    sourceRef.current = source

    source.addEventListener('task_created', (e) => {
      const { payload } = JSON.parse(e.data)
      if (payload) {
        // Parse JSON string fields back to arrays/objects
        const task = parseTask(payload)
        db.tasks.put(task)
      }
    })

    source.addEventListener('task_updated', (e) => {
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

    source.addEventListener('project_created', (e) => {
      const { payload } = JSON.parse(e.data)
      if (payload) db.projects.put(parseProject(payload))
    })

    source.addEventListener('project_updated', (e) => {
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

    source.addEventListener('activity_cleared', () => {
      db.activityLogs.clear()
    })

    // Silently handle errors (MCP server may not be running)
    source.onerror = () => {
      // EventSource auto-reconnects — no action needed
    }

    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [])
}

// Parse MCP server format (snake_case, JSON strings, ISO dates) to Dexie format (camelCase, arrays, Date objects)
function parseTask(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    title: raw.title as string,
    description: raw.description as string | undefined,
    status: raw.status as string,
    priority: raw.priority as string,
    projectId: raw.project_id as number | undefined,
    dependencies: parseJsonField(raw.dependencies, []),
    links: parseJsonField(raw.links, []),
    tags: parseJsonField(raw.tags, []),
    dueDate: raw.due_date ? new Date(raw.due_date as string) : undefined,
    estimatedTime: raw.estimated_time as number | undefined,
    createdAt: new Date(raw.created_at as string),
    updatedAt: new Date(raw.updated_at as string),
  }
}

function parseProject(raw: Record<string, unknown>) {
  return {
    id: raw.id as number,
    name: raw.name as string,
    color: raw.color as string,
    type: raw.type as string,
    description: raw.description as string | undefined,
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

function parseJsonField(value: unknown, fallback: unknown[]) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return fallback
}
