/// Client for the Database tool (#885): the project's data model as agents
/// wrote it and the person edited it. Mirrors `taskflow-db`'s schema_doc.

import { API_BASE_URL, readJson, withBearer } from "@/lib/auth-api"

export type DbAuthor = { kind: "user" | "agent"; id: number; label: string }

export type DbField = {
  name: string
  type: string
  optional?: boolean
  unique?: boolean
  indexed?: boolean
  primary_key?: boolean
  default?: unknown
  values?: string[]
  fk?: { model: string; on_delete?: "cascade" | "set_null" | "restrict" }
  written_by?: DbAuthor
  locked_by_user?: boolean
}

export type DbModel = {
  name: string
  group?: string
  fields: DbField[]
  samples?: Record<string, unknown>[]
}

/// A named, coloured group of models; a model's `group` is its slug. `color`
/// is a theme token id (v3/database/db-groups GROUP_COLORS).
export type DbGroup = { slug: string; name: string; color: string }

export type DbSchemaDoc = { groups?: DbGroup[]; models: DbModel[] }

export type DbSchema = {
  version: number
  doc: DbSchemaDoc
  updated_by: string
  updated_by_label: string
  updated_at: string | null
}

export type DbVersionSummary = {
  version: number
  author: string
  author_label: string
  note: string
  created_at: string | null
}

export const DB_FIELD_TYPES = ["String", "Text", "i64", "f64", "bool", "Date", "DateTime", "Json", "Uuid", "enum", "fk"] as const

/// A save the server refused, with what it said: a stale base (`version_conflict`),
/// broken rules (`invalid_schema`, each problem in `errors`).
export class DbSaveError extends Error {
  readonly code: string
  readonly errors: string[]
  readonly currentVersion?: number
  constructor(message: string, code: string, errors: string[] = [], currentVersion?: number) {
    super(message)
    this.code = code
    this.errors = errors
    this.currentVersion = currentVersion
  }
}

function dbFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, withBearer(init))
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

async function refusal(res: Response): Promise<DbSaveError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    message?: string
    errors?: string[]
    current_version?: number
  }
  return new DbSaveError(
    body.message ?? `The save failed (${res.status}).`,
    body.error ?? String(res.status),
    body.errors ?? [],
    body.current_version,
  )
}

export async function fetchDbSchema(projectId: number): Promise<DbSchema> {
  const res = await dbFetch(`/api/db/${projectId}/schema`)
  if (!res.ok) throw new Error(`Could not load the schema (${res.status}).`)
  return readJson<DbSchema>(res)
}

/// Save the whole document from `baseVersion`. Fields that differ from the
/// current document become yours and locked (the server decides, not this).
export async function saveDbSchema(projectId: number, baseVersion: number, doc: DbSchemaDoc): Promise<DbSchema> {
  const res = await dbFetch(`/api/db/${projectId}/schema`, json("PUT", { base_version: baseVersion, doc }))
  if (!res.ok) throw await refusal(res)
  return readJson<DbSchema>(res)
}

export async function fetchDbVersions(projectId: number): Promise<DbVersionSummary[]> {
  const res = await dbFetch(`/api/db/${projectId}/versions`)
  if (!res.ok) throw new Error(`Could not list versions (${res.status}).`)
  return (await readJson<{ versions: DbVersionSummary[] }>(res)).versions
}

export async function fetchDbVersion(projectId: number, version: number): Promise<DbSchemaDoc> {
  const res = await dbFetch(`/api/db/${projectId}/versions/${version}`)
  if (!res.ok) throw new Error(`Could not read v${version} (${res.status}).`)
  return (await readJson<{ doc: DbSchemaDoc }>(res)).doc
}

export async function restoreDbVersion(projectId: number, version: number, baseVersion: number): Promise<DbSchema> {
  const res = await dbFetch(`/api/db/${projectId}/restore`, json("POST", { version, base_version: baseVersion }))
  if (!res.ok) throw await refusal(res)
  return readJson<DbSchema>(res)
}

export async function fetchDbRoom(projectId: number): Promise<{ channel_id: number; title: string }> {
  const res = await dbFetch(`/api/db/${projectId}/room`)
  if (!res.ok) throw new Error(`Could not open the database room (${res.status}).`)
  return readJson(res)
}
