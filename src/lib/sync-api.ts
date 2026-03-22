const BASE = 'http://localhost:3456'

/** Fire-and-forget sync to MCP backend. Never throws — UI always works standalone. */
function fire(url: string, method: string, body?: unknown) {
  fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {})
}

// ─── Tasks ────────────────────────────────────────────────────────────

export function syncTaskUpdate(id: number, fields: Record<string, unknown>) {
  fire(`/api/tasks/${id}`, 'PATCH', fields)
}

export function syncTaskCreate(fields: Record<string, unknown>) {
  fire('/api/tasks', 'POST', fields)
}

export function syncTaskDelete(id: number) {
  fire(`/api/tasks/${id}`, 'DELETE')
}

// ─── Projects ─────────────────────────────────────────────────────────

export function syncProjectUpdate(id: number, fields: Record<string, unknown>) {
  fire(`/api/projects/${id}`, 'PATCH', fields)
}

export function syncProjectDelete(id: number) {
  fire(`/api/projects/${id}`, 'DELETE')
}

// ─── Sessions ─────────────────────────────────────────────────────────

export function syncSessionCreate(fields: { taskId: number; start: Date; end?: Date }) {
  fire('/api/sessions', 'POST', fields)
}

export function syncSessionUpdate(id: number, fields: { end: Date }) {
  fire(`/api/sessions/${id}`, 'PATCH', fields)
}

// ─── System ───────────────────────────────────────────────────────────

export function syncClearData() {
  fire('/api/clear-data', 'POST')
}
