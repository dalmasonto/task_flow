/// Pure edits over a tokens document's themes (#619). Every function returns
/// a NEW document and never mutates its input — the token editor keeps `doc`
/// in React state and saves it whole through `putDesignTokens`, which the
/// server validates (`validate_tokens_json`: rules `theme-name`, `theme-unknown`).
///
/// Shape: `themes` lists the themes besides light, in order; a document with
/// no list is the legacy pair, so `dark` is declared implicitly. A token's
/// `light` is the base; a theme key is an override; no key = inherits light.

import type { DesignThemeDecl, DesignTokensDoc, DesignTokenValue } from "@/lib/design-api"

export const LIGHT = "light"
/// Themes per project, light included — the server's `MAX_THEMES`.
export const MAX_THEMES = 8
const THEME_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const RESERVED = new Set(["light", "both", "all"])

/// The themes besides light, in order.
export function themeDecls(doc: DesignTokensDoc): DesignThemeDecl[] {
  return doc.themes ?? [{ name: "dark" }]
}

/// #626: the appearance the document STORES for a theme (light is always
/// light); null = automatic.
export function themeAppearanceSetting(doc: DesignTokensDoc, name: string): "light" | "dark" | null {
  if (name === LIGHT) return "light"
  return themeDecls(doc).find((t) => t.name === name)?.appearance ?? null
}

/// What the theme resolves to, as the server does: the stored value, else
/// dark for a theme named dark.
export function resolvedThemeAppearance(doc: DesignTokensDoc, name: string): "light" | "dark" | null {
  return themeAppearanceSetting(doc, name) ?? (name === "dark" && declaredThemes(doc).includes("dark") ? "dark" : null)
}

/// Set (or with null, clear) a theme's appearance. Light's is fixed.
export function setThemeAppearance(
  doc: DesignTokensDoc,
  name: string,
  appearance: "light" | "dark" | null,
): DesignTokensDoc {
  if (name === LIGHT) return doc
  const themes = themeDecls(doc).map((t) => {
    if (t.name !== name) return t
    const next: DesignThemeDecl = { ...t }
    if (appearance) next.appearance = appearance
    else delete next.appearance
    return next
  })
  return { ...doc, themes }
}

/// Every theme the document renders in, light first.
export function declaredThemes(doc: DesignTokensDoc): string[] {
  return [LIGHT, ...themeDecls(doc).map((t) => t.name)]
}

