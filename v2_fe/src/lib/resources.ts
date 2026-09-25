/// The project's external resource document — mirrors the backend's
/// `taskflow-design/resources.rs` serde shapes exactly.
///
/// A *set* is a named, toggleable group of links ("Inter", "Analytics"): the
/// thing a user turns on or off. The links in it are the `<link>`/`<script>`
/// tags that set needs in the page's `<head>` — a web font's stylesheet plus
/// its two `preconnect`s, say. Toggling is what makes the feature useful: a font
/// can be kept in the document while contributing nothing to the page.
///
/// Tolerant read, strict write, exactly like `design-layout.ts`: the server
/// validates and self-heals, and this module only guarantees that a bad
/// response renders the empty document rather than throwing into the editor.

export type ResourceLink = {
  /// Present for `<link>` shapes. One of `preconnect`, `dns-prefetch`,
  /// `stylesheet` — there is no `preload`, because a preload without an `as`
  /// attribute fetches nothing and this model has no `as` field.
  rel?: string
  href?: string
  crossorigin: boolean
  /// Present for `<script>` shapes. A link carries ONE of `href`/`script`:
  /// the server refuses one carrying both, and an empty string counts as
  /// present, so the absent field must be ABSENT rather than blank.
  script?: string
  /// True when this link is a `<script src>` rather than a `<link>`.
  isScript: boolean
  isAsync: boolean
}

export type ResourceSet = {
  id: string
  name: string
  enabled: boolean
  links: ResourceLink[]
}

export type ResourcesDoc = {
  version: number
  sets: ResourceSet[]
}

export const DEFAULT_RESOURCES_DOC: ResourcesDoc = { version: 1, sets: [] }

/// The server's caps (`resources.rs`), mirrored so the editor cannot build a
/// document `validate` will refuse — the rule `createGroup` states for the
/// canvas layout. `MAX_HREF` is deliberately NOT here: see `appendLinks`.
export const MAX_SETS = 24
export const MAX_SET_NAME = 60
export const MAX_LINKS_PER_SET = 16

// ---------------------------------------------------------------------------
// Read-side parse
// ---------------------------------------------------------------------------

/// A non-blank string, or nothing. Blank counts as ABSENT, not as "": the
/// server treats a present-but-empty url field as present, which is how a blank
/// field turns into a refusal naming the wrong cause. This is a shape rule and
/// never a look at the url's own characters — scheme, length and NUL are the
/// server's to refuse, with a message the user can act on.
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

function normalizeLink(raw: unknown): ResourceLink | null {
  if (!raw || typeof raw !== "object") return null
  const l = raw as Record<string, unknown>
  const isScript = l.isScript === true
  const script = str(l.script)
  const href = str(l.href)
  const rel = str(l.rel)
  // A link survives on the address its OWN shape declares: `url_of` reads
  // exactly one of the two fields, so a href on a script shape would be
  // stranded somewhere no reader looks. Such a link (or one with no address at
  // all) cannot be stored by a validated write, and carrying it would only
  // resurface as "has no src" against a row the user cannot see.
  if (isScript ? !script : !href) return null
  const link: ResourceLink = {
    crossorigin: l.crossorigin === true,
    isScript,
    isAsync: l.isAsync === true,
  }
  if (isScript) {
    if (script) link.script = script
  } else {
    if (href) link.href = href
    if (rel) link.rel = rel
  }
  return link
}

function normalizeSet(raw: unknown): ResourceSet | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>
  const id = str(s.id)
  const name = str(s.name)
  if (!id || !name) return null
  return {
    // Only an explicit `false` disables: absent is the server's own default
    // (`#[serde(default = "default_true")]`), and anything else is a document
    // this build should not read as "off".
    enabled: s.enabled !== false,
    id,
    name,
    links: (Array.isArray(s.links) ? s.links : []).flatMap((l): ResourceLink[] => {
      const link = normalizeLink(l)
      return link ? [link] : []
    }),
  }
}

