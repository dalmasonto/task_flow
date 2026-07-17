import * as React from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { setThemePreference } from "@/lib/theme"
import { fetchUserSettings, updateUserSettings } from "@/lib/taskflow-api"
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

  React.useEffect(() => {
    let active = true
    void (async () => {
      setLoadError(null)
      try {
        const settings = await fetchUserSettings()
        if (!active) return
        setLoaded(settings)
        setTheme(settings.theme)
        setEmailNotifications(settings.email_notifications)
        setDefaultProject(settings.default_project)
        // The saved preference is authoritative — apply and persist it so the
        // rest of the app (and the next load) reflect the server value.
        setThemePreference(settings.theme)
      } catch (err) {
        if (!active) return
        setLoadError(err instanceof Error ? err.message : "Could not load your settings.")
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const dirty =
    loaded !== null &&
    (theme !== loaded.theme ||
      emailNotifications !== loaded.email_notifications ||
      defaultProject !== loaded.default_project)

  function onThemeChange(next: TaskflowUserSettingsTheme) {
    setTheme(next)
    setStatus("idle")
    // Apply immediately so the change is visible before saving.
    setThemePreference(next)
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
      setStatus("saved")
    } catch (err) {
      setStatus("idle")
      setSaveError(err instanceof Error ? err.message : "Could not save your settings.")
    }
  }

  function onReset() {
    if (!loaded) return
    setTheme(loaded.theme)
    setEmailNotifications(loaded.email_notifications)
    setDefaultProject(loaded.default_project)
    setStatus("idle")
    setSaveError(null)
    setThemePreference(loaded.theme)
  }

  return (
    <div className="space-y-5">
      <AccountPageHeader
        eyebrow="Account"
        title="Settings"
        description="Preferences stored against your account. Theme applies immediately across the app; other changes save when you hit Save."
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
            <p className="mt-1 text-sm text-muted-foreground">Choose how TaskFlow looks. This applies to your browser right away.</p>
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
