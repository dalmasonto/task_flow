/// #52: the two policies the account settings form used to decide inline.
///
/// Both live here rather than in `SettingsPage.tsx` because vitest is configured
/// `environment: 'node'` with `include: ['src/**/*.test.ts']` (`vite.config.ts`),
/// so `.tsx` files are never collected — logic left in the component is logic
/// that cannot be regression-tested.

import type { ThemePreference } from "@/lib/theme"

export type UserSettingsDraft = {
  theme: ThemePreference
  email_notifications: boolean
  default_project: number | null
}

/// Whether the Save button has anything to save.
///
/// Theme is deliberately excluded: it persists the moment it is clicked. Batching
/// it behind Save is what caused #52 — a user picked Light, navigated away without
/// saving, and the settings page reasserted the server's `system` on their next
/// visit, dropping them back into dark.
export function settingsDirty(
  draft: UserSettingsDraft,
  loaded: UserSettingsDraft | null,
): boolean {
  if (!loaded) return false
  return (
    draft.email_notifications !== loaded.email_notifications ||
    draft.default_project !== loaded.default_project
  )
}

/// Which theme to apply when the settings request comes back.
///
/// The server normally wins — another device may have changed it and this one
/// should follow. The exception is a theme whose save never landed: we told the
/// user their click would stay applied, so overriding it here would revert their
/// theme on the next visit, which is the original bug on the failure path.
export function themeOnLoad(input: {
  server: ThemePreference
  local: ThemePreference
  syncPending: boolean
}): ThemePreference {
  return input.syncPending ? input.local : input.server
}
