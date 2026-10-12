/// Board snapshots (#665): the image a board shows when it does not have a
/// live iframe, cached per `(project, route, device, theme)` under a version
/// stamp.
///
/// WHY IMAGES AT ALL. The canvas keeps at most `canvas-live.ts`'s budget of
/// live iframes; every other board — off-screen, or anywhere on a zoomed-out
/// canvas — has no document to show. A board-shaped hole is not an option
/// (comparing screens is the product), so the hole is filled with the last
/// picture of that board, revalidated by version rather than by eye.
///
/// WHERE A PICTURE COMES FROM. Not a screenshot of the live iframe: it is
/// cross-origin, so this document can never read its pixels. Instead the same
/// protocol the export uses (`export-run.ts`'s `capturePage`) loads the route
/// in a hidden iframe at the device's viewport and asks the PAGE to picture
/// itself, which is the one document allowed to. That is a full page load, so
/// captures are queued (one at a time), capped, and skipped for boards nobody
/// is looking at.
///
/// WHEN A PICTURE IS STALE, stated exactly, because a stale snapshot is worse
/// than none — it looks real:
/// - The stamp comes from the manifest's versions (`routeVisualStamps`: the
///   route's file, the two style documents, and the components the route uses)
///   and a snapshot is only ever REUSED under an identical stamp. A change
///   made while this browser was away moves the stamp, so the stale image is
///   dropped on the next visit rather than shown.
/// - A change made while this browser is WATCHING arrives on the realtime
///   feed, and `invalidateRoutes` drops the affected snapshots then — no stamp
///   arithmetic needed, and no window where a just-written page shows its old
///   picture.
/// - A stamp containing `UNKNOWN_STAMP` means the backend did not supply the
///   versions (an older deploy). Nothing is reused and nothing is persisted:
///   the snapshot is still taken and shown for this session, because seeing
///   the board beats seeing a placeholder, but it is never trusted across a
///   reload.

import { useEffect, useState } from "react"

import type { DesignManifest } from "@/lib/design-api"
import { deviceById } from "@/lib/design-devices"

import {
  deleteSnapshotRows,
  readSnapshotMeta,
  readSnapshotRow,
  touchSnapshotMeta,
  writeSnapshotRow,
  type SnapshotMetaRow,
} from "./design-cache"

/// A version the backend did not supply. See the header: it makes a snapshot
/// unusable across reloads, deliberately.
export const UNKNOWN_STAMP = "?"

export function stampIsTrustworthy(stamp: string): boolean {
  return !stamp.includes(UNKNOWN_STAMP)
}

const versionPart = (value: number | undefined): string =>
  typeof value === "number" ? String(value) : UNKNOWN_STAMP

/// Per-route version stamps: everything whose change alters what that route
/// renders. Same shape for every route, so two stamps compare with `===`.
export function routeVisualStamps(manifest: DesignManifest): Map<string, string> {
  const tokens = versionPart(manifest.tokensVersion)
  const resources = versionPart(manifest.resourcesVersion)
  const componentsByRoute = new Map<string, string[]>()
  for (const component of manifest.components) {
    const tag = `${component.name}@${versionPart(component.version)}`
    for (const route of component.usedOn) {
      const list = componentsByRoute.get(route)
      if (list) list.push(tag)
      else componentsByRoute.set(route, [tag])
    }
  }
  const stamps = new Map<string, string>()
  for (const route of manifest.routes) {
    const components = (componentsByRoute.get(route.path) ?? []).sort().join(",")
    stamps.set(route.path, `${versionPart(route.version)}|${tokens}|${resources}|${components}`)
  }
  return stamps
}

export function snapshotKey(
  project: number,
  route: string,
  device: string,
  theme: string,
): string {
  return `${project}|${route}|${device}|${theme}`
}

export type CacheRow = { key: string; bytes: number; lastUsedAt: number }

