import type { TaskflowUserSettingsTheme } from "@/api/client"

export type ThemePreference = TaskflowUserSettingsTheme

const THEME_STORAGE_KEY = "taskflow.theme"

function prefersDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

/// Resolve a stored preference into the concrete light/dark that should be on
/// the document right now. "system" follows the OS setting.
function resolveDark(preference: ThemePreference) {
  return preference === "dark" || (preference === "system" && prefersDark())
}

/// Apply a theme preference to <html> by toggling the `dark` class that
/// index.css keys its dark variant on (`@custom-variant dark (&:is(.dark *))`).
export function applyTheme(preference: ThemePreference) {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", resolveDark(preference))
}

export function getStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system"
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system"
}

/// Persist the preference and apply it immediately. Persisting lets the
/// bootstrap apply the right theme on the next load before any network call.
export function setThemePreference(preference: ThemePreference) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  }
  applyTheme(preference)
}

/// Apply the stored preference on startup and keep "system" in sync with the OS
/// while the app is open. Call once from the entrypoint. Returns a disposer.
export function bootstrapTheme(): () => void {
  applyTheme(getStoredThemePreference())

  if (typeof window === "undefined") return () => {}
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const onChange = () => {
    if (getStoredThemePreference() === "system") applyTheme("system")
  }
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}
