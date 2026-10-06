/// Structured, typed editor over `styles/tokens.json`: a **Theme** tab that
/// edits one theme at a time (theme strip + one value per token, #619) and a
/// read-only **CSS variables** tab. (Task 7 of
/// the design-phase2 tabs/tokens work). Replaces the old inline `TokenEditor`
/// that did regex string-surgery on `styles/tokens.css`: tokens are stored as
/// JSON now (Task 6's `DesignTokensDoc`), so this editor reads/writes that
/// JSON directly through `fetchDesignTokens`/`putDesignTokens` instead of
/// pattern-matching CSS text. The generated CSS is export-only (Export CSS
/// button below), never a write target.
///
/// The search box at the top narrows what is DRAWN and nothing else — the
/// filter is `./token-filter.ts`, and the reasons it must never touch `doc` or
/// the save path are written out there and at the call site below.

import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  fetchDesignTokens,
  fetchTokenDefaults,
  putDesignTokens,
  exportTokensCss,
  type DesignTokensDoc,
  type DesignTokenValue,
  type ValidationError,
} from "@/lib/design-api"
import { defaultRows } from "./token-defaults"
import { CATEGORY_ORDER, categoryLabel, filterTokenCategories } from "./token-filter"
import { LIGHT, declaredThemes, overrideFromDefault, ownThemeValue, setThemeValue } from "./token-themes"
import { colourControl } from "./token-swatch"
import { ThemeStrip } from "./theme-strip"
import { TokenCssView } from "./token-css-view"

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in token-editor.test.ts)
// ---------------------------------------------------------------------------

/// Splits a CSS length like `"8px"` or `"1.5rem"` into its numeric magnitude
/// and unit, so the spacing/radius/typography controls can bind two plain
/// inputs (a number field + a unit field) to one token string instead of
/// hand-parsing on every keystroke. Returns `null` for anything that isn't
/// `<number><optional unit>` — keyword values ("auto"), multi-value strings
/// (shadows), and empty strings all fall back to a plain text input instead
/// of being corrupted by a parse that doesn't apply to them.
export function parseSizeValue(v: string): { num: number; unit: string } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(v)
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num)) return null
  return { num, unit: match[2] }
}

function formatSizeValue(num: number, unit: string): string {
  return `${num}${unit}`
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

// `CATEGORY_ORDER` and the labels moved to `./token-filter.ts` with the search
// box: a category's name is a search surface, so the list and the filter read
// it from one place, and a non-component export from a `.tsx` costs a
// `react-refresh/only-export-components` error apiece.

/// Categories whose values are CSS lengths edited as number+unit; everything
/// else (colors handled separately, shadows/custom always) falls back to a
/// plain text field whenever `parseSizeValue` can't split the current value.
const NUMERIC_CATEGORIES = new Set(["spacing", "radius", "typography"])

type TokenMap = Record<string, DesignTokenValue>

// ---------------------------------------------------------------------------
// Value field — renders the right typed control for a category
// ---------------------------------------------------------------------------

/// One token's editable VALUE controls.
///
/// Every input in here stays `font-mono`, and that is deliberate rather than
/// leftover: a value is a literal read character by character (`#6366f1`,
/// `1.5rem`, `0 1px 2px rgba(0,0,0,0.1)`), and the request that took the names
/// off mono exempted values in as many words — "normal font not font mono
/// unless values". This includes the two fields that hold name-shaped strings
/// (the unit, and the plain fallback field) and the text box beside a color
/// swatch: each holds a value, and normalising them to the body font for
/// consistency with the rows above would be a regression, not a cleanup.

function ValueField({
  category,
  value,
  onChange,
  placeholder,
}: {
  category: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  if (category === "colors") {
    const control = colourControl(value, placeholder)
    return (
      <div className="flex items-center gap-1">
        {control.kind === "picker" ? (
          <input
            type="color"
            value={control.hex}
            title="Pick a color"
            onChange={(e) => onChange(e.target.value)}
            className="h-6 w-6 shrink-0 cursor-pointer rounded border border-black/10 p-0"
          />
        ) : (
          <span
            aria-hidden="true"
            title={value || placeholder || undefined}
            style={control.color ? { backgroundColor: control.color } : undefined}
            className="inline-block h-6 w-6 shrink-0 rounded border border-black/10"
          />
        )}
        <Input
          value={value}
          placeholder={placeholder}
          title={value || placeholder || undefined}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 px-1.5 text-xs md:text-xs w-36 font-mono"
        />
      </div>
    )
  }

  const parsed = NUMERIC_CATEGORIES.has(category) ? parseSizeValue(value) : null
  if (parsed) {
    return (
      <div className="flex items-center gap-0.5">
        <Input
          type="number"
          value={parsed.num}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onChange(formatSizeValue(n, parsed.unit))
          }}
          className="h-7 px-1.5 text-xs md:text-xs w-16 font-mono"
        />
        <Input
          value={parsed.unit}
          placeholder="unit"
          onChange={(e) => onChange(formatSizeValue(parsed.num, e.target.value))}
          className="h-7 px-1.5 text-xs md:text-xs w-12 font-mono"
        />
      </div>
    )
  }

  return (
    <Input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 px-1.5 text-xs md:text-xs w-40 font-mono"
    />
  )
}