/// `high-contrast` → `High Contrast`.
export function defaultThemeLabel(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

export function themeLabel(doc: DesignTokensDoc, name: string): string {
  if (name === LIGHT) return "Light"
  return themeDecls(doc).find((t) => t.name === name)?.label ?? defaultThemeLabel(name)
}

/// Why `name` cannot be used, or null when it can. `renaming` is the theme
/// being renamed: keeping its own name is allowed and does not count twice.
export function themeNameError(doc: DesignTokensDoc, name: string, renaming?: string): string | null {
  if (!THEME_NAME_RE.test(name)) return "Use a lowercase name: a letter, then letters, digits or -."
  if (RESERVED.has(name)) return `${name} is reserved.`
  if (name !== renaming && declaredThemes(doc).includes(name)) return `${name} already exists.`
  if (renaming === undefined && declaredThemes(doc).length >= MAX_THEMES) return `At most ${MAX_THEMES} themes.`
  return null
}

function mapTokens(doc: DesignTokensDoc, fn: (value: DesignTokenValue) => DesignTokenValue): DesignTokensDoc {
  const categories: DesignTokensDoc["categories"] = {}
  for (const [category, tokens] of Object.entries(doc.categories)) {
    const next: Record<string, DesignTokenValue> = {}
    for (const [key, value] of Object.entries(tokens)) next[key] = fn(value)
    categories[category] = next
  }
  return { ...doc, categories }
}

export function addTheme(doc: DesignTokensDoc, name: string, label?: string): DesignTokensDoc {
  const decl: DesignThemeDecl = label ? { name, label } : { name }
  return { ...doc, themes: [...themeDecls(doc), decl] }
}

/// A new theme starting as a copy of `source`'s overrides — the fastest way to
/// start a palette. Duplicating light adds a theme with no overrides (it
/// already renders exactly like light). The copy keeps the source's resolved
/// appearance (#626), so a copy of dark stays dark.
export function duplicateTheme(doc: DesignTokensDoc, source: string, name: string): DesignTokensDoc {
  const withTheme = setThemeAppearance(addTheme(doc, name), name, resolvedThemeAppearance(doc, source))
  if (source === LIGHT) return withTheme
  return mapTokens(withTheme, (value) => (value[source] !== undefined ? { ...value, [name]: value[source] } : value))
}

/// Rename a theme; its values move with it. An explicit label is kept.
export function renameTheme(doc: DesignTokensDoc, from: string, to: string): DesignTokensDoc {
  if (from === LIGHT || from === to) return doc
  const themes = themeDecls(doc).map((t) => (t.name === from ? { ...t, name: to } : t))
  return mapTokens({ ...doc, themes }, (value) => {
    if (value[from] === undefined) return value
    const next: DesignTokenValue = { ...value, [to]: value[from] }
    delete next[from]
    return next
  })
}

/// Delete a theme and every value it held. Light cannot be deleted.
export function deleteTheme(doc: DesignTokensDoc, name: string): DesignTokensDoc {
  if (name === LIGHT) return doc
  const themes = themeDecls(doc).filter((t) => t.name !== name)
  return mapTokens({ ...doc, themes }, (value) => {
    if (value[name] === undefined) return value
    const next: DesignTokenValue = { ...value }
    delete next[name]
    return next
  })
}

/// How many token values `name` overrides — what deleting it would discard.
export function themeOverrideCount(doc: DesignTokensDoc, name: string): number {
  let count = 0
  for (const tokens of Object.values(doc.categories)) {
    for (const value of Object.values(tokens)) {
      if ((value as DesignTokenValue)[name] !== undefined) count += 1
    }
  }
  return count
}

/// Move a theme one place left (-1) or right (1) among the themes besides light.
export function moveTheme(doc: DesignTokensDoc, name: string, delta: -1 | 1): DesignTokensDoc {
  const themes = [...themeDecls(doc)]
  const from = themes.findIndex((t) => t.name === name)
  const to = from + delta
  if (from < 0 || to < 0 || to >= themes.length) return doc
  ;[themes[from], themes[to]] = [themes[to], themes[from]]
  return { ...doc, themes }
}

/// The token's OWN value in `theme`; undefined means it inherits light.
export function ownThemeValue(value: DesignTokenValue, theme: string): string | undefined {
  return theme === LIGHT ? value.light : value[theme]
}

/// Set one theme's value of one token. For a theme other than light, an empty
/// value removes the override, so the token inherits light again.
export function setThemeValue(
  doc: DesignTokensDoc,
  category: string,
  key: string,
  theme: string,
  raw: string,
): DesignTokensDoc {
  const tokens = doc.categories[category] ?? {}
  const next: DesignTokenValue = { ...(tokens[key] ?? { light: "" }) }
  if (theme === LIGHT) next.light = raw
  else if (raw.trim() === "") delete next[theme]
  else next[theme] = raw
  return { ...doc, categories: { ...doc.categories, [category]: { ...tokens, [key]: next } } }
}

/// The value a built-in default becomes when the user overrides it: its light
/// value plus only those theme values whose theme `doc` declares. The defaults
/// carry light/dark, so copying them whole into a project that deleted dark
/// would hand Save a `dark` value the server refuses (`theme-unknown`).
export function overrideFromDefault(doc: DesignTokensDoc, value: DesignTokenValue): DesignTokenValue {
  const declared = new Set(declaredThemes(doc))
  const next: DesignTokenValue = { light: value.light }
  for (const [theme, v] of Object.entries(value)) {
    if (theme !== LIGHT && declared.has(theme) && typeof v === "string") next[theme] = v
  }
  return next
}
