/// Settings (design: account-settings): appearance, time zone, notifications
/// and deleting the account.
///
/// Built only from what's real: the theme saves to your account (shared with
/// the palette's switch). The time zone saves to your account (#TSK1134) so
/// agents use it; an older server shows this browser's zone instead. The design's notification toggles, "play a
/// sound" and dictation language are left out: nothing outside the app
/// delivers notifications yet, and there is no dictation, so those switches
/// would do nothing. Deleting an account needs #TSK1134's route.
import { useState } from "react"
import { toast } from "sonner"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchUserSettings, updateUserSettings } from "@/lib/taskflow-api"
import { getStoredThemePreference, type ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"

import { useLoad } from "../lib/use-load"
import { chooseTheme } from "../shell/theme-action"
import { AccountShell } from "./AccountShell"

const THEMES: { id: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { id: "light", label: "Light", icon: <SunIcon /> },
  { id: "dark", label: "Dark", icon: <MoonIcon /> },
  { id: "system", label: "Match system", icon: <MonitorIcon /> },
]

function Block({ title, description, children, danger }: { title: string; description: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <section className={cn("rounded-xl border bg-card p-5", danger ? "border-destructive/40" : "border-border")}>
      <h2 className={cn("font-medium", danger && "text-destructive")}>{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  )
}

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []
  } catch {
    return []
  }
})()
const UNSET = "__unset__"

/// The account's time zone (#TSK1134): saved to user settings, which whoami
/// passes to your agents. A server without the field shows the browser's.
function TimeZoneSetting({ now }: { now: number }) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const settings = useLoad("user-settings", () => fetchUserSettings())
  const [saving, setSaving] = useState(false)
  const supported = settings.data != null && "timezone" in settings.data
  const zone = settings.data?.timezone ?? null
  const shown = zone ?? browserZone

  const save = async (next: string | null) => {
    setSaving(true)
    try {
      await updateUserSettings({ timezone: next })
      toast.success(next ? `Time zone set to ${next}` : "Time zone cleared")
    } catch (e) {
      toast.error("Couldn't save the time zone", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
      settings.reload()
    }
  }

  const clock = (() => {
    try {
      return new Date(now).toLocaleString(undefined, { timeZone: shown, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    } catch {
      return new Date(now).toLocaleString()
    }
  })()

  if (settings.loading) return <Skeleton className="h-10 w-72" />
  if (!supported || !ZONES.length) {
    return (
      <>
        <p className="text-sm">
          <span className="font-medium">{browserZone}</span>
          <span className="text-muted-foreground">, now {clock}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Taken from this browser. This server doesn&apos;t save a time zone to your account yet.</p>
      </>
    )
  }
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select items={{ [UNSET]: "Not set", ...Object.fromEntries(ZONES.map((z) => [z, z.replace(/_/g, " ")])) }} value={zone ?? UNSET} onValueChange={(v) => void save(!v || v === UNSET ? null : String(v))}>
          <SelectTrigger className="w-full sm:w-72" aria-label="Time zone" disabled={saving}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={UNSET}>Not set</SelectItem>
            {ZONES.map((z) => (
              <SelectItem key={z} value={z}>
                {z.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {zone !== browserZone ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save(browserZone)}>
            Use this browser&apos;s ({browserZone.replace(/_/g, " ")})
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Now {clock}
        {zone ? "" : `, using this browser's zone until you pick one`}.
      </p>
    </>
  )
}

export function SettingsPage() {
  const now = useLivenessNow()
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredThemePreference())

  return (
    <AccountShell>
      <div className="space-y-4">
        <Block title="Appearance" description="Saved to your account, so it follows you to other devices.">
          <RadioGroup
            value={theme}
            onValueChange={(v) => {
              const next = String(v) as ThemePreference
              setTheme(next)
              void chooseTheme(next)
            }}
            aria-label="Theme"
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {THEMES.map((t) => (
              <Label key={t.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 font-normal has-[[data-checked]]:border-ring has-[[data-checked]]:bg-accent/40">
                <RadioGroupItem value={t.id} />
                <span className="text-muted-foreground [&_svg]:size-4">{t.icon}</span>
                <span className="text-sm">{t.label}</span>
              </Label>
            ))}
          </RadioGroup>
        </Block>

        <Block title="Time zone" description="Agents use it when they write dates for you.">
          <TimeZoneSetting now={now} />
        </Block>

        <Block title="Notifications" description="What reaches you when you're not looking at TaskFlow.">
          <p className="text-sm text-muted-foreground">
            Everything that needs you lands in your inbox, and mentions and direct messages show in chat as they happen. Notifications outside the app aren&apos;t available yet, so
            there&apos;s nothing to switch on here.
          </p>
        </Block>

        <Block title="Delete account" description="This can't be undone." danger>
          <p className="text-sm text-muted-foreground">
            Deleting your account removes you from every project. Projects you own and share with others must be handed to someone else first. Deleting an account from here isn&apos;t
            available yet.
          </p>
          <Button variant="destructive" className="mt-3" disabled>
            Delete account
          </Button>
        </Block>
      </div>
    </AccountShell>
  )
}
