/// Design Surface API client — types + calls for `/api/design/{project}/...`
/// and the sandbox origin that serves composed pages.
///
/// The sandbox is a SEPARATE ORIGIN from the chrome (spec §4): in production
/// the API origin (api.taskflow.supercodehive.com) already differs from the
/// SPA, and in dev VITE_SANDBOX_ORIGIN points at the bare backend (:8000)
/// rather than going through the same-origin Vite proxy. An unset variable
/// falls back to the API base, which keeps every deployment cross-origin
/// except a fully same-origin dev setup.

import { API_BASE_URL, readJson } from "@/lib/auth-api"
import { normalizeLayout, type LayoutDoc } from "@/lib/design-layout"
import {
  DEFAULT_RESOURCES_DOC,
  normalizeResources,
  type ResourceLink,
  type ResourcesDoc,
} from "@/lib/resources"

export const SANDBOX_ORIGIN: string =
  (import.meta.env.VITE_SANDBOX_ORIGIN as string | undefined) ?? API_BASE_URL

export function sandboxUrl(token: string, route: string): string {
  const clean = route === "/" ? "" : route.replace(/\/$/, "")
  return `${SANDBOX_ORIGIN}/s/${token}${clean}`
}

// ---------------------------------------------------------------------------
// Types — mirrors taskflow-design's serde shapes
// ---------------------------------------------------------------------------

// TWO naming conventions live below, and each one mirrors the Rust shape it comes
// from. Do not "tidy" either into the other — a rename here is a rename of the
// wire, and a type that names a field the server does not send is a promise of a
// value that is `undefined` at runtime (the editor then renders nothing at all).
//
// * DOCUMENT shapes are camelCase because the Rust type they mirror carries
//   `#[serde(rename_all = "camelCase")]` — `resources.rs`'s `ResourcesDoc`,
//   `ResourceSet` and `ResourceLink`, `layout_doc`'s `LayoutDoc`, and
//   `manifest.rs`'s `ComponentEntry`, `TokenGroup` and `DesignManifest` — hence
//   `isScript`, `isAsync`, `usedOn`. Where the mirrored struct carries NO
//   `rename_all` (`tokens.rs`'s `TokensDoc`, `manifest.rs`'s `RouteEntry`,
//   `layout_doc`'s `LayoutGroup`) this side is still right only because every
//   key on both sides is a single word (`version`, `categories`, `light`,
//   `dark`; `path`, `file`, `title`; `id`, `name`, `routes`). Add one two-word
//   key there and the two spellings part company.
// * ROW and VIEW shapes are snake_case, and again the mechanism is the absence
//   of a rename, not the kind of Rust type: the ORM models (`DesignFile`,
//   `DesignComment`) serialise their columns as written, `views::FileSummary` is
//   a hand-written `#[derive(Serialize)]` struct naming its own fields, and a
//   `json!({...})` literal (`views::conflict_response`, `put_file`'s
//   `affected_routes`) sends exactly what was typed into it — hence `updated_by`,
//   `current_version`, `affected_routes`, `page_path`, `resolution_note`.
//
// A spelling is only pinned where something READS it. `toMatchObject` pins the
// conflict arm's `current_version`/`current_content`, and `design-comments.test.ts`
// pins the comment fields through the helpers that read them. `updated_by` and
// `affected_routes` are read by NOTHING in this client, so no test can pin them:
// they rest on the Rust source alone, and the first reader is the moment to check
// the Rust rather than this type. That is how `DesignComment` reached this round —
// the inspector read `pagePath` while the endpoint sent `page_path`, and `tsc` was
// perfectly satisfied throughout.

export type DesignFileKind = "token" | "component" | "page" | "asset"

export type RouteEntry = { path: string; file: string; title: string }

export type ComponentEntry = {
  name: string
  file: string
  attrs: string[]
  usedOn: string[]
  usageCount: number
}

