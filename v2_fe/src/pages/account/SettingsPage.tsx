import * as React from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  setThemePreference,
  getStoredThemePreference,
  getThemeSyncPending,
  setThemeSyncPending,
} from "@/lib/theme"
import { settingsDirty, themeOnLoad } from "@/lib/user-settings-form"
import { fetchGithubMe, fetchUserSettings, githubConnectUrl, updateUserSettings } from "@/lib/taskflow-api"
import type { TaskflowUserSettings, TaskflowUserSettingsTheme } from "@/api/client"
import { CheckIcon } from "lucide-react"
import { AccountPageHeader } from "./AccountLayout"

type ProjectName = { id: number; name: string }

const NO_DEFAULT_PROJECT = "none"

const themeOptions: { value: TaskflowUserSettingsTheme; label: string; hint: string }[] = [
  { value: "light", label: "Light", hint: "Always use the light theme" },
  { value: "dark", label: "Dark", hint: "Always use the dark theme" },
  { value: "system", label: "System", hint: "Match your operating system" },
]

export function SettingsPage({ projects }: { projects: ProjectName[] }) {
  const [loaded, setLoaded] = React.useState<TaskflowUserSettings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [theme, setTheme] = React.useState<TaskflowUserSettingsTheme>("system")
  const [emailNotifications, setEmailNotifications] = React.useState(true)
  const [defaultProject, setDefaultProject] = React.useState<number | null>(null)
  const [status, setStatus] = React.useState<"idle" | "saving" | "saved">("idle")
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [githubConnected, setGithubConnected] = React.useState<boolean | null>(null)
  const [githubJustConnected, setGithubJustConnected] = React.useState(false)
  const [themeError, setThemeError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("github") === "connected") setGithubJustConnected(true)
    let active = true
    void fetchGithubMe()
      .then((result) => {
        if (active) setGithubConnected(result.connected)
      })
      .catch(() => {
        if (active) setGithubConnected(false)
      })
    return () => {
      active = false
    }
  }, [])

  React.useEffect(() => {
    let active = true
    void (async () => {
      setLoadError(null)
      try {
        const settings = await fetchUserSettings()
        if (!active) return
        setLoaded(settings)
        setEmailNotifications(settings.email_notifications)
        setDefaultProject(settings.default_project)
        // #52: the server is authoritative *unless* this device still holds a
        // theme whose save never landed. Blindly applying the server value here
        // is what used to flip an unsaved "Light" back to dark on arrival.
        const applied = themeOnLoad({
          server: settings.theme,
          local: getStoredThemePreference(),
          syncPending: getThemeSyncPending(),
        })
        setTheme(applied)
        setThemePreference(applied)
      } catch (err) {
        if (!active) return
        setLoadError(err instanceof Error ? err.message : "Could not load your settings.")
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const dirty = settingsDirty(
    { theme, email_notifications: emailNotifications, default_project: defaultProject },
    loaded,
  )

  // #52: theme is not part of the Save batch. It applies AND persists to the
  // account in the same gesture, which is what the page has always claimed.
  async function onThemeChange(next: TaskflowUserSettingsTheme) {
    setTheme(next)
    setThemeError(null)
    setThemePreference(next)
    // Marked before the request so a failure (or a reload mid-flight) leaves the
    // local choice flagged as newer than the server.
    setThemeSyncPending(true)
    try {
      const saved = await updateUserSettings({ theme: next })
      setLoaded((prev) => (prev ? { ...prev, theme: saved.theme } : saved))
      setThemeSyncPending(false)
    } catch (err) {
      // Keep the click applied and say plainly that it did not reach the account.
      setThemeError(
        err instanceof Error
          ? `Theme applied on this device, but not saved to your account: ${err.message}`
          : "Theme applied on this device, but could not be saved to your account.",
      )
    }
  }

  async function onSave() {
    if (!dirty) return
    setStatus("saving")
    setSaveError(null)
    try {
      const saved = await updateUserSettings({
        theme,
        email_notifications: emailNotifications,
        default_project: defaultProject,
      })
      setLoaded(saved)
      setTheme(saved.theme)
      setEmailNotifications(saved.email_notifications)
      setDefaultProject(saved.default_project)
      setThemePreference(saved.theme)
      // Save carries the current theme too, so it doubles as a retry for a
      // theme change that failed to sync earlier.
      setThemeSyncPending(false)
      setThemeError(null)
      setStatus("saved")
    } catch (err) {
      setStatus("idle")
      setSaveError(err instanceof Error ? err.message : "Could not save your settings.")
    }
  }

  // Theme is intentionally untouched: it is already saved, so it is not one of
  // the pending changes this button discards.
  function onReset() {
    if (!loaded) return
    setEmailNotifications(loaded.email_notifications)
    setDefaultProject(loaded.default_project)
    setStatus("idle")
    setSaveError(null)
  }

  return (
    <div className="space-y-5">
      <AccountPageHeader
        eyebrow="Account"
        title="Settings"
        description="Preferences stored against your account. Theme applies and saves immediately; other changes save when you hit Save."
      />

      {loadError ? (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            {loadError}
          </p>
        </div>
      ) : loaded === null ? (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      ) : (
        <>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Appearance</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose how TaskFlow looks. Saved to your account as soon as you pick one — no need to hit Save.</p>
            {themeError ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                {themeError}
              </p>
            ) : null}
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onThemeChange(option.value)}
                  aria-pressed={theme === option.value}
                  className={cn(
                    "rounded-lg border p-3 text-left transition",
                    theme === option.value
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "hover:bg-muted"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{option.label}</span>
                    {theme === option.value ? <CheckIcon className="size-4 text-primary" /> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{option.hint}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <div className="mt-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Email notifications</p>
                <p className="text-xs text-muted-foreground">Receive email about invitations and project activity.</p>
              </div>
              <ToggleSwitch
                checked={emailNotifications}
                onChange={(next) => {
                  setEmailNotifications(next)
                  setStatus("idle")
                }}
                label="Email notifications"
              />
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Default project</h2>
            <p className="mt-1 text-sm text-muted-foreground">The project to open first when you sign in.</p>
            <div className="mt-3 max-w-sm">
              <Select
                value={defaultProject === null ? NO_DEFAULT_PROJECT : String(defaultProject)}
                onValueChange={(value) => {
                  setDefaultProject(value === NO_DEFAULT_PROJECT ? null : Number(value))
                  setStatus("idle")
                }}
              >
                <SelectTrigger className="w-full" aria-label="Default project">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEFAULT_PROJECT}>No default</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projects.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">You have no projects to choose from yet.</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold">GitHub</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your GitHub account so TaskFlow can open issues and post comments as you.
            </p>
            {githubJustConnected ? (
              <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckIcon className="size-4" />
                GitHub connected.
              </p>
            ) : null}
            <div className="mt-3">
              {githubConnected === null ? (
                <span className="text-xs text-muted-foreground">Checking…</span>
              ) : githubConnected ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckIcon className="size-4" />
                  Connected
                </span>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    window.location.href = githubConnectUrl("/account/settings?github=connected")
                  }}
                >
                  Connect GitHub
                </Button>
              )}
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void onSave()} disabled={!dirty || status === "saving"}>
              {status === "saving" ? "Saving…" : "Save changes"}
            </Button>
            {dirty ? (
              <Button variant="outline" onClick={onReset} disabled={status === "saving"}>
                Reset
              </Button>
            ) : null}
            {status === "saved" && !dirty ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckIcon className="size-4" />
                Saved
              </span>
            ) : null}
            {saveError ? <span className="text-sm text-destructive">{saveError}</span> : null}
          </div>
        </>
      )}
    </div>
  )
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  )
}
