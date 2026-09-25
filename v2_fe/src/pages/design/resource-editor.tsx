/// The project's external resources: named, toggleable sets of the links a page
/// needs in order to look right — a web font and its companion preconnects, a
/// third-party script. Every composed page and the exported `page.html` carry
/// the ENABLED sets' links in their `<head>`, so this editor is the only way a
/// font reaches a page without hand-writing `styles/resources.json`.
///
/// Modelled on `TokenEditor` next door — same `design-api` pair, same
/// load/save/error states, same `{ projectId, onSaved }` props, because both
/// answer "how does this project look". Two things differ, and both are about
/// what the server does with a bad document:
///
/// * A save has THREE outcomes, not two. The validator's `errors` are the
///   user's only feedback (a `javascript:` url is refused with a message, and
///   the manifest then contributes NOTHING — one stale url silently removes
///   every font in the project), and a version conflict means this editor went
///   stale and saved nothing while looking like it worked.
/// * Links are edited by PASTING a snippet, because that is the form the user
///   has them in — the font site hands them `<link>` tags. `parsePastedLinks`
///   does the reading and `appendLinks` the capped appending; neither judges a
///   url, and neither is bypassed here.

import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  fetchDesignResources,
  putDesignResources,
  type ValidationError,
} from "@/lib/design-api"
import {
  MAX_LINKS_PER_SET,
  addSet,
  appendLinks,
  parsePastedLinks,
  removeLink,
  removeSet,
  setNameProblem,
  toggleSet,
  type ResourceLink,
  type ResourceSet,
  type ResourcesDoc,
} from "@/lib/resources"

/// What the paste box tells the user afterwards, and whether it is a warning
/// (something was skipped) rather than a plain confirmation.
type PasteOutcome = { message: string; warn: boolean }

function LinkRow({ link, onRemove }: { link: ResourceLink; onRemove: () => void }) {
  // Whatever the document actually addresses: a link carries one url field or
  // the other, never both (`resources::validate` refuses that).
  const url = link.isScript ? link.script : link.href
  return (
    <div className="flex items-center gap-1">
      <span className="shrink-0 rounded bg-muted px-1 font-mono text-[9px] uppercase tracking-wide">
        {link.isScript ? "script" : link.rel || "link"}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={url}>
        {url}
      </span>
      {link.isAsync ? (
        <span className="shrink-0 text-[9px] text-muted-foreground">async</span>
      ) : null}
      {link.crossorigin ? (
        <span className="shrink-0 text-[9px] text-muted-foreground">cors</span>
      ) : null}
      <button
        type="button"
        title="Remove this link"
        onClick={onRemove}
        className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        ×
      </button>
    </div>
  )
}

/// Paste-a-snippet, the way links actually arrive. The button says how many
/// landed and how many the cap turned away, so a full set is never a silence.
function PasteForm({ onPaste }: { onPaste: (text: string) => PasteOutcome }) {
  const [text, setText] = useState("")
  const [outcome, setOutcome] = useState<PasteOutcome | null>(null)
  return (
    <form
      className="mt-1 flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim()) return
        setOutcome(onPaste(text))
        setText("")
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Paste <link> or <script> tags here"
        className="w-full rounded border bg-transparent px-1 py-0.5 font-mono text-[10px]"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70"
        >
          + Add links
        </button>
        {outcome ? (
          <span
            className={
              outcome.warn
                ? "min-w-0 flex-1 truncate text-[9px] text-amber-600"
                : "min-w-0 flex-1 truncate text-[9px] text-muted-foreground"
            }
            title={outcome.message}
          >
            {outcome.message}
          </span>
        ) : null}
      </div>
    </form>
  )
}