export type TokenGroup = {
  name: string
  variables: [string, string][]
  /// Dark-mode overrides, as `(name, dark value)` pairs. A Rust tuple
  /// serialises as a JSON array — `[string, string]`, not `{0, 1}` — and the
  /// server OMITS this field when nothing in the group has one.
  variables_dark?: [string, string][]
}

/// Mirrors the backend's `TokensDoc` (styles/tokens.json) exactly: a flat
/// version counter plus category → token-name → {light, dark?} values. `dark`
/// is omitted when a token has no dark override.
export type DesignTokensDoc = {
  version: number
  categories: Record<string, Record<string, { light: string; dark?: string }>>
}

const DEFAULT_TOKENS_DOC: DesignTokensDoc = { version: 1, categories: {} }
const TOKENS_JSON_PATH = "styles/tokens.json"

/// The project's external resource document (taskflow-design's `resources.rs`):
/// named, toggleable sets of the `<link>`/`<script>` tags a page needs. A
/// `DesignFile` row like the tokens file — same kind, same endpoints, its own
/// validator — so it is reached through the same generic calls below.
export const RESOURCES_JSON_PATH = "styles/resources.json"

export type DesignManifest = {
  project: number
  routes: RouteEntry[]
  components: ComponentEntry[]
  tokens: TokenGroup[]
  revision: number
  /// The enabled resource sets' links, in document order, as `(isScript, link)`
  /// pairs — a Rust tuple serialises as a JSON ARRAY, so each entry is
  /// `[boolean, ResourceLink]` and not an object. Nothing in the chrome reads
  /// it (the server injects the same links into every composed page); it is
  /// declared because this type claims to mirror the manifest, and the next
  /// reader should not have to go and check what `Vec<(bool, ResourceLink)>`
  /// turned into.
  resources: [boolean, ResourceLink][]
}

export type DesignFileSummary = {
  path: string
  kind: DesignFileKind
  version: number
  /// Snake_case because `views::FileSummary` names its own fields and carries
  /// no `rename_all` — a hand-written view struct, not an ORM row.
  updated_by: string
  updated_at: string | null
  bytes: number
}

export type CommentScope = "component" | "instance"
export type CommentStatus = "open" | "sent" | "addressed" | "dismissed"

export type DesignComment = {
  id: number
  project: number
  /// Snake_case, and these are COLUMN names: an ORM model with no `rename_all`
  /// (the backend's phase3 test reads `resolution_note` off this very endpoint,
  /// `tests/phase3_agent_surface.rs:294`). Read one through the other spelling
  /// and it is `undefined` — no error, a blank label and a click that does
  /// nothing — so the reads live in `design-comments.ts`, where a wire-shaped
  /// test can reach them.
  page_path: string
  component_name: string | null
  element_path: string
  src_ref: string | null
  viewport: string
  rect: string
  snippet: string
  body: string
  scope: CommentScope
  status: CommentStatus
  thread_id: string | null
  author: string
  resolution_note: string | null
  orphaned: boolean
  created_at: string | null
}

export type ValidationError = {
  line: number
  rule: string
  message: string
  found?: string
  suggest?: string
}

export type WriteFileResult =
  | { ok: true; file: DesignFileRow; warnings?: unknown[]; affected_routes: string[] }
  | { ok: false; errors: ValidationError[]; warnings?: unknown[] }
  | {
      ok: false
      error: "version_conflict"
      current_version: number
      current_content: string
    }

type DesignFileRow = {
  id: number
  path: string
  kind: DesignFileKind
  content: string
  version: number
  /// Snake_case: `DesignFile` is the ORM row itself, nothing renames it.
  updated_by: string
}

async function designFetch(path: string, init?: RequestInit): Promise<Response> {
  // Prefix the API origin, exactly like auth-api / taskflow-api do. Without this
  // a relative `/api/design/...` path resolves against the SPA host (e.g.
  // taskflow.supercodehive.com) instead of the API host
  // (api.taskflow.supercodehive.com), so the app server answers with index.html
  // and every design call fails. Dev only masks it because the Vite proxy
  // forwards these paths to the backend.
  return fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...init })
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
  return readJson(res)
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
  return readJson(res)
}

