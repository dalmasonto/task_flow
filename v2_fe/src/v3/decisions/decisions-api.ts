/// The decisions service (#1094), human side. Shapes mirror
/// backend/plugins/taskflow-decisions/src/service.rs `decision_json`.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type DecisionStatus = "open" | "ruled" | "superseded"

export type DecisionOption = {
  id: number
  label: string
  detail: string | null
  sort_order: number
  recommended: boolean
  recommended_by_label: string | null
  recommended_by_user: number | null
  recommended_by_agent: number | null
}

export type DecisionComment = {
  id: number
  author_label: string
  author_user: number | null
  author_agent: number | null
  body_markdown: string
  created_at: string | null
}

export type Decision = {
  id: number
  project: number
  key: string
  question: string
  context_markdown: string | null
  status: DecisionStatus
  is_ruled: boolean
  asked_by_label: string
  asked_by_user: number | null
  asked_by_agent: number | null
  ruler_user: number | null
  channel: number | null
  options: DecisionOption[]
  ruled_option: DecisionOption | null
  ruling_note: string | null
  ruled_by_label: string | null
  ruled_by_user: number | null
  ruled_at: string | null
  superseded_by_id: number | null
  task_ids: number[]
  created_at: string | null
  updated_at: string | null
  /// Only on the single read.
  comments?: DecisionComment[]
}

export type AskDecision = {
  key: string
  question: string
  context_markdown?: string
  options: { label: string; detail?: string; recommended?: boolean }[]
  ruler_user?: number
  task_ids?: number[]
}

const base = (project: number) => `${API_BASE_URL}/api/taskflow/decisions/${project}`

/// The service answers `{error, field?, reason?}`; turn it into a sentence.
async function fail(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string; field?: string; reason?: string } | null
  if (body?.error === "not_the_ruler") throw new Error("Someone else was named to rule on this.")
  if (body?.error === "not_open") throw new Error("This decision was already ruled or superseded.")
  if (body?.field && body.reason) throw new Error(`${body.field.replace(/_/g, " ")}: ${body.reason}`)
  throw new Error(`${fallback} (${res.status}).`)
}

async function post<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, withBearer({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
  if (!res.ok) return fail(res, fallback)
  return (await res.json()) as T
}

export async function listDecisions(project: number, signal?: AbortSignal): Promise<Decision[]> {
  const res = await fetch(base(project), withBearer({ signal }))
  if (!res.ok) return fail(res, "Couldn't load the decisions")
  return ((await res.json()) as { results?: Decision[] }).results ?? []
}

export async function getDecision(project: number, key: string, signal?: AbortSignal): Promise<Decision> {
  const res = await fetch(`${base(project)}/d/${encodeURIComponent(key)}`, withBearer({ signal }))
  if (!res.ok) return fail(res, "Couldn't load the decision")
  return (await res.json()) as Decision
}

export const askDecision = (project: number, input: AskDecision) => post<Decision>(base(project), input, "Couldn't ask for the decision")

export const ruleDecision = (project: number, key: string, option_id: number, note?: string) =>
  post<Decision>(`${base(project)}/d/${encodeURIComponent(key)}/rule`, { option_id, ...(note?.trim() ? { note: note.trim() } : {}) }, "Couldn't record the ruling")

export const commentOnDecision = (project: number, key: string, body_markdown: string) =>
  post<unknown>(`${base(project)}/d/${encodeURIComponent(key)}/comments`, { body_markdown }, "Couldn't post the comment")
