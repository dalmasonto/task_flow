/// You're offline (design: offline.html): a strip at the top of every app
/// page when the browser is offline, or when the live connection has been
/// reconnecting long enough that the server is unreachable (not a blip).
/// What's on screen stays as last loaded; "Retry now" reloads the workspace.
import { useEffect, useState } from "react"
import { WifiOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { useWorkspace } from "../workspace"
import { connectionNotice, useOnline } from "./system-logic"

export function OfflineBanner() {
  const { realtimeStatus, refresh } = useWorkspace()
  const online = useOnline()
  // When the stream started reconnecting; cleared when it's live again.
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const reconnecting = realtimeStatus === "reconnecting"

  useEffect(() => {
    if (!reconnecting && online) return
    const start = Date.now()
    const t0 = window.setTimeout(() => setSince(start), 0)
    const tick = window.setInterval(() => setNow(Date.now()), 2_000)
    return () => {
      window.clearTimeout(t0)
      window.clearInterval(tick)
      setSince(null)
    }
  }, [reconnecting, online])

  const notice = connectionNotice(online, realtimeStatus, since ? now - since : 0)
  if (!notice) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b border-blocked/30 bg-blocked/10 px-4 py-2.5 lg:px-6">
      <WifiOffIcon className="size-4 shrink-0 text-blocked" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{notice === "offline" ? "You're offline." : "Can't reach the server."}</span> Showing what was loaded. Your agents keep working; their updates
        arrive when you reconnect. Changes you make now may not save.
      </p>
      <Button size="sm" variant="outline" onClick={refresh} disabled={!online}>
        Retry now
      </Button>
    </div>
  )
}
