/// #617: the Toolbox page's data — the project's shared memories and scripts.
///
/// The listing endpoint never carries code (the server enforces it, and the
/// index type here has no field for it), so the one deliberate read is
/// `fetchToolboxEntry`, which is what the entry view calls.

import { API_BASE_URL, readJson } from "@/lib/auth-api"
import { getStoredToken } from "@/lib/auth-api"

export type ToolboxKind = "memory" | "script"
export type ToolboxStatus = "draft" | "approved" | "deprecated"

export type ToolboxIndexEntry = {
  id: number
  kind: ToolboxKind
  name: string
  title: string
  description: string
  status: ToolboxStatus
  version: number
  tags: string[]
  language: string | null
  entrypoint: string | null
  requires_env: string[]
  last_run_at: string | null
  last_run_ok: boolean
  run_ok_count: number
  run_fail_count: number
  author_label: string
  updated_at: string | null
}

export type ToolboxParam = { name: string; description?: string; required?: boolean }

export type ToolboxEntry = ToolboxIndexEntry & {
  body_markdown: string
  code: string | null
  params: ToolboxParam[]
  deprecated_reason: string | null
  created_at: string | null
}

export type ToolboxVersion = {
  version: number
  description: string
  author_label: string
  note: string | null
  vetted_by: string | null
  vetted_note: string | null
  created_at: string | null
}

export type ToolboxVersionFull = {
  version: number
  description: string
  body_markdown: string
  code: string | null
  params: ToolboxParam[]
  requires_env: string[]
  author_label: string
  note: string | null
  created_at: string | null
}

function headers(): Record<string, string> {
  const token = getStoredToken()
  return { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function toolboxRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...init })
  if (!response.ok) {
    const detail = (await response
      .json()
      .then((value: { error?: string; detail?: string }) => value.detail ?? value.error)
      .catch(() => null)) as string | null
    throw new Error(detail ?? `Toolbox request failed (${response.status}).`)
  }
  if (response.status === 204) return undefined as T
  return readJson<T>(response)
}

export async function fetchToolboxIndex(
  projectId: number,
  filters: { kind?: ToolboxKind; tag?: string; query?: string } = {},
): Promise<ToolboxIndexEntry[]> {
  const params = new URLSearchParams()
  if (filters.kind) params.set("kind", filters.kind)
  if (filters.tag) params.set("tag", filters.tag)
  if (filters.query) params.set("query", filters.query)
  const query = params.toString()
  const body = await toolboxRequest<{ entries: ToolboxIndexEntry[] }>(
    `/api/taskflow/toolbox/${projectId}${query ? `?${query}` : ""}`,
  )
  return body.entries ?? []
}

export function fetchToolboxEntry(projectId: number, name: string): Promise<ToolboxEntry> {
  return toolboxRequest<ToolboxEntry>(`/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}`)
}

export function fetchToolboxVersions(
  projectId: number,
  name: string,
): Promise<{ current_version: number; versions: ToolboxVersion[] }> {
  return toolboxRequest(`/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}/versions`)
}

export function fetchToolboxVersion(projectId: number, name: string, version: number): Promise<ToolboxVersionFull> {
  return toolboxRequest(
    `/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}/versions/${version}`,
  )
}

export function setToolboxStatus(
  projectId: number,
  name: string,
  status: ToolboxStatus,
  reason?: string,
): Promise<{ entry: ToolboxIndexEntry }> {
  return toolboxRequest(`/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}/status`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ status, reason }),
  })
}

export function restoreToolboxVersion(
  projectId: number,
  name: string,
  version: number,
): Promise<{ entry: ToolboxEntry }> {
  return toolboxRequest(`/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}/versions/restore`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ version }),
  })
}

export function deleteToolboxEntry(projectId: number, name: string): Promise<void> {
  return toolboxRequest<void>(`/api/taskflow/toolbox/${projectId}/entry/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: headers(),
  })
}

/// A script's health, for the badges the design asks for.
export function toolboxBadge(entry: ToolboxIndexEntry): { label: string; tone: "warn" | "bad" | "ok" } | null {
  if (entry.kind !== "script") return null
  if (entry.last_run_at && !entry.last_run_ok) return { label: "failing", tone: "bad" }
  if (entry.last_run_at && entry.last_run_ok) return { label: "working", tone: "ok" }
  return null
}