/// Tolerant read of the stored document, for a response from a newer build or a
/// schema that moved under a cached tab. A client that renders the empty
/// document is recoverable; one that throws on load is not.
export function normalizeResources(raw: unknown): ResourcesDoc {
  if (!raw || typeof raw !== "object") return { version: 1, sets: [] }
  const obj = raw as Record<string, unknown>
  return {
    version:
      typeof obj.version === "number" && Number.isFinite(obj.version) ? obj.version : 1,
    sets: (Array.isArray(obj.sets) ? obj.sets : []).flatMap((s): ResourceSet[] => {
      const set = normalizeSet(s)
      return set ? [set] : []
    }),
  }
}

// ---------------------------------------------------------------------------
// Set edits — non-mutating, and identity means "nothing happened"
// ---------------------------------------------------------------------------

/// Set ids are opaque to the server; a counter plus a nonce is enough (they
/// only need to be unique inside one document and stable across a save).
/// Mirrors `design-layout.ts`'s `nextGroupId` exactly — the server refuses a
/// duplicate id by design, so collisions must not be possible here.
let setSeq = 0
function nextSetId(): string {
  setSeq += 1
  return `s${Date.now().toString(36)}${setSeq.toString(36)}`
}

/// Flip one set's toggle. An unknown id returns the document itself, so the
/// caller can tell "nothing happened" by identity.
export function toggleSet(doc: ResourcesDoc, id: string): ResourcesDoc {
  if (!doc.sets.some((s) => s.id === id)) return doc
  return {
    ...doc,
    sets: doc.sets.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
  }
}

/// Why `addSet` refuses this name, phrased for the person who typed it — or
/// `null` when it would accept. The rules live here, beside the checks they
/// explain, so the message and the refusal cannot drift apart, and the editor
/// can show the reason instead of an "Add set" that does nothing.
///
/// The server's own wording for these three is close (see `resources.rs`);
/// these are the UI's, and are not used as the save-time verdict.
export function setNameProblem(doc: ResourcesDoc, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "A resource set needs a name."
  if ([...trimmed].length > MAX_SET_NAME) {
    return `A set name is limited to ${MAX_SET_NAME} characters.`
  }
  if (doc.sets.some((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" is already a set name.`
  }
  if (doc.sets.length >= MAX_SETS) return `At most ${MAX_SETS} resource sets.`
  return null
}

/// A new empty (enabled) set, or the document unchanged plus `id: ""` when the
/// name is refused — matching the server's rule, so the UI cannot build a
/// document the server will reject.
///
/// The name is measured in code points (`chars()` on the Rust side), not UTF-16
/// units: counting units would refuse a 60-emoji name the server accepts, and
/// that refusal would have no message anywhere.
export function addSet(doc: ResourcesDoc, name: string): { doc: ResourcesDoc; id: string } {
  if (setNameProblem(doc, name) !== null) return { doc, id: "" }
  const id = nextSetId()
  return {
    doc: {
      ...doc,
      sets: [...doc.sets, { id, name: name.trim(), enabled: true, links: [] }],
    },
    id,
  }
}

/// Remove a set. Its links go with it — unlike the canvas layout, there is no
/// ungrouped tail for them to fall back into.
export function removeSet(doc: ResourcesDoc, id: string): ResourcesDoc {
  const sets = doc.sets.filter((s) => s.id !== id)
  return sets.length === doc.sets.length ? doc : { ...doc, sets }
}

/// Remove one link from a set, addressed by position — the row the user is
/// looking at. Needed because `validate` refuses the ENTIRE document over a
/// single bad link and the manifest then contributes nothing: without this, one
/// stale `javascript:` url leaves every font in the project dead and the only
/// fix is to delete the whole set.
export function removeLink(doc: ResourcesDoc, setId: string, index: number): ResourcesDoc {
  const set = doc.sets.find((s) => s.id === setId)
  if (!set || index < 0 || index >= set.links.length) return doc
  return {
    ...doc,
    sets: doc.sets.map((s) =>
      s.id === setId ? { ...s, links: s.links.filter((_, i) => i !== index) } : s
    ),
  }
}

/// Append links to a set, stopping at `MAX_LINKS_PER_SET` and reporting what it
/// could not take. The document comes back by identity when nothing fit, so the
/// caller can distinguish "appended nothing" from "appended an empty list".
///
/// This is the ONLY path pasted links may take into a document. It caps the
/// set's length — an entity the UI creates — and deliberately does not inspect
/// a link's content: `MAX_HREF` is not mirrored, because "a url is limited to
/// 2048 characters" is a message the user can act on, and dropping what they
/// pasted would be a silence they cannot.
export function appendLinks(
  doc: ResourcesDoc,
  setId: string,
  links: ResourceLink[]
): { doc: ResourcesDoc; added: number; skipped: number } {
  const set = doc.sets.find((s) => s.id === setId)
  const room = set ? Math.max(0, MAX_LINKS_PER_SET - set.links.length) : 0
  const take = links.slice(0, room)
  if (!set || take.length === 0) return { doc, added: 0, skipped: links.length }
  return {
    doc: {
      ...doc,
      sets: doc.sets.map((s) => (s.id === setId ? { ...s, links: [...s.links, ...take] } : s)),
    },
    added: take.length,
    skipped: links.length - take.length,
  }
}

// ---------------------------------------------------------------------------
// Paste import
// ---------------------------------------------------------------------------

/// Tag bodies are matched with `[^>]*`: a `>` inside a quoted attribute value
/// would end the tag early, which is not worth a real tokenizer for a paste box
/// whose output the server validates anyway.
const TAG_RE = /<(link|script)\b([^>]*)>/gi

/// The standard HTML attribute pattern: quoted (either kind) or unquoted
/// values, plus bare attributes (`crossorigin`, `async`) parsed as `true`.
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttrs(source: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(source))) {
    const value = m[2] ?? m[3] ?? m[4]
    attrs[m[1].toLowerCase()] = value === undefined ? true : value
  }
  return attrs
}

