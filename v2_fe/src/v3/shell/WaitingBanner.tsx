/// #1034: while an agent is paused on a question for you, say so on EVERY page,
/// with a way to answer. The Inbox bell's dot alone was easy to miss, and an
/// agent blocked on a prompt does nothing until someone answers it.
import { Link, useLocation } from "react-router-dom"
import { MessageCircleQuestionIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useLivenessNow } from "@/hooks/use-liveness-now"

import type { WaitingPrompt } from "./use-sidebar-data"

/// "just now", "4m", "1h 12m": how long the oldest one has waited.
export function waitedFor(at: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000))
  if (!Number.isFinite(mins) || mins < 1) return "just now"
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/// The banner's sentence, kept pure so it is tested without rendering.
export function waitingSummary(waiting: WaitingPrompt[]): string | null {
  if (!waiting.length) return null
  const names = [...new Set(waiting.map((w) => w.agent_label ?? `Agent ${w.agent}`))]
  if (names.length === 1) {
    return waiting.length === 1 ? `${names[0]} is waiting on you` : `${names[0]} has ${waiting.length} questions waiting on you`
  }
  return `${names.length} agents are waiting on you`
}

export function WaitingBanner({ waiting }: { waiting: WaitingPrompt[] }) {
  const { pathname } = useLocation()
  const now = useLivenessNow()
  const summary = waitingSummary(waiting)
  // On the inbox the questions are right there; a banner pointing at it is noise.
  if (!summary || pathname.startsWith("/v3/inbox")) return null
  const oldest = waiting.reduce((min, w) => (Date.parse(w.at) < Date.parse(min.at) ? w : min), waiting[0]!)
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2.5 lg:px-6">
      <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
        <MessageCircleQuestionIcon className="relative size-4 text-primary" />
      </span>
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{summary}.</span>{" "}
        <span className="text-muted-foreground">
          Waiting {waitedFor(oldest.at, now)}: “{oldest.question.length > 90 ? `${oldest.question.slice(0, 89)}…` : oldest.question}”
        </span>
      </p>
      <Button size="sm" nativeButton={false} render={<Link to="/v3/inbox" />}>
        Answer
      </Button>
    </div>
  )
}
