/// An agent or a person, from the design's `tf-avatar`.
///
/// Agents get a rounded square holding the model's real logo. People get a circle
/// with initials. An optional status pip sits bottom-right. The logos are bundled
/// from @lobehub/icons-static-svg (the set the design uses), never hotlinked, so
/// they load offline and don't leak who's viewing to a CDN.
import { useState } from "react"

import { cn } from "@/lib/utils"

import { initialsOf, MODELS, type ActorStatus, type AvatarSize, type ModelId } from "./actor-models"

export type { ActorStatus, AvatarSize, ModelId } from "./actor-models"

const SIZES: Record<AvatarSize, { box: string; img: string; text: string; pip: string }> = {
  xs: { box: "size-5", img: "size-3", text: "text-[0.55rem]", pip: "size-2 ring-1" },
  sm: { box: "size-6", img: "size-3.5", text: "text-[0.6rem]", pip: "size-2.5 ring-2" },
  md: { box: "size-8", img: "size-4.5", text: "text-xs", pip: "size-2.5 ring-2" },
  lg: { box: "size-10", img: "size-6", text: "text-sm", pip: "size-3 ring-2" },
  xl: { box: "size-14", img: "size-8", text: "text-lg", pip: "size-3.5 ring-4" },
}

const PIP: Record<ActorStatus, string> = {
  running: "bg-running",
  idle: "bg-idle",
  blocked: "bg-blocked",
  review: "bg-review",
  done: "bg-done",
  failed: "bg-failed",
  offline: "border border-idle bg-background",
}

export function ActorAvatar({
  model,
  name,
  status,
  size = "md",
  className,
  src,
}: {
  /// A model id for an agent; null/undefined for a person.
  model?: ModelId | null
  name: string
  status?: ActorStatus | null
  size?: AvatarSize
  className?: string
  /// A person's photo (#1135). Initials show if there's none or it fails.
  src?: string | null
}) {
  const [broken, setBroken] = useState<string | null>(null)
  const s = SIZES[size]
  const m = model ? MODELS[model] : null
  const label = m ? `${name ? `${name}, ` : ""}${m.label} agent` : name || "Person"
  return (
    <span className={cn("relative inline-flex shrink-0 align-middle", className)} title={status ? `${label}, ${status}` : label}>
      {m ? (
        <span className={cn(s.box, "inline-flex items-center justify-center rounded-md border border-border bg-card")} role="img" aria-label={label}>
          <img src={m.src} alt="" className={cn(s.img, "mono" in m && m.mono && "dark:invert")} decoding="async" />
        </span>
      ) : src && broken !== src ? (
        <img src={src} alt={label} className={cn(s.box, "rounded-full bg-secondary object-cover")} decoding="async" onError={() => setBroken(src)} />
      ) : (
        <span
          className={cn(s.box, s.text, "inline-flex items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground")}
          role="img"
          aria-label={label}
        >
          {initialsOf(name)}
        </span>
      )}
      {status ? <span className={cn("absolute -bottom-0.5 -right-0.5 rounded-full ring-background", s.pip, PIP[status])} /> : null}
    </span>
  )
}