/// Short-lived HMAC read token for composing sandbox artboard URLs. The chrome
/// re-mints whenever it composes frames; a stale link simply 404s and the
/// artboard shows the retry state.
export async function fetchSandboxToken(projectId: number): Promise<string> {
  const res = await designFetch(`/api/design/${projectId}/sandbox-token`)
  if (!res.ok) throw new Error(`Could not mint a sandbox token (${res.status}).`)
  const body = await readJson<{ token: string }>(res)
  return body.token
}

export async function fetchDesignFiles(projectId: number): Promise<DesignFileSummary[]> {
  const res = await designFetch(`/api/design/${projectId}/files`)
  if (!res.ok) throw new Error(`Could not list design files (${res.status}).`)
  return readJson(res)
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
  return readJson(res)
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
  return readJson(res)
}

/// Reads the structured tokens file. A missing row (new project, nothing
/// written yet) is not an error — it's the empty document, versioned 0 so the
/// first `putDesignTokens` call is an unconditional create rather than racing
/// a `base_version` that never existed. Malformed JSON (shouldn't happen past
/// the backend's `validate_tokens_json`, but editors and manual edits exist)
/// fails soft to the same default rather than throwing into the UI.
export async function fetchDesignTokens(
  projectId: number
): Promise<{ doc: DesignTokensDoc; version: number }> {
  const row = await fetchDesignFile(projectId, TOKENS_JSON_PATH)
  if (!row || !row.content) {
    return { doc: DEFAULT_TOKENS_DOC, version: 0 }
  }
  try {
    const doc = JSON.parse(row.content) as DesignTokensDoc
    return { doc, version: row.version }
  } catch {
    return { doc: DEFAULT_TOKENS_DOC, version: 0 }
  }
}

/// Writes the structured tokens file. Goes through the same `putDesignFile`
/// path (and thus the same `validate_tokens_json` + 409/version-conflict
/// handling) every other design file write uses — tokens are just a file with
/// JSON content as far as this plumbing is concerned.
export async function putDesignTokens(
  projectId: number,
  doc: DesignTokensDoc,
  baseVersion: number
): Promise<WriteFileResult> {
  return putDesignFile(
    projectId,
    TOKENS_JSON_PATH,
    JSON.stringify(doc),
    baseVersion
  )
}

/// Reads the structured resources file. Same forgiving read as
/// `fetchDesignTokens` above, and for the same reasons: a missing row (new
/// project) is the empty document at version 0, so the first save is an
/// unconditional create rather than racing a `base_version` that never existed,
/// and content that does not parse fails soft to that same default instead of
/// throwing into the editor. Normalised on the way in, because the Rust side
/// always serialises every field — so `null` is what actually arrives for the
/// optional ones, and an un-normalised `null` would be written straight back.
export async function fetchDesignResources(
  projectId: number
): Promise<{ doc: ResourcesDoc; version: number }> {
  const row = await fetchDesignFile(projectId, RESOURCES_JSON_PATH)
  if (!row || !row.content) {
    return { doc: DEFAULT_RESOURCES_DOC, version: 0 }
  }
  try {
    return { doc: normalizeResources(JSON.parse(row.content)), version: row.version }
  } catch {
    return { doc: DEFAULT_RESOURCES_DOC, version: 0 }
  }
}

/// Writes the structured resources file. Goes through the same `putDesignFile`
/// path (and thus the same `validate_resources` + 409/version-conflict
/// handling) every other design file write uses. Its refusals are the user's
/// only feedback that a link is unusable: `validate` refuses the WHOLE document
/// over one bad link and the manifest then contributes nothing, so swallowing
/// them would silently remove every font in the project.
export async function putDesignResources(
  projectId: number,
  doc: ResourcesDoc,
  baseVersion: number
): Promise<WriteFileResult> {
  return putDesignFile(
    projectId,
    RESOURCES_JSON_PATH,
    JSON.stringify(doc),
    baseVersion
  )
}

