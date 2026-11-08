/// Pure rules for the v3 project settings pages (tested in project-logic.test.ts).
import type { TaskflowProject, TaskflowProjectApiEndpoint, TaskflowProjectMember } from "@/api/client"
import type { ProjectSettingsPatch } from "@/lib/taskflow-api"

/// What the caller may do here. The server decides (#1137: owner/admin edit,
/// owner archives and deletes); this only decides which controls to offer. A
/// superuser who isn't a member counts as an owner, as the handlers do.
export function projectPowers(me: TaskflowProjectMember | undefined, isSuperuser: boolean): { edit: boolean; owner: boolean } {
  const role = me?.status === "active" ? me.role : isSuperuser ? "owner" : null
  return { edit: role === "owner" || role === "admin", owner: role === "owner" }
}

/// The handler's slug rule: 2 to 120 lowercase letters, digits and dashes,
/// not starting or ending with a dash. Null when fine.
export function slugError(slug: string): string | null {
  // Checked as it will be sent: aboutPatch and the server both lowercase it.
  const s = slug.trim().toLowerCase()
  if (s.length < 2 || s.length > 120) return "2 to 120 characters."
  if (!/^[a-z0-9-]+$/.test(s)) return "Lowercase letters, digits and dashes only."
  if (s.startsWith("-") || s.endsWith("-")) return "Can't start or end with a dash."
  return null
}

export type AboutForm = { name: string; slug: string; description: string }

export function aboutFrom(project: Pick<TaskflowProject, "name" | "slug" | "description_markdown">): AboutForm {
  return { name: project.name, slug: project.slug, description: project.description_markdown ?? "" }
}

/// Only the fields that changed, trimmed the way the server stores them; an
/// empty object means nothing to save.
export function aboutPatch(was: AboutForm, now: AboutForm): ProjectSettingsPatch {
  const out: ProjectSettingsPatch = {}
  if (now.name.trim() !== was.name.trim()) out.name = now.name.trim()
  if (now.slug.trim().toLowerCase() !== was.slug) out.slug = now.slug.trim().toLowerCase()
  if (now.description.trim() !== was.description.trim()) out.description_markdown = now.description.trim()
  return out
}

/// Why the About form can't be saved yet, or null.
export function aboutError(form: AboutForm): string | null {
  if (!form.name.trim()) return "Give the project a name."
  if (form.name.trim().length > 160) return "The name is at most 160 characters."
  if (form.description.length > 4000) return "The description is at most 4000 characters."
  return slugError(form.slug)
}

const ENV_ORDER: Record<TaskflowProjectApiEndpoint["environment"], number> = { production: 0, staging: 1, preview: 2, local: 3 }

/// Default first, then production → local, then by name.
export function sortEndpoints(rows: TaskflowProjectApiEndpoint[]): TaskflowProjectApiEndpoint[] {
  return [...rows].sort((a, b) => Number(b.is_default) - Number(a.is_default) || (ENV_ORDER[a.environment] ?? 9) - (ENV_ORDER[b.environment] ?? 9) || a.label.localeCompare(b.label))
}

/// A local address our server can't reach, so its health means nothing.
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local")
  } catch {
    return false
  }
}

/// "3 environments, default Production" / "None yet".
export function endpointsSummary(rows: TaskflowProjectApiEndpoint[]): string {
  if (!rows.length) return "None yet."
  const def = rows.find((r) => r.is_default)
  return `${rows.length} ${rows.length === 1 ? "environment" : "environments"}${def ? `, default ${def.label}` : ""}.`
}

/// Fold a saved environment into the loaded list. A default row clears every
/// other default, as the server does in the same transaction.
export function upsertEnvironment(rows: TaskflowProjectApiEndpoint[], row: TaskflowProjectApiEndpoint): TaskflowProjectApiEndpoint[] {
  const rest = rows.filter((r) => r.id !== row.id).map((r) => (row.is_default && r.is_default ? { ...r, is_default: false } : r))
  return [...rest, row]
}

/// Apply a delete's answer: the row goes, and `default` (if any) is the only default.
export function removeEnvironment(rows: TaskflowProjectApiEndpoint[], res: { deleted: number; default: number | null }): TaskflowProjectApiEndpoint[] {
  return rows.filter((r) => r.id !== res.deleted).map((r) => (res.default == null ? r : { ...r, is_default: r.id === res.default }))
}

export type EnvironmentForm = { label: string; base_url: string; environment: TaskflowProjectApiEndpoint["environment"]; notes: string }

/// The handler's rules: a name of 1 to 80 characters; an http(s) address of at
/// most 400 with no spaces; notes of at most 1000. Null when fine.
export function environmentFormError(f: EnvironmentForm): string | null {
  const label = f.label.trim()
  if (!label) return "Give it a name."
  if ([...label].length > 80) return "The name is at most 80 characters."
  const url = f.base_url.trim()
  if (!/^https?:\/\//.test(url)) return "The address starts with http:// or https://."
  if (url.length > 400 || /\s/.test(url)) return "An address of at most 400 characters, with no spaces."
  if ([...f.notes.trim()].length > 1000) return "Notes are at most 1000 characters."
  return null
}
