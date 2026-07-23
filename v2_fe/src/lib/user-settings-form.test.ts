import { describe, it, expect } from "vitest"
import { settingsDirty, themeOnLoad } from "./user-settings-form"
import type { UserSettingsDraft } from "./user-settings-form"

/// A saved baseline; each test knocks out the one field it cares about.
function draft(overrides: Partial<UserSettingsDraft> = {}): UserSettingsDraft {
  return {
    theme: "system",
    email_notifications: true,
    default_project: 2,
    ...overrides,
  }
}

describe("settingsDirty", () => {
  it("is false when nothing has changed", () => {
    expect(settingsDirty(draft(), draft())).toBe(false)
  })

  it("is false when there is no saved baseline yet", () => {
    expect(settingsDirty(draft(), null)).toBe(false)
  })

  it("is true when email notifications changed", () => {
    expect(settingsDirty(draft({ email_notifications: false }), draft())).toBe(true)
  })

  it("is true when the default project changed", () => {
    expect(settingsDirty(draft({ default_project: 7 }), draft())).toBe(true)
  })

  // #52 REGRESSION GUARD. Theme persists the moment it is clicked, so it is never
  // a pending change. Treating it as one is precisely what let the settings page
  // revert an unsaved theme on the user's next visit.
  it("ignores theme — it saves immediately and is never an unsaved change", () => {
    expect(settingsDirty(draft({ theme: "light" }), draft())).toBe(false)
  })

  it("still reports a real change when theme differs alongside it", () => {
    expect(settingsDirty(draft({ theme: "light", default_project: 7 }), draft())).toBe(true)
  })
})

describe("themeOnLoad", () => {
  it("takes the server theme when the local copy is in sync", () => {
    expect(themeOnLoad({ server: "dark", local: "dark", syncPending: false })).toBe("dark")
  })

  // The server is authoritative for a synced client: another device may have
  // changed it, and this one should follow.
  it("takes the server theme even when local disagrees, if no save is pending", () => {
    expect(themeOnLoad({ server: "dark", local: "light", syncPending: false })).toBe("dark")
  })

  // #52: we promised the user their click stays applied when the save fails.
  // Letting the server win here would revert their theme on the next visit —
  // the original bug, narrowed to the failure path.
  it("keeps the local theme when an earlier save never reached the server", () => {
    expect(themeOnLoad({ server: "system", local: "light", syncPending: true })).toBe("light")
  })

  it("falls back to the server theme once the pending save has cleared", () => {
    expect(themeOnLoad({ server: "system", local: "light", syncPending: false })).toBe("system")
  })
})