/// Read `<link>`/`<script>` tags out of pasted markup — the way a user actually
/// gets a Google Fonts set into this document: the font site hands them three
/// tags and they have nowhere to put them.
///
/// It PARSES and does not judge. A `javascript:` url comes through untouched,
/// because the server refuses it with a message the user can act on and a
/// client that silently dropped it would leave a dead box. Correspondingly it
/// applies no caps: `appendLinks` is the capped path, and the two concerns stay
/// separately testable.
///
/// The only thing "dropped" is a tag with no address at all (an inline
/// `<script>`, a `<link>` with no `href`): there is nowhere in the document
/// shape to put inline code, and a link with no url is refused server-side
/// against a row the user cannot see.
export function parsePastedLinks(text: string): ResourceLink[] {
  const links: ResourceLink[] = []
  if (!text) return links
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text))) {
    const attrs = parseAttrs(m[2])
    const isScript = m[1].toLowerCase() === "script"
    const raw = attrs[isScript ? "src" : "href"]
    const url = typeof raw === "string" ? raw.trim() : ""
    if (!url) continue
    if (isScript) {
      // No `href`, no `rel`: see `ResourceLink.script`.
      links.push({
        crossorigin: attrs.crossorigin !== undefined,
        script: url,
        isScript: true,
        isAsync: attrs.async !== undefined,
      })
      continue
    }
    const link: ResourceLink = {
      crossorigin: attrs.crossorigin !== undefined,
      isScript: false,
      isAsync: false,
    }
    link.href = url
    const rel = typeof attrs.rel === "string" ? attrs.rel.trim() : ""
    // A missing `rel` is left out rather than defaulted to `stylesheet`: the
    // server's own refusal names the allowed set, which is a better hint than a
    // guess this module made for the user.
    if (rel) link.rel = rel
    links.push(link)
  }
  return links
}
