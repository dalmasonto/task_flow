/// Site-wide, per-user preferences that must outlive a page load.
///
/// Today that is one thing: the project the user last CHOSE. The summary comes
/// back ordered by name, and the active project is resolved from list position
/// when nothing else is remembered — so every reload dropped the user back onto
/// whichever project sorted first. The user's ask: "create a new config table
/// for the website to track default project at least, and watch that it's only
/// selected once".
///
/// WHY ITS OWN DATABASE, rather than a `config` table added to the existing
/// `taskflow_design_ui` DB:
///
/// - That DB's own doc comment scopes it to "per-user AND per-project design
///   viewport state" and it lives in `pages/design/`, next to the canvas whose
///   zoom bounds it takes. A site-wide default is neither per-project nor about
///   the design page; reaching it would mean `lib/` importing from `pages/design/`
///   and would tie a site-wide setting's lifetime to the design schema's.
/// - Separate stores also fail separately. This is rebuildable state either way
///   (see the read/write comments below), but a design-schema migration gone
///   wrong should not take the app's remembered project with it.
/// - IndexedDB connections are opened lazily on first query, not at import, so
///   the second database costs nothing until a preference is actually read.
///
/// The version declaration below is NOT optional: a table that is never declared
/// in `stores()` silently does not exist, and every read would answer "no
/// preference" forever, which is indistinguishable from the bug this file fixes.
/// Bumping `version(1)` to `version(2)` is what an *added* table would need on an
/// already-shipped DB.

import Dexie, { type Table } from "dexie"

export type SiteConfig = {
  userId: number
  defaultProjectId: string | null
  updatedAt: number
}

/// One row per user — the key is the whole identity, so two accounts signing in
/// on the same browser profile cannot inherit each other's choice.
const db = new Dexie("taskflow_site_config") as Dexie & {
  config: Table<SiteConfig, number>
}
db.version(1).stores({ config: "userId" })

export { db }

/// Tolerant parse. `defaultProjectId` is kept only when it is a non-empty
/// string: the id type is `string` everywhere on the client (`Project.id` in
/// lib/workspace-view), and a number here — the API's own id shape — would never
/// match a project in the list, i.e. it would act like "no preference" and put
/// the user back on list order. `null` is a legitimate stored value (nothing
/// chosen yet), so it is not an error.
export function parseSiteConfig(raw: unknown, userId: number): SiteConfig | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const stored = obj.defaultProjectId
  return {
    userId,
    defaultProjectId: typeof stored === "string" && stored ? stored : null,
    updatedAt: typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now(),
  }
}

const isUserId = (userId: unknown): userId is number =>
  typeof userId === "number" && Number.isFinite(userId)

/// The user's own choice, or null when there is none to honour (never chosen,
/// signed out, storage unavailable). `null` is what makes
/// `resolveActiveProject` fall through to list order, so every failure mode here
/// degrades to the pre-existing behaviour rather than to a wrong project.
export async function readDefaultProjectId(userId: number): Promise<string | null> {
  if (!isUserId(userId)) return null
  try {
    const row = await db.config.get(userId)
    return parseSiteConfig(row, userId)?.defaultProjectId ?? null
  } catch {
    // IndexedDB can be unavailable (private window, blocked site data, a
    // version conflict from another tab). An app that works but forgets is
    // strictly better than one that throws on boot.
    return null
  }
}

/// Called ONLY when the user makes the choice — clicking a project in the
/// sidebar, creating one, or following a task ref into another project. Never
/// from the resolver: a resolver that wrote whatever it landed on would persist
/// the very list-order accidents this file exists to stop, and the next reload
/// would faithfully restore them.
export async function writeDefaultProjectId(userId: number, projectId: string): Promise<void> {
  if (!isUserId(userId)) return
  if (typeof projectId !== "string" || !projectId) return
  try {
    await db.config.put({ userId, defaultProjectId: projectId, updatedAt: Date.now() })
  } catch {
    // Losing a preference costs the user one click. Not worth surfacing.
  }
}
