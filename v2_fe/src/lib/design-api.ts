/// Design Surface API client — types + calls for `/api/design/{project}/...`
/// and the sandbox origin that serves composed pages.
///
/// The sandbox is a SEPARATE ORIGIN from the chrome (spec §4): in production
/// the API origin (api.taskflow.supercodehive.com) already differs from the
/// SPA, and in dev VITE_SANDBOX_ORIGIN points at the bare backend (:8000)
/// rather than going through the same-origin Vite proxy. An unset variable
/// falls back to the API base, which keeps every deployment cross-origin
/// except a fully same-origin dev setup.

import { API_BASE_URL } from "@/lib/auth-api"

export const SANDBOX_ORIGIN: string =
  (import.meta.env.VITE_SANDBOX_ORIGIN as string | undefined) ?? API_BASE_URL

export function sandboxUrl(token: string, route: string): string {
  const clean = route === "/" ? "" : route.replace(/\/$/, "")
  return `${SANDBOX_ORIGIN}/s/${token}${clean}`
}

// ---------------------------------------------------------------------------
// Types — mirrors taskflow-design's serde shapes
// ---------------------------------------------------------------------------

export type DesignFileKind = "token" | "component" | "page" | "asset"

export type RouteEntry = { path: string; file: string; title: string }

export type ComponentEntry = {
  name: string
  file: string
  attrs: string[]
  usedOn: string[]
  usageCount: number
}

export type TokenGroup = { name: string; variables: [string, string][] }

export type DesignManifest = {
  project: number
  routes: RouteEntry[]
  components: ComponentEntry[]
  tokens: TokenGroup[]
  revision: number
}

export type DesignFileSummary = {
  path: string
  kind: DesignFileKind
  version: number
  updatedBy: string
  updatedAt: string | null
  bytes: number
}

export type CommentScope = "component" | "instance"
export type CommentStatus = "open" | "sent" | "addressed" | "dismissed"

export type DesignComment = {
  id: number
  project: number
  pagePath: string
  componentName: string | null
  elementPath: string
  srcRef: string | null
  viewport: string
  rect: string
  snippet: string
  body: string
  scope: CommentScope
  status: CommentStatus
  threadId: string | null
  author: string
  resolutionNote: string | null
  orphaned: boolean
  createdAt: string | null
}

export type ValidationError = {
  line: number
  rule: string
  message: string
  found?: string
  suggest?: string
}

export type WriteFileResult =
  | { ok: true; file: DesignFileRow; warnings?: unknown[]; affectedRoutes: string[] }
  | { ok: false; errors: ValidationError[]; warnings?: unknown[] }
  | { ok: false; error: "version_conflict"; currentVersion: number; currentContent: string }

type DesignFileRow = {
  id: number
  path: string
  kind: DesignFileKind
  content: string
  version: number
  updatedBy: string
}

async function designFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: "include", ...init })
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

export async function fetchDesignManifest(projectId: number): Promise<DesignManifest> {
  const res = await designFetch(`/api/design/${projectId}/manifest`)
  if (!res.ok) throw new Error(`Could not load the design manifest (${res.status}).`)
  return res.json()
}

/// Free-text prompt from §9.6's bottom bar. Delivered through the same DM
/// channel; the optional selection rides along so "this" resolves to an
/// element instead of a shrug.
export async function sendDesignPrompt(
  projectId: number,
  input: {
    agent_id: number
    text: string
    selection?: {
      route: string
      component: string | null
      elementPath: string
      srcRef: string | null
    } | null
  }
): Promise<{ ok: true; message_id: number }> {
  const res = await designFetch(
    `/api/design/${projectId}/prompt`,
    jsonInit("POST", input)
  )
  if (!res.ok) throw new Error(`Could not deliver the prompt (${res.status}).`)
  return res.json()
}

/// Short-lived HMAC read token for composing sandbox artboard URLs. The chrome
/// re-mints whenever it composes frames; a stale link simply 404s and the
/// artboard shows the retry state.
export async function fetchSandboxToken(projectId: number): Promise<string> {
  const res = await designFetch(`/api/design/${projectId}/sandbox-token`)
  if (!res.ok) throw new Error(`Could not mint a sandbox token (${res.status}).`)
  const body = (await res.json()) as { token: string }
  return body.token
}

export async function fetchDesignFiles(projectId: number): Promise<DesignFileSummary[]> {
  const res = await designFetch(`/api/design/${projectId}/files`)
  if (!res.ok) throw new Error(`Could not list design files (${res.status}).`)
  return res.json()
}

export async function fetchDesignFile(
  projectId: number,
  path: string
): Promise<DesignFileRow | null> {
  const res = await designFetch(
    `/api/design/${projectId}/file?path=${encodeURIComponent(path)}`
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not read ${path} (${res.status}).`)
  return res.json()
}

/// Operator edit. Runs the SAME validator agent writes do — a rejection here is
/// the system working, and the errors come back structured for inline display.
export async function putDesignFile(
  projectId: number,
  path: string,
  content: string,
  baseVersion?: number
): Promise<WriteFileResult> {
  const res = await designFetch(
    `/api/design/${projectId}/file`,
    jsonInit("PUT", { path, content, ...(baseVersion != null ? { base_version: baseVersion } : {}) })
  )
  return res.json()
}

export async function fetchDesignComments(
  projectId: number,
  status?: string
): Promise<DesignComment[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await designFetch(`/api/design/${projectId}/comments${query}`)
  if (!res.ok) throw new Error(`Could not load comments (${res.status}).`)
  return res.json()
}

export async function createDesignComment(
  projectId: number,
  input: {
    page_path: string
    component_name?: string | null
    element_path: string
    src_ref?: string | null
    viewport?: string
    rect: { x: number; y: number; w: number; h: number }
    snippet?: string
    body: string
    scope?: CommentScope
  }
): Promise<DesignComment> {
  const res = await designFetch(
    `/api/design/${projectId}/comments`,
    jsonInit("POST", input)
  )
  if (!res.ok) throw new Error(`Could not save the comment (${res.status}).`)
  return res.json()
}

export async function updateDesignComment(
  projectId: number,
  commentId: number,
  input: {
    status?: CommentStatus
    scope?: CommentScope
    body?: string
    resolution_note?: string
    orphaned?: boolean
  }
): Promise<DesignComment> {
  const res = await designFetch(
    `/api/design/${projectId}/comments/${commentId}`,
    jsonInit("PATCH", input)
  )
  if (!res.ok) throw new Error(`Could not update the comment (${res.status}).`)
  return res.json()
}

export type DesignAgent = { id: number; display_name: string }

export async function fetchDesignAgents(projectId: number): Promise<DesignAgent[]> {
  const res = await designFetch(`/api/design/${projectId}/agents`)
  if (!res.ok) throw new Error(`Could not list agents (${res.status}).`)
  const body = (await res.json()) as { agents: DesignAgent[] }
  return body.agents
}

/// Send selected open comments into an agent's tmux session. The backend
/// formats each as a structured target (file + component + element path +
/// blast radius) and posts it to the agent's DM; the running MCP mirror types
/// it into the pane.
export async function dispatchDesignComments(
  projectId: number,
  commentIds: number[],
  agentId: number
): Promise<{ ok: true; message_id: number; sent_comment_ids: number[] }> {
  const res = await designFetch(
    `/api/design/${projectId}/dispatch`,
    jsonInit("POST", { comment_ids: commentIds, agent_id: agentId })
  )
  if (!res.ok) throw new Error(`Dispatch failed (${res.status}).`)
  return res.json()
}