// ---------------------------------------------------------------------------
// Category section — one group's list of tokens + an add-token form
// ---------------------------------------------------------------------------

function AddTokenForm({ onAdd }: { onAdd: (key: string) => void }) {
  const [key, setKey] = useState("")
  return (
    <form
      className="mt-1 flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = key.trim()
        if (trimmed) {
          onAdd(trimmed)
          setKey("")
        }
      }}
    >
      <Input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="new-token-name"
        className="h-7 px-1.5 text-xs md:text-xs w-32"
      />
      <button type="submit" className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70">
        + Add
      </button>
    </form>
  )
}

function CategorySection({
  category,
  tokens,
  theme,
  onSetValue,
  onAdd,
  onRemove,
  defaults,
  onOverride,
}: {
  category: string
  tokens: TokenMap
  /// The theme being edited (#619): each token shows ONE value — this theme's.
  theme: string
  defaults: [string, DesignTokenValue][]
  onOverride: (key: string, value: DesignTokenValue) => void
  onSetValue: (key: string, value: string) => void
  onAdd: (key: string) => void
  onRemove: (key: string) => void
}) {
  const entries = Object.entries(tokens)
  return (
    <div className="border-b px-3 py-2 last:border-b-0">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {categoryLabel(category)}
      </p>
      <div className="flex flex-col gap-2">
        {entries.map(([key, value]) => {
          const own = ownThemeValue(value, theme)
          // A theme other than light with no value of its own renders light's.
          const inherits = theme !== LIGHT && own === undefined
          return (
            <div key={key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={key}>
                  {key}
                </span>
                <button
                  type="button"
                  title={`Remove ${key}`}
                  onClick={() => onRemove(key)}
                  className="shrink-0 rounded px-1 text-[10px] leading-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-1 pl-2">
                <ValueField
                  category={category}
                  value={own ?? ""}
                  // The inherited light value shows as the placeholder, so an
                  // empty field never reads as "unset".
                  placeholder={theme === LIGHT ? undefined : value.light}
                  onChange={(v) => onSetValue(key, v)}
                />
                {theme !== LIGHT && !inherits ? (
                  <button
                    type="button"
                    title={`Reset ${key} to the light value`}
                    aria-label={`Reset ${key} to the light value`}
                    onClick={() => onSetValue(key, "")}
                    className="shrink-0 rounded px-1 text-[10px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    ↺
                  </button>
                ) : null}
                {inherits ? <span className="text-[9px] text-muted-foreground">from light</span> : null}
              </div>
            </div>
          )
        })}
        {defaults.map(([key, value]) => (
          <div key={`default:${key}`} className="flex items-center gap-1.5 opacity-70">
            <span className="min-w-0 flex-1 truncate text-[11px]" title={`${key}: ${ownThemeValue(value, theme) ?? value.light}`}>
              {key}
            </span>
            <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">default</span>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onOverride(key, value)}
            >
              Override
            </button>
          </div>
        ))}
        {!entries.length && !defaults.length ? (
          <p className="text-[10px] text-muted-foreground">No {category} tokens yet.</p>
        ) : null}
      </div>
      <AddTokenForm onAdd={onAdd} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// TokenEditor
// ---------------------------------------------------------------------------

export function TokenEditor({
  projectId,
  onSaved,
}: {
  projectId: number
  onSaved: () => void
}) {
  const [doc, setDoc] = useState<DesignTokensDoc | null>(null)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [errors, setErrors] = useState<ValidationError[] | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [defaults, setDefaults] = useState<DesignTokensDoc | null>(null)
  const [activeTheme, setActiveTheme] = useState(LIGHT)
  const [panel, setPanel] = useState<"theme" | "css">("theme")
  const [cssEpoch, setCssEpoch] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { doc, version } = await fetchDesignTokens(projectId)
      setDoc(doc)
      setVersion(version)
      setDefaults(await fetchTokenDefaults(projectId))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load tokens.")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  // The theme being edited, while it still exists in the (possibly just
  // edited) document; light otherwise.
  const shownTheme = doc && declaredThemes(doc).includes(activeTheme) ? activeTheme : LIGHT

  const overrideDefault = (category: string, key: string, value: DesignTokenValue) =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            categories: {
              ...prev.categories,
              [category]: { ...(prev.categories[category] ?? {}), [key]: overrideFromDefault(prev, value) },
            },
          }
        : prev
    )

  const setTokenValue = (category: string, key: string, value: string) =>
    setDoc((prev) => (prev ? setThemeValue(prev, category, key, shownTheme, value) : prev))

  /// Adding a token also clears the search box, and that is not a convenience:
  /// a token added under an active query can be filtered straight back out of
  /// the view. It IS in `doc` (correctly, and Save writes it), but nothing
  /// appears where the add happened, so the reasonable reading is that the add
  /// did not work. Clearing the query is the smallest fix that removes that
  /// state, and it leaves the save path alone — the token is in `doc` either
  /// way, so what Save sends is identical.
  ///
  /// A duplicate name adds nothing (the updater below refuses to clobber an
  /// existing token), so it does not clear: the misleading state is an add
  /// that worked and showed nothing, and that one did not happen.
  const addToken = (category: string, key: string) => {
    const alreadyThere = doc?.categories[category]?.[key] !== undefined
    setDoc((prev) => {
      if (!prev) return prev
      const catTokens = prev.categories[category] ?? {}
      if (catTokens[key]) return prev // don't clobber an existing token
      return {
        ...prev,
        categories: {
          ...prev.categories,
          [category]: { ...catTokens, [key]: { light: "" } },
        },
      }
    })
    if (!alreadyThere) setQuery("")
  }

  const removeToken = (category: string, key: string) => {
    setDoc((prev) => {
      if (!prev) return prev
      const catTokens = { ...(prev.categories[category] ?? {}) }
      delete catTokens[key]
      return { ...prev, categories: { ...prev.categories, [category]: catTokens } }
    })
  }

  const handleSave = async () => {
    if (!doc) return
    setSaving(true)
    setErrors(null)
    try {
      const result = await putDesignTokens(projectId, doc, version)
      if (!result.ok) {
        if ("errors" in result) {
          setErrors(result.errors)
        } else {
          setErrors([
            {
              line: 0,
              rule: "conflict",
              message: "Someone edited tokens.json concurrently — reopen and retry.",
            },
          ])
        }
        return
      }
      onSaved()
      setJustSaved(true)
      window.setTimeout(() => setJustSaved(false), 2000)
      setCssEpoch((n) => n + 1)
      await load() // refetch — picks up the new version
    } catch (err) {
      setErrors([{ line: 0, rule: "network", message: err instanceof Error ? err.message : "Save failed." }])
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      await exportTokensCss(projectId)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.")
    } finally {
      setExporting(false)
    }
  }

  const categoryNames = doc
    ? [...CATEGORY_ORDER, ...Object.keys(doc.categories).filter((c) => !CATEGORY_ORDER.includes(c))]
    : []

  /// What the search box narrows the panel to, computed at render and never
  /// written back: `doc` stays whole, so Save (which sends `doc`) cannot delete
  /// a token the query happened to hide. Editing still goes through `doc` too —
  /// the callbacks below are keyed by category and key, not by row.
  const searching = query.trim() !== ""
  const view = useMemo(() => (doc ? filterTokenCategories(doc, query) : null), [doc, query])

  return (
    <div className="flex flex-col">
      <Tabs value={panel} onValueChange={(value) => setPanel(value as "theme" | "css")}>
        {/* Sticky inside the Tokens tab's scroll container (the outer
            TabsContent): the inner tabs and the theme strip stay pinned while
            the token list scrolls. Nothing between here and that container may
            set `overflow`, or `sticky` sticks to the wrong box. */}
        <div className="sticky top-0 z-10 bg-background">
          <TabsList>
            <TabsTrigger value="theme">Theme</TabsTrigger>
            <TabsTrigger value="css">CSS variables</TabsTrigger>
          </TabsList>
          {panel === "theme" && doc ? (
            <ThemeStrip doc={doc} active={shownTheme} onSelect={setActiveTheme} onDocChange={setDoc} />
          ) : null}
          {/* The search and Save/Export stay pinned under the strip too: a
              query typed at the top is still editable after scrolling deep
              into the results, and so is Save. */}
          {panel === "theme" ? (
            <>
              <div className="px-3 pt-2">
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tokens…"
                  aria-label="Search tokens"
                />
              </div>
              <div className="flex items-center gap-1.5 border-b px-3 pb-1.5 pt-1">
                <Button size="sm" variant="outline" disabled={!doc || saving} onClick={() => void handleSave()}>
                  {saving ? "Saving…" : justSaved ? "Saved ✓" : "Save tokens"}
                </Button>
                <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void handleExport()}>
                  {exporting ? "Exporting…" : "Export CSS"}
                </Button>
              </div>
            </>
          ) : null}
        </div>

        <TabsContent value="theme" className="overflow-y-visible">

          {loading ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading tokens…</p> : null}
          {loadError ? <p className="px-3 py-2 text-xs text-destructive">{loadError}</p> : null}
          {exportError ? <p className="px-3 py-2 text-xs text-destructive">{exportError}</p> : null}

          {view && !loading
            ? categoryNames
                // While searching, an empty group is not a result.
                .filter((category) => !searching || category in view.categories)
                .map((category) => (
                  <CategorySection
                    key={category}
                    category={category}
                    tokens={view.categories[category] ?? {}}
                    theme={shownTheme}
                    onSetValue={(key, value) => setTokenValue(category, key, value)}
                    onAdd={(key) => addToken(category, key)}
                    onRemove={(key) => removeToken(category, key)}
                    defaults={defaults && doc && !searching ? defaultRows(defaults, doc, category) : []}
                    onOverride={(key, value) => overrideDefault(category, key, value)}
                  />
                ))
            : null}

          {view && !loading && searching && !Object.keys(view.categories).length ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">No tokens match “{query.trim()}”.</p>
          ) : null}

          {errors?.length ? (
            <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/10 p-2">
              {errors.map((e, i) => (
                <p key={i} className="text-[11px] text-destructive">
                  {e.rule}: {e.message}
                </p>
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="css" className="overflow-y-visible">
          <TokenCssView projectId={projectId} epoch={cssEpoch} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
