/// The task page's reads that the workspace doesn't carry (tested through the
/// page; the shapes are #TSK1117's).
import { API_BASE_URL, withBearer } from "@/lib/auth-api"

export type Evidence = {
  id: number
  kind: "test_run" | "ci_run" | "pull_request" | "attachment" | "note"
  label: string
  url: string | null
  passed: boolean | null
  stats: { passed: number | null; failed: number | null; duration_ms: number | null; files: number | null; additions: number | null; deletions: number | null }
  attachment: { id: number; filename: string; content_type: string; size: number } | null
  author_label: string
  self_reported: true
  created_at: string | null
}

export async function fetchTaskEvidence(taskId: number, signal?: AbortSignal): Promise<Evidence[]> {
  const res = await fetch(`${API_BASE_URL}/api/taskflow/tasks/${taskId}/evidence`, withBearer({ signal }))
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Couldn't load the evidence (${res.status}).`)
  const body = (await res.json()) as { evidence?: Evidence[] }
  return body.evidence ?? []
}
