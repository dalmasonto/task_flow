/// Per-user canvas viewport state, in Dexie (IndexedDB).
///
/// This is the "what am I looking at right now" half of the design state split:
/// open pages, selected devices, zoom/pan, tool, panel tab, preview theme. It is
/// per-user and per-browser on purpose — none of it is a fact about the project.
/// The SHARED half (which arrangement, how pages are grouped) lives on the
/// server as a `design_layout` row; see `design-layout.ts`.
///
/// Keyed `[userId, projectId]` rather than by project alone: IndexedDB is per
/// browser profile, so two accounts signing in on the same machine would
/// otherwise inherit each other's canvas.
///
/// Lives in `pages/design/` rather than `lib/` so it can take the zoom bounds
/// straight from `design-canvas`, the same way `canvas-view.ts` does.

import Dexie, { type Table } from "dexie"

import { DEVICE_PRESETS, DEFAULT_DEVICE_ID } from "@/lib/design-devices"
import { MAX_SCALE, MIN_SCALE, type CanvasTransform } from "./design-canvas"
import { type CanvasTool } from "./canvas-tools"
import { type DesignTab } from "./design-tabs"

export type DesignUIState = {
  userId: number
  projectId: number
  openRoutes: string[]
  deviceIds: string[]
  transform: CanvasTransform
  canvasTool: CanvasTool
  rightTab: DesignTab
  theme: string
  updatedAt: number
}

/// The row identity: this user, in this project.
export type DesignUIKey = [number, number]

const TOOLS: CanvasTool[] = ["select", "pan"]
const TABS: DesignTab[] = ["inspect", "components", "tokens", "pages"]
const DEVICE_IDS = new Set(DEVICE_PRESETS.map((d) => d.id))

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback

/// Tolerant parse. Returns null when the record is too damaged to trust, so the
/// caller seeds a fresh one instead of hydrating a half-state.
///
/// Every field is clamped or defaulted rather than rejected: a record written by
/// another build (or edited by hand in devtools) must degrade to something
/// renderable, because the alternative is a canvas stuck at an impossible zoom
/// with no UI to fix it.
export function parseUIState(raw: unknown, userId: number, projectId: number): DesignUIState | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>

  const openRoutes = asStrings(obj.openRoutes)
  const deviceIds = asStrings(obj.deviceIds).filter((id) => DEVICE_IDS.has(id))
  if (!deviceIds.length) deviceIds.push(DEFAULT_DEVICE_ID)

  const t = (obj.transform ?? {}) as Record<string, unknown>
  const transform: CanvasTransform = {
    x: num(t.x, 40),
    y: num(t.y, 40),
    // Clamped, not merely defaulted: a stale scale is the one field that can
    // make the canvas unreadable.
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, num(t.scale, 0.6))),
  }

  const canvasTool = TOOLS.includes(obj.canvasTool as CanvasTool)
    ? (obj.canvasTool as CanvasTool)
    : "select"
  const rightTab = TABS.includes(obj.rightTab as DesignTab) ? (obj.rightTab as DesignTab) : "pages"
  const theme = typeof obj.theme === "string" ? obj.theme : "light"

  return {
    userId,
    projectId,
    openRoutes,
    deviceIds,
    transform,
    canvasTool,
    rightTab,
    theme,
    updatedAt: num(obj.updatedAt, Date.now()),
  }
}

/// One table. The compound key is what makes "this user in this project" the
/// identity, so a second project starts clean.
///
/// `Table<DesignUIState, DesignUIKey>` rather than the usual
/// `EntityTable<T, "userId">` umbrella: `EntityTable<T, "userId" | "projectId">`
/// distributes that union of prop names to `number`, so it would type the key as
/// a bare id and let `get(4)` compile against a table whose real key is the pair.
const db = new Dexie("taskflow_design_ui") as Dexie & {
  canvas: Table<DesignUIState, DesignUIKey>
}
db.version(1).stores({ canvas: "[userId+projectId]" })

export { db }

export async function readUIState(
  userId: number,
  projectId: number,
): Promise<DesignUIState | null> {
  try {
    const row = await db.canvas.get([userId, projectId])
    return row ? parseUIState(row, userId, projectId) : null
  } catch {
    // IndexedDB can be unavailable (private window, blocked site data). A
    // canvas that works but forgets is strictly better than one that throws.
    return null
  }
}

export async function writeUIState(state: DesignUIState): Promise<void> {
  try {
    await db.canvas.put({ ...state, updatedAt: Date.now() })
  } catch {
    // Losing a viewport is not worth surfacing.
  }
}
