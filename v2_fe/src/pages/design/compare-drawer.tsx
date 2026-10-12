/// #523: the Compare drawer — the operator's door onto `design_compare`.
///
/// Pick screens (individually or by group), add named variants of token
/// overrides seeded from the project's own colours, choose the themes, and
/// render ONE grid: screens × variants × themes, with the contrast checks
/// measured as rendered. Nothing is stored until a column is APPLIED, which is
/// a normal tokens write — the compare itself cannot change the design.
///
/// It calls the same render core as the agent tool (`compare_api::render_grid`),
/// so what the human sees here and what an agent gets from `design_compare`
/// cannot drift.

import * as React from "react"
import { CheckIcon, ColumnsIcon, Loader2Icon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  compareDesignVariants,
  fetchDesignTokens,
  fetchTokenDefaults,
  putDesignTokens,
  type DesignCompareResult,
  type DesignTokensDoc,
} from "@/lib/design-api"
import {
  applyTokenPatch,
  buildCompareRequest,
  colourTokenRows,
  compareProblem,
  newVariantLabel,
  type CompareVariant,
} from "@/lib/design-compare"
import type { LayoutGroup } from "@/lib/design-layout"
import { cn } from "@/lib/utils"

export function CompareDrawer({
  projectId,
  routes,
  labelFor,
  groups,
  themes,
  activeTheme,
  viewport,
  onClose,
  onApplied,
}: {
  projectId: number
  /// The project's pages, in manifest order.
  routes: { path: string; title: string }[]
  labelFor: (route: string) => string
  /// The layout's groups — the chips that pick several screens at once.
  groups: LayoutGroup[]
  /// The project's declared themes, light first.
  themes: { name: string; label: string }[]
  activeTheme: string
  /// The device the artboard is showing — the grid renders at the same viewport.
  viewport: string
  onClose: () => void
  /// An applied variant is a tokens write; the caller reloads the boards.
  onApplied: () => void
}) {
  const [picked, setPicked] = React.useState<string[]>(() => routes.slice(0, 3).map((route) => route.path))
  const [variants, setVariants] = React.useState<CompareVariant[]>([{ label: "Current", tokens: {} }])
  const [chosenThemes, setChosenThemes] = React.useState<string[]>([activeTheme])
  const [editing, setEditing] = React.useState(0)
  const [tokens, setTokens] = React.useState<{ doc: DesignTokensDoc; defaults: DesignTokensDoc } | null>(null)
  const [result, setResult] = React.useState<DesignCompareResult | null>(null)
  const [rendering, setRendering] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [applying, setApplying] = React.useState<string | null>(null)
  const [applied, setApplied] = React.useState<string | null>(null)

  // The tokens editor's own read: the project's document plus the shadcn
  // defaults it does not override, because a default-only token (e.g.
  // `--primary-foreground`) is still a variable a variant can recolour.
  React.useEffect(() => {
    let cancelled = false
    void Promise.all([fetchDesignTokens(projectId), fetchTokenDefaults(projectId)])
      .then(([read, defaults]) => {
        if (!cancelled) setTokens({ doc: read.doc, defaults })
      })
      .catch(() => {
        // The drawer still works with the known tokens absent; the error is
        // not fatal and the render path does not need them.
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const mergedDoc = React.useMemo<DesignTokensDoc | null>(() => {
    if (!tokens) return null
    return {
      ...tokens.doc,
      categories: { ...tokens.defaults.categories, ...tokens.doc.categories },
    }
  }, [tokens])
  const colourRows = React.useMemo(
    () => (mergedDoc ? colourTokenRows(mergedDoc, activeTheme) : []),
    [mergedDoc, activeTheme]
  )

  const problem = compareProblem({ routes: picked, variants, themes: chosenThemes })
  const editingVariant = variants[editing]

  const toggleRoute = (path: string) =>
    setPicked((current) => (current.includes(path) ? current.filter((r) => r !== path) : [...current, path]))

  const toggleGroup = (group: LayoutGroup) => {
    const known = group.routes.filter((route) => routes.some((r) => r.path === route))
    const allPicked = known.length > 0 && known.every((route) => picked.includes(route))
    setPicked((current) =>
      allPicked
        ? current.filter((route) => !known.includes(route))
        : [...current, ...known.filter((route) => !current.includes(route))]
    )
  }

  const toggleTheme = (name: string) =>
    setChosenThemes((current) =>
      current.includes(name) ? current.filter((t) => t !== name) : [...current, name]
    )

  const setOverride = (name: string, value: string) => {
    setVariants((current) =>
      current.map((variant, index) =>
        index === editing
          ? { ...variant, tokens: { ...variant.tokens, [name]: value } }
          : variant
      )
    )
    setApplied(null)
  }
  const clearOverride = (name: string) => {
    setVariants((current) =>
      current.map((variant, index) => {
        if (index !== editing) return variant
        const next = { ...variant.tokens }
        delete next[name]
        return { ...variant, tokens: next }
      })
    )
    setApplied(null)
  }

  const addVariant = () => {
    const label = newVariantLabel(variants.map((v) => v.label))
    setVariants((current) => [...current, { label, tokens: {} }])
    setEditing(variants.length)
    setApplied(null)
  }
  const renameVariant = (label: string) =>
    setVariants((current) => current.map((variant, index) => (index === editing ? { ...variant, label } : variant)))
  const removeVariant = (index: number) => {
    setVariants((current) => current.filter((_, i) => i !== index))
    setEditing((current) => (current === index ? 0 : current > index ? current - 1 : current))
    setApplied(null)
  }

  const render = async () => {
    if (problem) return
    setRendering(true)
    setError(null)
    setApplied(null)
    try {
      const body = { ...buildCompareRequest({ routes: picked, variants, themes: chosenThemes }), viewport }
      setResult(await compareDesignVariants(projectId, body))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not render the comparison.")
    } finally {
      setRendering(false)
    }
  }

  /// Apply writes the column's token patch onto the CURRENT tokens document,
  /// so a variant picked before someone else's token edit is not applied on
  /// top of stale data; a version conflict is surfaced rather than retried.
  const apply = async (label: string) => {
    const entry = result?.apply?.[label]
    if (!entry) return
    setApplying(label)
    setError(null)
    setApplied(null)
    try {
      const { doc: current, version } = await fetchDesignTokens(projectId)
      const write = await putDesignTokens(projectId, applyTokenPatch(current, entry.patch), version)
      if (write.ok === true) {
        setApplied(label)
        setTokens((state) => (state ? { ...state, doc: applyTokenPatch(current, entry.patch) } : state))
        onApplied()
      } else if ("error" in write && write.error === "version_conflict") {
        setError("The tokens changed while this grid was being compared — render again and apply the fresh one.")
      } else {
        setError("The token write was refused — see the Tokens panel for the validation detail.")
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not apply the variant.")
    } finally {
      setApplying(null)
    }
  }

  const overrides = (variant: CompareVariant) => Object.keys(variant.tokens).length

  return (
    <aside
      aria-label="Compare"
      className="absolute inset-y-0 right-0 z-40 flex w-[min(560px,100%)] flex-col border-l bg-background shadow-2xl"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <ColumnsIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Compare</h2>
          <span className="text-xs text-muted-foreground">screens × variants × themes</span>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close compare" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Screens — by group, then individually. */}
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Screens</h3>
          {groups.length ? (
            <div className="flex flex-wrap gap-1">
              {groups.map((group) => {
                const known = group.routes.filter((route) => routes.some((r) => r.path === route))
                if (!known.length) return null
                const allPicked = known.every((route) => picked.includes(route))
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={allPicked}
                    onClick={() => toggleGroup(group)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs transition-colors",
                      allPicked ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {group.name}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="max-h-40 overflow-y-auto rounded-lg border">
            {routes.map((route) => {
              const on = picked.includes(route.path)
              return (
                <label
                  key={route.path}
                  className="flex cursor-pointer items-center gap-2 border-b px-2 py-1 text-sm last:border-b-0 hover:bg-accent/50"
                >
                  <input type="checkbox" checked={on} onChange={() => toggleRoute(route.path)} />
                  <span className="truncate">{labelFor(route.path)}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{route.path}</span>
                </label>
              )
            })}
          </div>
        </section>

        {/* Variants — the columns. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Variants</h3>
            <Button variant="outline" size="sm" onClick={addVariant} disabled={variants.length >= 4}>
              <PlusIcon className="size-3.5" />
              Add variant
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {variants.map((variant, index) => (
              <button
                key={`${variant.label}-${index}`}
                type="button"
                onClick={() => setEditing(index)}
                aria-pressed={editing === index}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
                  editing === index ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {applied === variant.label ? <CheckIcon className="size-3" /> : null}
                {variant.label}
                <span className="text-[10px] opacity-70">
                  {overrides(variant) ? `${overrides(variant)} token${overrides(variant) === 1 ? "" : "s"}` : "live"}
                </span>
              </button>
            ))}
          </div>

          {editingVariant ? (
            <div className="space-y-2 rounded-lg border p-2">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Variant name"
                  value={editingVariant.label}
                  onChange={(event) => renameVariant(event.target.value)}
                  className="h-7 text-xs"
                />
                {variants.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${editingVariant.label}`}
                    onClick={() => removeVariant(editing)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Edit a colour to override it in this column only. “Current” with no overrides is the live design — leave
                one column empty to compare against it.
              </p>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {colourRows.map((row) => {
                  const override = editingVariant.tokens[row.name]
                  return (
                    <div key={row.name} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/40">
                      <span
                        className="size-3.5 shrink-0 rounded-sm ring-1 ring-border"
                        style={{ background: override ?? (row.value || "transparent") }}
                      />
                      <span className="w-40 truncate font-mono text-[11px]" title={row.name}>
                        {row.name}
                      </span>
                      {/* A picker only understands #rrggbb; the shadcn tokens
                          are oklch(...), so the value is edited as TEXT and
                          the picker appears when the value can use it. The
                          backend validates whatever is typed. */}
                      {/^#[0-9a-f]{6}$/i.test(override ?? row.hex ?? "") ? (
                        <input
                          type="color"
                          aria-label={`Colour for ${row.name}`}
                          value={(override ?? row.hex)!}
                          onChange={(event) => setOverride(row.name, event.target.value)}
                          className="h-5 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent"
                        />
                      ) : null}
                      <input
                        type="text"
                        aria-label={`Value for ${row.name}`}
                        value={override ?? ""}
                        placeholder={row.value}
                        onChange={(event) =>
                          event.target.value.trim() ? setOverride(row.name, event.target.value) : clearOverride(row.name)
                        }
                        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-right font-mono text-[11px] text-muted-foreground outline-none focus:border-ring focus:text-foreground"
                      />
                      {override ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Reset ${row.name}`}
                          onClick={() => clearOverride(row.name)}
                        >
                          <RotateCcwIcon className="size-3" />
                        </Button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </section>

        {/* Themes. */}
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Themes</h3>
          <div className="flex flex-wrap gap-1">
            {themes.map((theme) => (
              <button
                key={theme.name}
                type="button"
                aria-pressed={chosenThemes.includes(theme.name)}
                onClick={() => toggleTheme(theme.name)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  chosenThemes.includes(theme.name)
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </section>

        <div className="space-y-2">
          {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
          <Button onClick={() => void render()} disabled={Boolean(problem) || rendering} className="w-full">
            {rendering ? <Loader2Icon className="animate-spin" /> : <ColumnsIcon className="size-4" />}
            {rendering ? "Rendering…" : "Render grid"}
          </Button>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {result ? (
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Result {result.split ? `(${result.images.length} parts — cells split to stay readable)` : ""}
            </h3>
            {result.images.map((image, index) => (
              <figure key={index} className="space-y-1 rounded-lg border p-2">
                <img
                  src={`data:image/png;base64,${image.png_base64}`}
                  alt={`Comparison grid for ${image.routes.map(labelFor).join(", ")}`}
                  className="w-full rounded"
                />
                <figcaption className="text-[11px] text-muted-foreground">
                  {image.routes.map(labelFor).join(", ")} · {image.size.width}×{image.size.height}
                </figcaption>
              </figure>
            ))}

            {result.warnings.length ? (
              <ul className="space-y-0.5 rounded-lg border border-amber-300/60 bg-amber-50/60 p-2 text-[11px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {result.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            ) : null}

            {result.checks.length ? (
              <div className="space-y-1 rounded-lg border p-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Contrast</p>
                {result.checks.map((check, index) => (
                  <div key={index} className="flex items-center gap-2 text-[11px]">
                    <span className="w-24 shrink-0 truncate">{check.variant}</span>
                    <span className="w-14 shrink-0 truncate text-muted-foreground">{check.theme}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${check.fg} on ${check.bg}`}>
                      {check.label ? `${check.label} — ` : ""}
                      <span className="font-mono">
                        {check.fg} on {check.bg}
                      </span>
                    </span>
                    <span className={cn("shrink-0 font-medium", check.aa ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                      {check.ratio.toFixed(2)} {check.aa ? "AA" : check.aaLarge ? "AA-large" : "fail"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {result.apply && Object.keys(result.apply).length ? (
              <div className="space-y-1 rounded-lg border p-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Apply a column</p>
                {Object.keys(result.apply).map((label) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {label}
                      {result.apply?.[label]?.css_not_applied ? (
                        <span className="text-muted-foreground"> — its raw CSS is not part of the write</span>
                      ) : null}
                    </span>
                    <Button
                      variant={applied === label ? "secondary" : "outline"}
                      size="sm"
                      disabled={applying !== null}
                      onClick={() => void apply(label)}
                    >
                      {applying === label ? <Loader2Icon className="animate-spin" /> : applied === label ? <CheckIcon className="size-3.5" /> : null}
                      {applied === label ? "Applied" : "Apply"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  )
}
