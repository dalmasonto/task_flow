/// The v3 docs pages read the REAL guides: documentation/docs/v2.0.0/*.mdx, the
/// same files the published docs site builds from. One source, so the in-app
/// docs never drift from the site.
///
/// The pure helpers (frontmatter, callouts, links, sections, search) are tested in
/// docs-content.test.ts; `loadDocs()` binds them to the files via Vite's glob.

export type Doc = {
  /// Path under the docs root without `.mdx`; `index` files collapse to their folder.
  slug: string
  title: string
  description: string
  position: number
  section: DocSection
  /// Markdown, with MDX-only syntax turned into plain markdown.
  body: string
  /// An `index.mdx`: its relative links resolve against its own folder.
  isIndex: boolean
}

export type DocSection = "Get started" | "Agents" | "Your own server" | "Reference"
export const DOC_SECTIONS: DocSection[] = ["Get started", "Agents", "Your own server", "Reference"]

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim()
  }
  return { meta, body: raw.slice(m[0].length) }
}

/// `<Callout type="info">text</Callout>` → a blockquote whose first line names
/// the kind (`> **Note**`), which the docs renderer styles as a callout.
export function calloutsToMarkdown(body: string): string {
  return body.replace(/<Callout(?:\s+type="(\w+)")?\s*>\s*([\s\S]*?)\s*<\/Callout>/g, (_, type: string | undefined, inner: string) => {
    const label = type === "warning" || type === "danger" ? "Warning" : type === "tip" ? "Tip" : "Note"
    const lines = [`**${label}**`, "", ...inner.split(/\r?\n/)]
    return lines.map((l) => (l ? `> ${l}` : ">")).join("\n")
  })
}

export function slugFromPath(path: string): string {
  const rel = path.replace(/^.*\/docs\/v2\.0\.0\//, "").replace(/\.mdx?$/, "")
  return rel === "index" ? "" : rel.replace(/\/index$/, "")
}

/// Resolve a link inside a doc against that doc's slug. Relative doc links
/// (`./self-hosting`, `../self-hosting`) become `/v3/docs/<slug>`; anything
/// absolute, external or a bare `#fragment` is left alone. A page resolves
/// against its folder (agents/claude → agents/); an index page IS its folder
/// (agents/index → agents/), so its `./claude` means agents/claude.
export function resolveDocLink(fromSlug: string, href: string, isIndex = false): string {
  if (/^([a-z]+:|\/\/|#|\/)/i.test(href)) return href
  const [pathPart, hash = ""] = href.split("#")
  const parts = fromSlug ? fromSlug.split("/") : []
  const base = isIndex ? parts : parts.slice(0, -1)
  const out = [...base]
  for (const seg of pathPart.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") out.pop()
    else out.push(seg.replace(/\.mdx?$/, ""))
  }
  const slug = out.join("/").replace(/(^|\/)index$/, "")
  return `/v3/docs${slug ? `/${slug}` : ""}${hash ? `#${hash}` : ""}`
}

export function sectionOf(slug: string): DocSection {
  if (slug.startsWith("agents")) return "Agents"
  if (slug === "self-hosting" || slug === "configuration") return "Your own server"
  if (slug.startsWith("api")) return "Reference"
  return "Get started"
}

export function toDoc(path: string, raw: string): Doc {
  const { meta, body } = parseFrontmatter(raw)
  const slug = slugFromPath(path)
  return {
    slug,
    title: meta.title || slug || "Docs",
    description: meta.description ?? "",
    position: Number(meta.sidebar_position ?? 99),
    section: sectionOf(slug),
    body: calloutsToMarkdown(body),
    isIndex: /(^|\/)index\.mdx?$/.test(path),
  }
}

export function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort(
    (a, b) => DOC_SECTIONS.indexOf(a.section) - DOC_SECTIONS.indexOf(b.section) || a.position - b.position || a.title.localeCompare(b.title),
  )
}

/// Title and description hits rank above body hits. Case-insensitive, every word must appear.
export function searchDocs(docs: Doc[], query: string): Doc[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const score = (d: Doc) => {
    const head = `${d.title} ${d.description}`.toLowerCase()
    const all = `${head} ${d.body.toLowerCase()}`
    if (!words.every((w) => all.includes(w))) return 0
    return words.reduce((n, w) => n + (head.includes(w) ? 3 : 1), 0)
  }
  return docs
    .map((d) => [d, score(d)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d)
}

/// The `##` headings of a doc, for the "On this page" rail. Ids match the
/// renderer's slugger (lowercase, words joined by `-`).
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
}

export function docHeadings(body: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = []
  let inFence = false
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence && /^##\s+(.+?)\s*#*$/.exec(line)
    if (m) out.push({ id: headingId(m[1]), text: m[1].replace(/[`*_]/g, "") })
  }
  return out
}

let cache: Doc[] | null = null

export function loadDocs(): Doc[] {
  if (cache) return cache
  const files = import.meta.glob("../../../../documentation/docs/v2.0.0/**/*.mdx", { query: "?raw", import: "default", eager: true }) as Record<string, string>
  cache = sortDocs(Object.entries(files).map(([path, raw]) => toDoc(path, raw)))
  return cache
}
