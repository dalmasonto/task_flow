/// #TSK1116's inbox: one feed of what needs a person, across their projects.
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type InboxTab = "needs_you" | "mentions" | "everything"

type Base = { at: string; unread: boolean; project: number }
export type InboxItem =
  | (Base & { kind: "prompt" | "prompt_withdrawn"; prompt: number; agent: number; agent_label: string | null; question: string; options_json: string | null; prompt_kind: string })
  | (Base & { kind: "decision"; decision: number; key: string; question: string; asked_by_label: string })
  | (Base & { kind: "review_request"; review_request: number; task: number; requester_label: string; link: string | null; focus_markdown: string | null })
  | (Base & { kind: "daily_update"; daily_update: number; date: string; excerpt: string; drafted_by_label: string })
  | (Base & { kind: "mention"; message: number; channel: number; sender_label: string; sender_kind: string; snippet: string })

export type InboxPage = { items: InboxItem[]; counts: { needs_you: number; mentions: number }; unread: number; seen_at: string | null }

export async function fetchInbox(tab: InboxTab, project: number | null, signal?: AbortSignal): Promise<InboxPage> {
  const q = new URLSearchParams({ tab, ...(project ? { project: String(project) } : {}) })
  const res = await fetch(`${API_BASE_URL}/api/taskflow/inbox?${q}`, withBearer({ signal }))
  if (!res.ok) throw new Error(`Couldn't load the inbox (${res.status}).`)
  return (await res.json()) as InboxPage
}

export async function markInboxRead(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/inbox/read`, withBearer({ method: "POST" }))
  if (!res.ok) throw new Error(`Couldn't mark the inbox read (${res.status}).`)
}
