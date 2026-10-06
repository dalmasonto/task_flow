/// The token panel's "CSS variables" tab (#619): the SAVED tokens as the
/// generated CSS — `:root`, one block per theme, and the `@theme inline`
/// bridge — read-only. `epoch` changes after a save so the view refetches.

import { useEffect, useState } from "react"

import { fetchTokensCss } from "@/lib/design-api"

export function TokenCssView({ projectId, epoch }: { projectId: number; epoch: number }) {
  const [css, setCss] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchTokensCss(projectId)
      .then((text) => {
        if (cancelled) return
        setCss(text)
        setError(null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, epoch])

  return (
    <div className="flex flex-col">
      <p className="px-3 pt-2 text-[10px] text-muted-foreground">
        The saved tokens as CSS — read-only. Save in the Theme tab to update it.
      </p>
      {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {css === null && !error ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading CSS…</p> : null}
      {css !== null ? (
        <pre className="mx-3 my-2 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {css}
        </pre>
      ) : null}
    </div>
  )
}
