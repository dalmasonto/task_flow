/// Reading a picked element for the Inspect tab (design.html, #5945): which
/// design tokens colour it and which type and spacing classes it uses, from
/// the classes on the captured element. Pure, tested in inspect-logic.test.ts.

const COLOUR_ROLE: Record<string, string> = { bg: "Background", text: "Text", border: "Border", ring: "Ring", fill: "Fill", stroke: "Stroke" }
/// Tailwind words after `text-` that are sizes or alignment, not colours.
const TEXT_NOT_COLOUR = /^(xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/
const TYPE_SPACING = /^(text-(xs|sm|base|lg|[2-9]?xl)|font-[a-z]+|leading-.+|tracking-.+|[pm][trblxy]?-.+|gap(-[xy])?-.+|space-[xy]-.+|rounded(-.+)?|uppercase|lowercase|capitalize|italic|truncate)$/

/// The classes on the element itself (the first tag of the snippet).
export function rootClasses(snippet: string): string[] {
  const tag = /^\s*<[a-zA-Z][^>]*>/.exec(snippet)?.[0] ?? ""
  const cls = /\sclass\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? /\sclass\s*=\s*'([^']*)'/.exec(tag)?.[1] ?? ""
  return cls.split(/\s+/).filter(Boolean)
}

export type ColourUse = { role: string; token: string }

/// `bg-muted`, `text-foreground`, `border-border/60` → token colours, by role.
/// Variants (`hover:`, `dark:`) are left out: they aren't what's on screen.
export function colourUses(classes: string[]): ColourUse[] {
  const out: ColourUse[] = []
  for (const c of classes) {
    if (c.includes(":")) continue
    const m = /^(bg|text|border|ring|fill|stroke)-([a-z][a-z0-9-]*?)(\/\d+)?$/.exec(c)
    if (!m) continue
    const [, kind, token] = m
    if (kind === "text" && TEXT_NOT_COLOUR.test(token)) continue
    if (kind === "border" && /^(\d+|[xytblrse](-\d+)?|solid|dashed|dotted|double|none|hidden|collapse|separate)$/.test(token)) continue
    if (!out.some((u) => u.role === COLOUR_ROLE[kind] && u.token === token)) out.push({ role: COLOUR_ROLE[kind], token })
  }
  return out
}

export function typeAndSpacing(classes: string[]): string[] {
  return classes.filter((c) => !c.includes(":") && TYPE_SPACING.test(c))
}
