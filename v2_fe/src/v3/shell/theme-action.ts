/// Switch light/dark from anywhere in v3 (the palette's "Switch theme"), the
/// same way Settings does: apply now, remember on this device, and save to the
/// account. A failed save leaves the local choice flagged as newer, so the next
/// load doesn't snap back to the server's older value.
import { useSyncExternalStore } from "react"

import { updateUserSettings } from "@/lib/taskflow-api"
import { setThemePreference, setThemeSyncPending } from "@/lib/theme"

export function isDarkNow(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
}

export async function toggleTheme(): Promise<void> {
  // An explicit choice, even if the stored preference was "system".
  const next = isDarkNow() ? "light" : "dark"
  setThemePreference(next)
  setThemeSyncPending(true)
  try {
    await updateUserSettings({ theme: next })
    setThemeSyncPending(false)
  } catch {
    // Applied on this device; it reaches the account on the next successful save.
  }
}

function subscribeToThemeClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

/// Live "is dark mode on", following the `dark` class on <html> however it
/// changes (Settings, the palette, the OS while on "system").
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeToThemeClass, isDarkNow, () => false)
}
