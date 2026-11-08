/// Pure rules for the v3 system states (tested in system-logic.test.ts).
import { useSyncExternalStore } from "react"

/// Did a lazy page's code fail to download? Browsers word it differently:
/// Chrome "Failed to fetch dynamically imported module", Firefox "error loading
/// dynamically imported module", Safari "Importing a module script failed",
/// and Vite's own "Unable to preload CSS".
export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "")
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk \d+ failed/i.test(msg)
}

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb)
  window.addEventListener("offline", cb)
  return () => {
    window.removeEventListener("online", cb)
    window.removeEventListener("offline", cb)
  }
}

/// Live navigator.onLine.
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

/// What the offline banner should say, or null for no banner. The browser
/// knowing it's offline wins; otherwise a live stream that has been
/// reconnecting for a while (not a blip) means the server is unreachable.
export function connectionNotice(online: boolean, realtime: "connecting" | "live" | "reconnecting", reconnectingForMs: number): "offline" | "unreachable" | null {
  if (!online) return "offline"
  if (realtime === "reconnecting" && reconnectingForMs >= 10_000) return "unreachable"
  return null
}