/// Which rows must go so that `incomingBytes` fits under `capBytes`: the
/// least-recently-used first, only as many as are needed. Pure so the policy
/// is testable — an eviction that drops too MUCH throws away pictures the
/// user will pay to re-render, and one that drops too little grows the cache
/// past what the browser will keep.
export function evictFor(
  rows: readonly CacheRow[],
  incomingBytes: number,
  capBytes: number,
): string[] {
  let total = rows.reduce((sum, row) => sum + row.bytes, 0)
  if (total + incomingBytes <= capBytes) return []
  const oldestFirst = [...rows].sort(
    (a, b) => a.lastUsedAt - b.lastUsedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  const evicted: string[] = []
  for (const row of oldestFirst) {
    if (total + incomingBytes <= capBytes) break
    evicted.push(row.key)
    total -= row.bytes
  }
  return evicted
}

// --- tuning -----------------------------------------------------------------

/// How much snapshot data IndexedDB may hold, in bytes. Big enough for
/// hundreds of boards, small enough that a browser under storage pressure does
/// not evict the whole origin. The owner asked for LRU eviction in the
/// 100–200 MB range; this is the middle of it.
export const SNAPSHOT_CACHE_BYTES = 150 * 1024 * 1024

/// How many blob URLs may stay alive at once. Object URLs pin their bytes for
/// the life of the document, so this is the RAM bound; it is a COUNT because
/// the URLs' sizes are not tracked cheaply, and snapshots are all the same
/// order of magnitude.
export const SNAPSHOT_URL_LIMIT = 120

/// How many captures may wait in the queue. Beyond this the board stops asking:
/// a hundred pending page loads is a machine that will not finish them, and
/// the pictures fill in as the user actually goes somewhere.
export const CAPTURE_QUEUE_LIMIT = 24

/// Captured images are downscaled to this width before storing. At a 35% zoom
/// a board is ~450 px wide on screen, so 900 keeps it crisp at 2× and costs a
/// fraction of the raw 2× device-width PNG.
const SNAPSHOT_MAX_WIDTH = 900

/// How long a failed capture is left alone before that board may ask again.
/// Without this, a board that cannot render (a route that 500s, a sandbox
/// refusal) would re-request on every pan.
const RETRY_AFTER_MS = 5 * 60_000
const CAPTURE_TIMEOUT_MS = 30_000

// --- the store --------------------------------------------------------------

type MemoryEntry = { url: string; stamp: string; bytes: number; lastUsedAt: number }

const urls = new Map<string, MemoryEntry>()
const failedAt = new Map<string, number>()
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A subscriber's failure is its own problem, not the store's.
    }
  }
}

export function subscribeSnapshots(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/// The cached URL for a key at a given stamp, or null. Synchronous and cheap:
/// it is what a board asks during render.
export function snapshotUrlFor(key: string, stamp: string): string | null {
  const entry = urls.get(key)
  if (!entry || entry.stamp !== stamp) return null
  entry.lastUsedAt = Date.now()
  return entry.url
}

function remember(key: string, stamp: string, url: string, bytes: number): void {
  const previous = urls.get(key)
  if (previous) URL.revokeObjectURL(previous.url)
  urls.set(key, { url, stamp, bytes, lastUsedAt: Date.now() })
  // Count-bound LRU: drop the oldest URL (and its bytes) once past the limit.
  while (urls.size > SNAPSHOT_URL_LIMIT) {
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, entry] of urls) {
      if (entry.lastUsedAt < oldest) {
        oldest = entry.lastUsedAt
        oldestKey = k
      }
    }
    if (oldestKey === null) break
    const gone = urls.get(oldestKey)
    if (gone) URL.revokeObjectURL(gone.url)
    urls.delete(oldestKey)
  }
}

function forget(key: string): void {
  const entry = urls.get(key)
  if (entry) URL.revokeObjectURL(entry.url)
  urls.delete(key)
}

/// Load a snapshot from IndexedDB into memory when its stamp still matches.
/// Resolves either way; the caller re-reads `snapshotUrlFor`.
export async function hydrateSnapshot(key: string, stamp: string): Promise<void> {
  if (urls.has(key)) return
  const row = await readSnapshotRow(key)
  if (!row || row.stamp !== stamp || !row.blob) return
  try {
    remember(key, stamp, URL.createObjectURL(row.blob), row.bytes)
    void touchSnapshotMeta(key, Date.now())
  } catch {
    // A browser that cannot mint object URLs has no snapshot display; the
    // placeholder stays up, which is the same failure mode as no cache.
    return
  }
  notify()
}

/// Drop every snapshot of the given routes (or of the whole project, when
/// `routes` is null) — memory now, IndexedDB in the background. Called from
/// the realtime feed the moment a design file changes.
export function invalidateRoutes(project: number, routes: readonly string[] | null): void {
  const prefix = `${project}|`
  const doomed: string[] = []
  for (const [key, entry] of urls) {
    if (!key.startsWith(prefix)) continue
    if (routes === null || routes.some((route) => key.startsWith(`${project}|${route}|`))) {
      URL.revokeObjectURL(entry.url)
      doomed.push(key)
    }
  }
  for (const key of doomed) urls.delete(key)
  if (doomed.length > 0) notify()
  void (async () => {
    const metas = await readSnapshotMeta(project)
    const stale = metas.filter(
      (meta) => routes === null || routes.some((route) => meta.route === route),
    )
    await deleteSnapshotRows(stale.map((meta) => meta.key))
  })()
}

// --- capture ----------------------------------------------------------------

export type SnapshotRequest = {
  project: number
  route: string
  device: string
  theme: string
  stamp: string
  getSandboxToken: () => Promise<string>
}

const queue: SnapshotRequest[] = []
const inFlight = new Set<string>()
let capturing = false

/// Ask for a snapshot of a board. Cheap and non-blocking: repeats of the same
/// key coalesce, failures back off, and the queue itself is capped.
export function requestSnapshot(request: SnapshotRequest): void {
  const key = snapshotKey(request.project, request.route, request.device, request.theme)
  if (inFlight.has(key) || queue.some((r) => snapshotKey(r.project, r.route, r.device, r.theme) === key)) {
    return
  }
  const failed = failedAt.get(key)
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return
  if (queue.length >= CAPTURE_QUEUE_LIMIT) return
  queue.push(request)
  void drainQueue()
}

