/// Settings (design: account-settings): appearance, time zone, notifications
/// and deleting the account.
///
/// Built only from what's real: the theme saves to your account (shared with
/// the palette's switch). The time zone is read from this browser until the
/// account keeps one (#TSK1134). The design's notification toggles, "play a
/// sound" and dictation language are left out: nothing outside the app
/// delivers notifications yet, and there is no dictation, so those switches
/// would do nothing. Deleting an account needs #TSK1134's route.
import { useState } from "react"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { getStoredThemePreference, type ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"

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

export function SettingsPage() {
  const now = useLivenessNow()
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredThemePreference())
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

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

        <Block title="Time zone" description="Dates and times show in this zone.">
          <p className="text-sm">
            <span className="font-medium">{zone}</span>
            <span className="text-muted-foreground">, now {new Date(now).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Taken from this browser. Saving a time zone to your account, so agents use it too, is on its way.</p>
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
