/// #TSK1113 wake-up rules, as people manage them.
import type { TaskflowWakeRuleDeliver, TaskflowWakeRuleStatus, TaskflowWakeRuleTriggerKind } from "@/api/client"
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type WakeRule = {
  id: number
  project: number
  agent: number
  created_by_label: string
  trigger: TaskflowWakeRuleTriggerKind
  target_task: number | null
  target_message: number | null
  watch_channel: number | null
  mentions_only: boolean
  fire_at: string | null
  note: string
  deliver: TaskflowWakeRuleDeliver
  status: TaskflowWakeRuleStatus
  fired_at: string | null
  created_at: string | null
}

export type WakeCreate = {
  agent: number
  trigger: TaskflowWakeRuleTriggerKind
  task?: number
  message?: number
  channel?: number
  mentions_only?: boolean
  in_minutes?: number
  note: string
  deliver: TaskflowWakeRuleDeliver
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body && (body.detail || body.reason || body.error)) || `Couldn't ${what} (${res.status}).`)
  }
  return (await res.json()) as T
}

export async function listWakeRules(project: number, signal?: AbortSignal): Promise<WakeRule[]> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/wakeups/${project}`, withBearer({ signal }))
  return (await json<{ results: WakeRule[] }>(res, "load the wake-ups")).results
}

export async function createWakeRule(project: number, input: WakeCreate): Promise<WakeRule> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/wakeups/${project}`, withBearer({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }))
  return json<WakeRule>(res, "create the wake-up")
}

export async function actOnWakeRule(project: number, id: number, action: "pause" | "resume" | "cancel"): Promise<WakeRule> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/wakeups/${project}/${id}/${action}`, withBearer({ method: "POST" }))
  return json<WakeRule>(res, `${action} the wake-up`)
}
