/// #520: the version history of one page — list, preview, restore.
///
/// v1 scope, deliberately: no diffs. The question this answers is "put it back
/// the way it was", and both halves of that are here — the list (what versions
/// exist, who made them, when, and whether one was a deletion) and the two
/// actions that matter:
///
/// - **Preview** opens the page AT THAT VERSION in a new tab, through the
///   sandbox's `?rev=`, so it renders with the tokens and components of its
///   time. Previewing a version next to today's tokens would show something
///   that never existed, which is the whole reason the revision rides along.
/// - **Restore** writes the old content back as a NEW version. Nothing is
///   destroyed by looking, and nothing is destroyed by restoring either: the
///   version being replaced stays in the list.

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RotateCcwIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react"

import {
  fetchDesignVersions,
  restoreDesignVersion,
  sandboxUrl,
  type DesignFileVersionSummary,
} from "@/lib/design-api"

export function VersionHistoryDialog({
  open,
  onOpenChange,
  projectId,
  route,
  path,
  label,
  getSandboxToken,
  onRestored,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  /** The route this page serves — what a preview opens. */
  route: string
  /** The page file whose history this is (`pages/<name>.html`). */
  path: string
  label: string
  getSandboxToken: () => Promise<string>
  /** A restore landed: the surface refreshes its manifest (the realtime echo
   *  also remounts the boards, so this is only for the panel's own reads). */
  onRestored: () => void
}) {
  const [versions, setVersions] = useState<DesignFileVersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyVersion, setBusyVersion] = useState<number | null>(null)

  // Load on open — and on a PATH change while open, so switching pages from
  // the panel cannot leave another page's history on screen.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setVersions(null)
    setError(null)
    fetchDesignVersions(projectId, path)
      .then((rows) => {
        if (!cancelled) setVersions(rows)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [open, projectId, path])

  const preview = async (version: DesignFileVersionSummary) => {
    const token = await getSandboxToken()
    // The revision, not the version number: `?rev` speaks the project
    // timeline, so the page comes back with the files it was composed with.
    window.open(`${sandboxUrl(token, route)}?rev=${version.project_revision}`, "_blank", "noopener")
  }

  const restore = async (version: DesignFileVersionSummary) => {
    setBusyVersion(version.version)
    setError(null)
    try {
      await restoreDesignVersion(projectId, path, version.version)
      const rows = await fetchDesignVersions(projectId, path)
      setVersions(rows)
      onRestored()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore that version.")
    } finally {
      setBusyVersion(null)
    }
  }

  const current = versions?.find((v) => !v.deleted)?.version

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history — {label}</DialogTitle>
          <DialogDescription>
            The last versions of {path}, newest first. Preview opens it as it rendered then; a restore
            writes that content back as a new version, so nothing here is ever lost.
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

        {versions === null && !error ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading versions…</p>
        ) : null}

        {versions && versions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No versions recorded yet — history begins with the next write.
          </p>
        ) : null}

        {versions && versions.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {versions.map((version) => (
              <li key={`${version.version}-${version.project_revision}`} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    v{version.version}
                    {version.version === current ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">current</span>
                    ) : null}
                    {version.deleted ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <Trash2Icon className="size-3" /> deleted
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatWhen(version.created_at)} · {version.updated_by} · {formatBytes(version.bytes)}
                  </p>
                </div>
                {!version.deleted ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Open this version in a new tab, as it rendered then"
                    onClick={() => void preview(version)}
                  >
                    <ExternalLinkIcon className="size-4" />
                    Preview
                  </Button>
                ) : null}
                {version.version !== current && !version.deleted ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyVersion !== null}
                    title={`Write v${version.version}'s content back as a new version`}
                    onClick={() => void restore(version)}
                  >
                    <RotateCcwIcon className="size-4" />
                    {busyVersion === version.version ? "Restoring…" : "Restore"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/// "2 hours ago" reads the timeline better than a wall clock; the exact time
/// is the title attribute for anyone who needs it.
function formatWhen(iso: string | null): string {
  if (!iso) return "unknown time"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "unknown time"
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}
