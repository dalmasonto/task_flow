/// The fallback while a lazily loaded v3 page arrives. Quiet on purpose: most
/// chunks land in well under a second, so it waits a beat before showing
/// anything rather than flashing a spinner.
import { useEffect, useState } from "react"

import { Spinner } from "@/components/ui/spinner"

export function PageLoading({ label = "Loading" }: { label?: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 250)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="grid min-h-[50svh] place-items-center" role="status" aria-live="polite">
      {shown ? (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {label}…
        </span>
      ) : (
        <span className="sr-only">{label}…</span>
      )}
    </div>
  )
}