function SetRow({
  set,
  onToggle,
  onRemove,
  onRemoveLink,
  onPaste,
}: {
  set: ResourceSet
  onToggle: () => void
  onRemove: () => void
  onRemoveLink: (index: number) => void
  onPaste: (text: string) => PasteOutcome
}) {
  return (
    <div className="border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={set.enabled}
          onChange={onToggle}
          title={
            set.enabled
              ? "Enabled — every page loads these links"
              : "Off — kept, but no page loads it"
          }
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={set.name}>
          {set.name}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
          {set.links.length}/{MAX_LINKS_PER_SET}
        </span>
        <button
          type="button"
          title={`Remove ${set.name}`}
          onClick={onRemove}
          className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          ×
        </button>
      </div>
      {set.links.length ? (
        <div className="mt-1 flex flex-col gap-0.5 pl-5">
          {set.links.map((link, index) => (
            <LinkRow
              key={`${index}:${link.href ?? link.script ?? ""}`}
              link={link}
              onRemove={() => onRemoveLink(index)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-1 pl-5 text-[10px] text-muted-foreground">No links yet.</p>
      )}
      <div className={set.enabled ? "pl-5" : "pl-5 opacity-60"}>
        <PasteForm onPaste={onPaste} />
      </div>
    </div>
  )
}

export function ResourceEditor({
  projectId,
  onSaved,
}: {
  projectId: number
  onSaved: () => void
}) {
  const [doc, setDoc] = useState<ResourcesDoc | null>(null)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<ValidationError[] | null>(null)
  const [newName, setNewName] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { doc, version } = await fetchDesignResources(projectId)
      setDoc(doc)
      setVersion(version)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load resources.")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    if (!doc) return
    setSaving(true)
    setErrors(null)
    try {
      const result = await putDesignResources(projectId, doc, version)
      if (!result.ok) {
        if ("errors" in result) {
          // The validator's verdict, verbatim. It is the whole feedback loop:
          // the server refuses the document as a whole, so without these the
          // save is a dead button.
          setErrors(result.errors)
        } else {
          // The stale-editor arm. Silently doing nothing here would look like a
          // save that worked; "Reload" above is the way out.
          setErrors([
            {
              line: 0,
              rule: "conflict",
              message:
                "Someone changed resources.json after this editor loaded it — Reload, then reapply the change.",
            },
          ])
        }
        return
      }
      onSaved()
      await load() // refetch — picks up the new version
    } catch (err) {
      setErrors([
        {
          line: 0,
          rule: "network",
          message: err instanceof Error ? err.message : "Save failed.",
        },
      ])
    } finally {
      setSaving(false)
    }
  }

  const handleAddSet = () => {
    if (!doc) return
    const { doc: next, id } = addSet(doc, newName)
    if (!id) return // `setNameProblem` already said why, beside the form
    setDoc(next)
    setNewName("")
  }

  /// The paste box's whole behaviour: parse, then append through the capped
  /// helper — never splicing the parse result into a set directly, so the
  /// per-set cap is the only thing that can turn a paste away, and it says so.
  const handlePaste = (setId: string, text: string): PasteOutcome => {
    if (!doc) return { message: "", warn: false }
    const parsed = parsePastedLinks(text)
    if (!parsed.length) {
      return { message: "No <link> or <script> tag with a url in that text.", warn: true }
    }
    const result = appendLinks(doc, setId, parsed)
    if (!result.added) {
      return { message: `Already at the ${MAX_LINKS_PER_SET}-link limit for this set.`, warn: true }
    }
    setDoc(result.doc)
    if (result.skipped) {
      return {
        message: `Added ${result.added}; skipped ${result.skipped} over the ${MAX_LINKS_PER_SET}-link limit.`,
        warn: true,
      }
    }
    return { message: `Added ${result.added} ${result.added === 1 ? "link" : "links"}.`, warn: false }
  }

  const addProblem = doc ? setNameProblem(doc, newName) : null

  return (
    <div className="flex flex-col border-t">
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2">
        <p className="mr-auto font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          External resources
        </p>
        <Button size="sm" variant="outline" disabled={!doc || saving} onClick={() => void handleSave()}>
          {saving ? "Saving…" : "Save resources"}
        </Button>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Reload"}
        </Button>
      </div>
      <p className="px-3 pb-1 text-[10px] text-muted-foreground">
        Enabled sets load in every page's head, and in the exported page.html.
      </p>

      {loading && !doc ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading resources…</p>
      ) : null}
      {loadError ? <p className="px-3 py-2 text-xs text-destructive">{loadError}</p> : null}

      {doc && !loading ? (
        <>
          {doc.sets.map((set) => (
            <SetRow
              key={set.id}
              set={set}
              onToggle={() => setDoc(toggleSet(doc, set.id))}
              onRemove={() => setDoc(removeSet(doc, set.id))}
              onRemoveLink={(index) => setDoc(removeLink(doc, set.id, index))}
              onPaste={(text) => handlePaste(set.id, text)}
            />
          ))}
          {!doc.sets.length ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              No resource sets yet — add one, then paste its links in.
            </p>
          ) : null}
          <form
            className="flex items-center gap-1 px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              handleAddSet()
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Inter (Google Fonts)"
              className="h-6 w-44 rounded border bg-transparent px-1 font-mono text-[10px]"
            />
            <button
              type="submit"
              disabled={!doc || addProblem !== null}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-50"
            >
              + Add set
            </button>
          </form>
          {addProblem && newName.trim() ? (
            <p className="px-3 pb-2 text-[10px] text-amber-600">{addProblem}</p>
          ) : null}
        </>
      ) : null}

      {errors?.length ? (
        <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/10 p-2">
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] text-destructive">
              {e.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
