/// The design surface's persistent cache (#665), in IndexedDB via Dexie.
///
/// WHAT IS CACHED, and why each half pays for itself:
///
/// - **Manifests** — the pages panel, canvas layout and snapshot stamps all
///   come from the manifest, and at 500 files it is the one document that
///   makes opening the design page wait on the network. Painted from cache
///   first, replaced when the server answers (see `DesignSurfacePage`'s load
///   effect), so a revisit is instant and then revalidates.
/// - **Board snapshots** — images of rendered pages, so a board without a live
///   iframe still shows its content (`design-snapshots.ts` owns the store; the
///   rows live here so both tables share ONE database and one eviction story).
///
/// The metadata table is separate from the blobs ON PURPOSE: eviction decisions
/// need every row's size and last use, and reading `snapshots` for that would
/// load up to the whole cache (150 MB) just to choose what to drop.
///
/// FAILURE IS ALWAYS SOFT. IndexedDB is absent in private windows, can be
/// blocked by site-data policy, and can throw for quota at the worst moment.
/// Nothing here throws: a miss, a refusal or a closed database reads as "no
/// cache", which the callers already handle — the cache is an optimization,
/// never a dependency.

import Dexie, { type Table } from "dexie"

import type { DesignManifest } from "@/lib/design-api"

export type ManifestCacheRow = {
  project: number
  revision: number
  savedAt: number
  manifest: DesignManifest
}

export type SnapshotMetaRow = {
  key: string
  project: number
  route: string
  device: string
  theme: string
  stamp: string
  bytes: number
  lastUsedAt: number
}

export type SnapshotRow = SnapshotMetaRow & { blob: Blob }

type CacheDb = Dexie & {
  manifests: Table<ManifestCacheRow, number>
  snapshotMeta: Table<SnapshotMetaRow, string>
  snapshots: Table<SnapshotRow, string>
}

let opened: CacheDb | null | undefined

/// The database, opened once and never closed. `null` when IndexedDB is
/// unusable — construction itself can throw in a locked-down browser, which is
/// exactly the case the lazy open exists for (importing this module must never
/// fail).
export function cacheDb(): CacheDb | null {
  if (opened !== undefined) return opened
  try {
    const db = new Dexie("taskflow_design_cache") as CacheDb
    db.version(1).stores({
      manifests: "project",
      // `snapshotMeta` carries the eviction fields (see the header);
      // `snapshots` is the blobs, keyed identically.
      snapshotMeta: "key, project, lastUsedAt",
      snapshots: "key",
    })
    opened = db
  } catch {
    opened = null
  }
  return opened
}

export async function readCachedManifest(project: number): Promise<ManifestCacheRow | null> {
  try {
    const db = cacheDb()
    if (!db) return null
    const row = await db.manifests.get(project)
    // A row from another project (impossible via the key, but cheap to check)
    // or a damaged one reads as a miss.
    return row && row.project === project && row.manifest ? row : null
  } catch {
    return null
  }
}

export async function writeCachedManifest(
  project: number,
  revision: number,
  manifest: DesignManifest,
): Promise<void> {
  try {
    await cacheDb()?.manifests.put({ project, revision, savedAt: Date.now(), manifest })
  } catch {
    // A manifest that cannot be cached is a slower next visit, nothing more.
  }
}

export async function readSnapshotMeta(project: number): Promise<SnapshotMetaRow[]> {
  try {
    return (await cacheDb()?.snapshotMeta.where("project").equals(project).toArray()) ?? []
  } catch {
    return []
  }
}

export async function readSnapshotRow(key: string): Promise<SnapshotRow | null> {
  try {
    return (await cacheDb()?.snapshots.get(key)) ?? null
  } catch {
    return null
  }
}

export async function writeSnapshotRow(row: SnapshotRow): Promise<void> {
  const db = cacheDb()
  if (!db) return
  try {
    // Both tables in one transaction so eviction bookkeeping cannot drift from
    // the blobs it describes.
    await db.transaction("rw", db.snapshots, db.snapshotMeta, async () => {
      await db.snapshots.put(row)
      const { blob: _blob, ...meta } = row
      await db.snapshotMeta.put(meta)
    })
  } catch {
    // Out of quota or a closed database: the snapshot still lives in memory.
  }
}

export async function touchSnapshotMeta(key: string, lastUsedAt: number): Promise<void> {
  try {
    await cacheDb()?.snapshotMeta.update(key, { lastUsedAt })
  } catch {
    // LRU precision is not worth surfacing.
  }
}

export async function deleteSnapshotRows(keys: readonly string[]): Promise<void> {
  const db = cacheDb()
  if (!db || keys.length === 0) return
  try {
    await db.transaction("rw", db.snapshots, db.snapshotMeta, async () => {
      await db.snapshots.bulkDelete([...keys])
      await db.snapshotMeta.bulkDelete([...keys])
    })
  } catch {
    // The rows outlive the memory they occupied; eviction will find them again.
  }
}
