/// Typed reference tags: ONE registry for every shortcut markdown turns into a
/// chip (Dalmas, #MSG5639 and #MSG5659; design doc "Typed reference tags").
///
///   #TSK123              task
///   #MSG3456             chat message
///   #GHI12[@owner/name]  GitHub issue (the project's default repo when unqualified)
///   #GHP44[@owner/name]  GitHub pull request
///   #NOTE7               note (reserved: resolves once notes exist)
///
/// A bare `#123` is plain text. It used to mean a task, which made every number
/// after a `#` (message ids, issue numbers, "#1 priority") cost a task lookup
/// and point confidently at the wrong thing.
///
/// The older prefixed forms stay readable because they are unambiguous and old
/// messages use them: `TASK#12`, `#gh12`, `owner/repo#gh12`, `#msg12`.
///
/// Adding a shortcut means adding one entry to REF_DEFS. The renderer never
/// changes. Matching runs on markdown TEXT nodes only (see remarkRefChips in
/// markdown-renderer.tsx), so code spans, code blocks and link URLs are never
/// parsed.

export type RefKind = "task" | "message" | "github-issue" | "github-pr" | "note"

export type RefMatch = { kind: RefKind; id: number; repo?: string; raw: string }

type RefDef = {
  kind: RefKind
  /// A regex source with exactly two groups: (id) then optional (owner/name).
  source: string
}

const REPO = "[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+"

/// Order matters only where one form is a prefix of another; longer first.
export const REF_DEFS: RefDef[] = [
  { kind: "task", source: `#TSK(\\d+)()` },
  { kind: "message", source: `#MSG(\\d+)()` },
  { kind: "github-issue", source: `#GHI(\\d+)(?:@(${REPO}))?` },
  { kind: "github-pr", source: `#GHP(\\d+)(?:@(${REPO}))?` },
  { kind: "note", source: `#NOTE(\\d+)()` },
  // Legacy forms, still resolved so old messages keep their links.
  { kind: "task", source: `TASK#(\\d+)()` },
  // `owner/repo#gh12`: the repo comes FIRST here, so the groups are swapped back
  // in matchAt() (see `repoFirst`).
  { kind: "github-issue", source: `(${REPO})#gh(\\d+)` },
  { kind: "github-issue", source: `#gh(\\d+)()` },
]

/// Entries whose first group is the repo rather than the id.
const REPO_FIRST = new Set([REF_DEFS.findIndex((d) => d.source.startsWith(`(${REPO})#gh`))])

// One alternation, scanned left to right, so matches come out in order. Each
// entry is wrapped in a named-free capturing group; we find which one hit by
// walking the group offsets. `(?<![\w/])` keeps `abc#TSK1` and URL paths out,
// and `(?!\w)` keeps `#TSK12abc` from matching as #TSK12.
const COMBINED = new RegExp(REF_DEFS.map((d) => `(${d.source})`).join("|").replace(/^/, "(?<![\\w/])(?:") + ")(?!\\w)", "gi")

function matchAt(m: RegExpExecArray): RefMatch | null {
  // Each def contributes 3 groups: the wrapper, then its two inner groups.
  for (let i = 0; i < REF_DEFS.length; i++) {
    const base = 1 + i * 3
    if (m[base] === undefined) continue
    const [a, b] = [m[base + 1], m[base + 2]]
    const [id, repo] = REPO_FIRST.has(i) ? [b, a] : [a, b]
    return { kind: REF_DEFS[i].kind, id: Number(id), repo: repo || undefined, raw: m[0] }
  }
  return null
}

export type RefSegment = { type: "text"; value: string } | ({ type: "ref" } & RefMatch)

/// Split text into plain runs and references. Empty input gives [].
export function splitRefs(text: string): RefSegment[] {
  const out: RefSegment[] = []
  let last = 0
  COMBINED.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = COMBINED.exec(text))) {
    const ref = matchAt(m)
    if (!ref) continue
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) })
    out.push({ type: "ref", ...ref })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) })
  return out
}

/// The canonical spelling, for chip labels and for MCP instructions.
export function formatRef(ref: Pick<RefMatch, "kind" | "id" | "repo">): string {
  const repo = ref.repo ? `@${ref.repo}` : ""
  switch (ref.kind) {
    case "task":
      return `#TSK${ref.id}`
    case "message":
      return `#MSG${ref.id}`
    case "github-issue":
      return `#GHI${ref.id}${repo}`
    case "github-pr":
      return `#GHP${ref.id}${repo}`
    case "note":
      return `#NOTE${ref.id}`
  }
}

/// A link fragment the URL sanitizer allows, carrying the ref to the `a`
/// renderer: `#ref-<kind>-<id>[-<owner/name>]`.
export function refHref(ref: Pick<RefMatch, "kind" | "id" | "repo">): string {
  return `#ref-${ref.kind}-${ref.id}${ref.repo ? `-${ref.repo}` : ""}`
}

export function parseRefHref(href: string | undefined): Omit<RefMatch, "raw"> | null {
  const m = /^#ref-(task|message|github-issue|github-pr|note)-(\d+)(?:-(.+))?$/.exec(href ?? "")
  return m ? { kind: m[1] as RefKind, id: Number(m[2]), repo: m[3] } : null
}
