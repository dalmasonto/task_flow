/// The daily-update service (#1118), people's side. Shapes mirror
/// backend/plugins/taskflow-daily/src/service.rs `update_json` and views.rs
/// `settings_json`. Reads need membership; every write needs owner or admin.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type DailyStatus = "draft" | "posted" | "skipped"

export type DailyUpdateSummary = {
  id: number
  project: number
  date: string
  status: DailyStatus
  version: number
  edit_count: number
  posted_at: string | null
  posted_message: number | null
  drafted_by_label: string
  server_drafted: boolean
  excerpt: string
}

export type DailyUpdate = DailyUpdateSummary & {
  body_markdown: string
  window_start: string | null
  window_end: string | null
  sources: { activity: number; task_changes: number; reviews: number; pull_requests: number }
  posted_by: number | null
  created_at: string | null
}

export type DailySettings = {
  enabled: boolean
  local_time: string
  timezone: string
  drafting_agent: number | null
  post_channel: number | null
  updated_by_label: string | null
  updated_at: string | null
}

/// A 409 from an edit or a state change: someone else changed it first.
export class DailyConflict extends Error {
  constructor() {
    super("It changed while you were looking at it. Reloaded the latest.")
  }
}

const root = (p: number) => `${API_BASE_URL}/api/taskflow/projects/${p}`

async function send<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await fetch(url, withBearer(init))
  if (res.status === 409) throw new DailyConflict()
  if (res.status === 403) throw new Error("Only owners and admins can change the daily update.")
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { field?: string; reason?: string; error?: string } | null
    throw new Error(b?.field && b.reason ? `${b.field.replace(/_/g, " ")}: ${b.reason}` : `${fallback} (${res.status}).`)
  }
  return (await res.json()) as T
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export async function listDailyUpdates(project: number, signal?: AbortSignal): Promise<DailyUpdateSummary[]> {
  const b = await send<{ updates?: DailyUpdateSummary[] }>(`${root(project)}/daily-updates?limit=30`, { signal }, "Couldn't load the daily updates")
  return b.updates ?? []
}

export async function getDailyUpdate(project: number, date: string, signal?: AbortSignal): Promise<DailyUpdate | null> {
  const res = await fetch(`${root(project)}/daily-updates/${date}`, withBearer({ signal }))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Couldn't load the update (${res.status}).`)
  return (await res.json()) as DailyUpdate
}

export const getDailySettings = (project: number, signal?: AbortSignal) => send<DailySettings>(`${root(project)}/daily-update-settings`, { signal }, "Couldn't load the schedule")

export const editDailyUpdate = (project: number, date: string, body_markdown: string, base_version: number) =>
  send<DailyUpdate>(`${root(project)}/daily-updates/${date}`, json("PATCH", { body_markdown, base_version }), "Couldn't save the edit")

const act = (what: "draft" | "post" | "skip" | "redraft", fallback: string) => (project: number, date: string) =>
  send<DailyUpdate>(`${root(project)}/daily-updates/${date}/${what}`, json("POST"), fallback)

export const draftDailyNow = act("draft", "Couldn't make the draft")
export const postDailyUpdate = act("post", "Couldn't post the update")
export const skipDailyUpdate = act("skip", "Couldn't skip the update")
export const redraftDailyUpdate = act("redraft", "Couldn't draft it again")
