/// Structured, typed light/dark editor over `styles/tokens.json` (Task 7 of
/// the design-phase2 tabs/tokens work). Replaces the old inline `TokenEditor`
/// that did regex string-surgery on `styles/tokens.css`: tokens are stored as
/// JSON now (Task 6's `DesignTokensDoc`), so this editor reads/writes that
/// JSON directly through `fetchDesignTokens`/`putDesignTokens` instead of
/// pattern-matching CSS text. The generated CSS is export-only (Export CSS
/// button below), never a write target.

import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  fetchDesignTokens,
  putDesignTokens,
  exportTokensCss,
  type DesignTokensDoc,
  type ValidationError,
} from "@/lib/design-api"

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

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/// Mirrors the backend's `KNOWN_CATEGORIES` (taskflow-design/src/tokens.rs).
/// Rendered in this fixed order (even when empty) so the editor's shape is
/// stable regardless of which categories a project has actually populated.
const CATEGORY_ORDER = ["colors", "spacing", "radius", "typography", "shadows", "custom"]

const CATEGORY_LABELS: Record<string, string> = {
  colors: "Colors",
  spacing: "Spacing",
  radius: "Radius",
  typography: "Typography",
  shadows: "Shadows",
  custom: "Custom",
}

/// Categories whose values are CSS lengths edited as number+unit; everything
/// else (colors handled separately, shadows/custom always) falls back to a
/// plain text field whenever `parseSizeValue` can't split the current value.
const NUMERIC_CATEGORIES = new Set(["spacing", "radius", "typography"])

type TokenMap = Record<string, { light: string; dark?: string }>

// ---------------------------------------------------------------------------
// Value field — renders the right typed control for a category
// ---------------------------------------------------------------------------

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
    const swatch = HEX_COLOR_RE.test(value) ? value : "#000000"
    return (
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={swatch}
          title="Pick a color"
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-6 cursor-pointer rounded border border-black/10 p-0"
        />
        <input
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-24 rounded border bg-transparent px-1 font-mono text-[10px]"
        />
      </div>
    )
  }

  const parsed = NUMERIC_CATEGORIES.has(category) ? parseSizeValue(value) : null
  if (parsed) {
    return (
      <div className="flex items-center gap-0.5">
        <input
          type="number"
          value={parsed.num}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onChange(formatSizeValue(n, parsed.unit))
          }}
          className="h-6 w-14 rounded border bg-transparent px-1 font-mono text-[10px]"
        />
        <input
          value={parsed.unit}
          placeholder="unit"
          onChange={(e) => onChange(formatSizeValue(parsed.num, e.target.value))}
          className="h-6 w-10 rounded border bg-transparent px-1 font-mono text-[10px]"
        />
      </div>
    )
  }

  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 w-40 rounded border bg-transparent px-1 font-mono text-[10px]"
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
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="new-token-name"
        className="h-6 w-32 rounded border bg-transparent px-1 font-mono text-[10px]"
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
  onSetValue,
  onAdd,
  onRemove,
}: {
  category: string
  tokens: TokenMap
  onSetValue: (key: string, field: "light" | "dark", value: string) => void
  onAdd: (key: string) => void
  onRemove: (key: string) => void
}) {
  const entries = Object.entries(tokens)
  return (
    <div className="border-b px-3 py-2 last:border-b-0">
      <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {CATEGORY_LABELS[category] ?? category}
      </p>
      <div className="flex flex-col gap-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-1.5">
            <span className="mt-1 w-20 shrink-0 truncate font-mono text-[10px]" title={key}>
              {key}
            </span>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="w-9 shrink-0 text-[9px] text-muted-foreground">light</span>
                <ValueField
                  category={category}
                  value={value.light}
                  onChange={(v) => onSetValue(key, "light", v)}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="w-9 shrink-0 text-[9px] text-muted-foreground">dark</span>
                <ValueField
                  category={category}
                  value={value.dark ?? ""}
                  placeholder="(same as light)"
                  onChange={(v) => onSetValue(key, "dark", v)}
                />
              </div>
            </div>
            <button
              type="button"
              title={`Remove ${key}`}
              onClick={() => onRemove(key)}
              className="ml-auto rounded px-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              ×
            </button>
          </div>
        ))}
        {!entries.length ? (
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
  const [exporting, setExporting] = useState(false)
  const [errors, setErrors] = useState<ValidationError[] | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { doc, version } = await fetchDesignTokens(projectId)
      setDoc(doc)
      setVersion(version)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load tokens.")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const setTokenValue = (category: string, key: string, field: "light" | "dark", value: string) => {
    setDoc((prev) => {
      if (!prev) return prev
      const catTokens = prev.categories[category] ?? {}
      const existing = catTokens[key] ?? { light: "" }
      const nextValue: { light: string; dark?: string } = { ...existing }
      if (field === "light") {
        nextValue.light = value
      } else if (value.trim() === "") {
        delete nextValue.dark
      } else {
        nextValue.dark = value
      }
      return {
        ...prev,
        categories: {
          ...prev.categories,
          [category]: { ...catTokens, [key]: nextValue },
        },
      }
    })
  }

  const addToken = (category: string, key: string) => {
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

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2">
        <Button size="sm" variant="outline" disabled={!doc || saving} onClick={() => void handleSave()}>
          {saving ? "Saving…" : "Save tokens"}
        </Button>
        <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void handleExport()}>
          {exporting ? "Exporting…" : "Export CSS"}
        </Button>
      </div>

      {loading ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading tokens…</p> : null}
      {loadError ? <p className="px-3 py-2 text-xs text-destructive">{loadError}</p> : null}
      {exportError ? <p className="px-3 py-2 text-xs text-destructive">{exportError}</p> : null}

      {doc && !loading
        ? categoryNames.map((category) => (
            <CategorySection
              key={category}
              category={category}
              tokens={doc.categories[category] ?? {}}
              onSetValue={(key, field, value) => setTokenValue(category, key, field, value)}
              onAdd={(key) => addToken(category, key)}
              onRemove={(key) => removeToken(category, key)}
            />
          ))
        : null}

      {errors?.length ? (
        <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/10 p-2">
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] text-destructive">
              {e.rule}: {e.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
