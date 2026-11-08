/// The design's `tf-status` chip: icon + label on a tinted background.
import type { ComponentType, SVGProps } from "react"
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, CirclePauseIcon, CircleXIcon, EyeIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import type { StatusTone } from "./status-tones"

const TONES: Record<StatusTone, { icon: ComponentType<SVGProps<SVGSVGElement>>; label: string; cls: string }> = {
  running: { icon: CircleDotIcon, label: "In progress", cls: "text-running bg-running/10" },
  idle: { icon: CircleIcon, label: "Idle", cls: "text-muted-foreground bg-muted" },
  todo: { icon: CircleDashedIcon, label: "Not started", cls: "text-muted-foreground bg-muted" },
  paused: { icon: CirclePauseIcon, label: "Paused", cls: "text-muted-foreground bg-muted" },
  blocked: { icon: CircleAlertIcon, label: "Blocked", cls: "text-blocked bg-blocked/12" },
  review: { icon: EyeIcon, label: "In review", cls: "text-review bg-review/10" },
  done: { icon: CircleCheckIcon, label: "Done", cls: "text-done bg-done/10" },
  failed: { icon: CircleXIcon, label: "Failed", cls: "text-failed bg-failed/10" },
}

export function StatusChip({ tone, label, className }: { tone: StatusTone; label?: string; className?: string }) {
  const t = TONES[tone]
  const Icon = t.icon
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium", t.cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      <span>{label ?? t.label}</span>
    </span>
  )
}