/// Triggers a browser download of the generated tokens.css. The endpoint is
/// same-origin (like every other `/api/design/...` call here) and auth is the
/// session cookie `designFetch` already sends — no bearer header to smuggle
/// in — but we still fetch-then-save-as-blob rather than a raw navigation:
/// that keeps the SPA router from ever seeing the URL and guarantees the
/// browser treats it as a download instead of an in-app route change.
export async function exportTokensCss(projectId: number): Promise<void> {
  const res = await designFetch(`/api/design/${projectId}/tokens.css`)
  if (!res.ok) throw new Error(`Could not export tokens.css (${res.status}).`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = "tokens.css"
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

/// Filename fallback when the response's `Content-Disposition` header is
/// absent or unparseable — derived from the route so `/settings` downloads as
/// `settings.html` and the root route downloads as `page.html`.
function fallbackHtmlFilename(route: string): string {
  const slug = route === "/" ? "" : route.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")
  return `${slug || "page"}.html`
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename="?([^";]+)"?/i.exec(header)
  return match ? match[1] : null
}

/// Triggers a browser download of the fully composed standalone page (real
/// divs, no `<ui-*>` primitives, `<!doctype html>` and all) for `route`. Same
/// fetch-then-save-as-blob approach as `exportTokensCss` above — keeps the SPA
/// router out of it and guarantees a download rather than a navigation.
export async function downloadPageHtml(projectId: number, route: string): Promise<void> {
  const res = await designFetch(
    `/api/design/${projectId}/page.html?route=${encodeURIComponent(route)}`
  )
  if (!res.ok) throw new Error(`Could not export page.html (${res.status}).`)
  const blob = await res.blob()
  const filename =
    filenameFromContentDisposition(res.headers.get("content-disposition")) ??
    fallbackHtmlFilename(route)
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

/// Fetches just the expanded body markup for `route` (no doctype/head) so the
/// caller can copy it to the clipboard.
export async function fetchPageHtmlFragment(projectId: number, route: string): Promise<string> {
  const res = await designFetch(
    `/api/design/${projectId}/page.html?route=${encodeURIComponent(route)}&fragment=1`
  )
  if (!res.ok) throw new Error(`Could not load page HTML (${res.status}).`)
  return res.text()
}

export async function fetchDesignComments(
  projectId: number,
  status?: string
): Promise<DesignComment[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await designFetch(`/api/design/${projectId}/comments${query}`)
  if (!res.ok) throw new Error(`Could not load comments (${res.status}).`)
  return readJson(res)
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
  return readJson(res)
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
  return readJson(res)
}

export type DesignAgent = { id: number; display_name: string }

export async function fetchDesignAgents(projectId: number): Promise<DesignAgent[]> {
  const res = await designFetch(`/api/design/${projectId}/agents`)
  if (!res.ok) throw new Error(`Could not list agents (${res.status}).`)
  const body = await readJson<{ agents: DesignAgent[] }>(res)
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
  return readJson(res)
}

/// The project's shared canvas arrangement. The server answers with the default
/// document for a project nobody has arranged, so this never 404s — but it is
/// still normalised, because a stale tab can outlive a schema change.
export async function fetchLayout(projectId: number): Promise<LayoutDoc> {
  const res = await designFetch(`/api/design/${projectId}/layout`)
  if (!res.ok) throw new Error(`Could not load the canvas layout (${res.status}).`)
  return normalizeLayout(await readJson(res))
}

/// Replace the project's arrangement. Last-write-wins on the server.
export async function saveLayout(projectId: number, doc: LayoutDoc): Promise<LayoutDoc> {
  const res = await designFetch(`/api/design/${projectId}/layout`, jsonInit("PUT", doc))
  if (!res.ok) throw new Error(`Could not save the canvas layout (${res.status}).`)
  return normalizeLayout(await readJson(res))
}
