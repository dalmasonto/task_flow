/// The preview-theme control (#619) for the canvas toolbar and the component
/// dialog: the sun/moon toggle when the project has exactly light + dark, a
/// dropdown with a swatch per theme otherwise, nothing for light alone. Which
/// one is `switcherMode`'s call (`theme-options.ts`, tested).

import { MoonIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { safeSwatchColor, switcherMode, themeSelectItems, toggledTheme, type ThemeOption } from "./theme-options"

export function ThemeSwitcher({
  themes,
  value,
  onChange,
  compact = false,
}: {
  themes: ThemeOption[]
  value: string
  onChange: (theme: string) => void
  /// The dialog's smaller, outlined variant.
  compact?: boolean
}) {
  const mode = switcherMode(themes)
  if (mode === "none") return null
  if (mode === "toggle") {
    return (
      <Button
        type="button"
        variant={compact ? "outline" : "ghost"}
        size={compact ? "icon-sm" : "icon"}
        className={compact ? "rounded-lg" : undefined}
        title="Toggle theme"
        onClick={() => onChange(toggledTheme(value))}
      >
        {value === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
        <span className="sr-only">Toggle theme</span>
      </Button>
    )
  }
  return (
    <Select
      value={value}
      items={themeSelectItems(themes)}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
    >
      <SelectTrigger className={compact ? "h-7 w-32 text-xs" : "h-8 w-36 text-xs"} aria-label="Preview theme" title="Preview theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {themes.map((theme) => (
          <SelectItem key={theme.name} value={theme.name}>
            <span className="flex items-center gap-2">
              {/* Background on the left, primary on the right: enough to tell
                  palettes apart at a glance. Only real colours are painted
                  (`safeSwatchColor`): a token value could be a url(). */}
              <span
                aria-hidden
                className="relative inline-block size-3.5 shrink-0 overflow-hidden rounded-full border border-border"
                style={{ background: safeSwatchColor(theme.swatch.background) }}
              >
                <span className="absolute inset-y-0 right-0 w-1/2" style={{ background: safeSwatchColor(theme.swatch.primary) }} />
              </span>
              {theme.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