async function drainQueue(): Promise<void> {
  if (capturing) return
  capturing = true
  try {
    while (queue.length > 0) {
      const request = queue.shift()!
      const key = snapshotKey(request.project, request.route, request.device, request.theme)
      inFlight.add(key)
      try {
        await captureAndStore(request, key)
        failedAt.delete(key)
      } catch {
        failedAt.set(key, Date.now())
      } finally {
        inFlight.delete(key)
      }
    }
  } finally {
    capturing = false
  }
}

async function captureAndStore(request: SnapshotRequest, key: string): Promise<void> {
  // Dynamic on purpose: `export-run` pulls the zip/PDF/screenshot stack, which
  // has no business in the main bundle for a feature that may never fire.
  const { capturePage } = await import("./export/export-run")
  const device = deviceById(request.device)
  if (!device) throw new Error(`unknown device ${request.device}`)
  const picture = await withTimeout(
    capturePage(request.route, {
      device,
      projectId: request.project,
      getSandboxToken: request.getSandboxToken,
      theme: request.theme,
      appearance: null,
      // Frameless: the canvas draws the device chrome itself, and a snapshot
      // of a dressed board would double it.
      dress: { kind: "none" },
      fullPage: false,
    }),
    CAPTURE_TIMEOUT_MS,
  )
  const blob = await toSnapshotBlob(picture.dataUrl)
  if (blob.size === 0) throw new Error("empty snapshot")
  remember(key, request.stamp, URL.createObjectURL(blob), blob.size)
  notify()
  if (!stampIsTrustworthy(request.stamp)) return
  const existing = await readSnapshotMeta(request.project)
  const evicted = evictFor(
    existing.filter((row) => row.key !== key),
    blob.size,
    SNAPSHOT_CACHE_BYTES,
  )
  await deleteSnapshotRows(evicted)
  for (const evictedKey of evicted) forget(evictedKey)
  await writeSnapshotRow({
    key,
    project: request.project,
    route: request.route,
    device: request.device,
    theme: request.theme,
    stamp: request.stamp,
    bytes: blob.size,
    lastUsedAt: Date.now(),
    blob,
  })
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("snapshot capture timed out")), ms)
    work.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/// Decode the captured PNG and re-encode it at up to `SNAPSHOT_MAX_WIDTH`.
/// The extra round trip is what keeps hundreds of snapshots inside a sane
/// storage budget: a 2× laptop capture is multi-megabyte, and at the sizes a
/// cold board is ever displayed at, almost none of that is visible.
async function toSnapshotBlob(dataUrl: string): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("snapshot is not decodable"))
    img.src = dataUrl
  })
  const scale = Math.min(1, SNAPSHOT_MAX_WIDTH / image.naturalWidth)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("could not encode the snapshot"))),
      "image/png",
    )
  })
}

/// Test-only view of the memory LRU's size. Not exported to the app.
export function snapshotMemoryCount(): number {
  return urls.size
}

// --- the hook ---------------------------------------------------------------

export type BoardSnapshotInput = {
  project: number
  route: string
  device: string
  theme: string
  /** The route's stamp from `routeVisualStamps`. */
  stamp: string
  /** True while the board is somewhere a human can see it — the promise that
   *  a capture nobody asked for is not holding the queue. */
  wanted: boolean
  getSandboxToken: () => Promise<string>
}

/// The snapshot URL for one board, or null. Hydrates from IndexedDB on mount
/// and re-renders when the store changes under this key.
export function useBoardSnapshot(input: BoardSnapshotInput): string | null {
  const { project, route, device, theme, stamp, wanted } = input
  const key = snapshotKey(project, route, device, theme)
  const getTokenRef = useLatest(input.getSandboxToken)
  const [url, setUrl] = useState<string | null>(() => snapshotUrlFor(key, stamp))

  useEffect(() => {
    let cancelled = false
    const sync = () => {
      if (!cancelled) setUrl(snapshotUrlFor(key, stamp))
    }
    sync()
    const unsubscribe = subscribeSnapshots(sync)
    void hydrateSnapshot(key, stamp).then(() => {
      if (cancelled) return
      const hydrated = snapshotUrlFor(key, stamp)
      if (hydrated) {
        setUrl(hydrated)
        return
      }
      if (wanted) {
        requestSnapshot({ project, route, device, theme, stamp, getSandboxToken: () => getTokenRef.current() })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [key, stamp, wanted, project, route, device, theme, getTokenRef])

  return url
}

/// A ref that always holds the latest value — the hook's effects must not
/// re-run (and re-enqueue) because an inline callback changed identity.
function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }))
  ref.current = value
  return ref
}

/// Test-only: the meta rows a store would consider for eviction. Exported so
/// `evictFor`'s call site stays honest about where its input comes from.
export type { SnapshotMetaRow }
