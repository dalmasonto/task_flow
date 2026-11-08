/// #5949: chat.html's pin bar, the "Pinned" marker and reaction chips.
import { useState, type ReactNode } from "react"
import { ChevronLeftIcon, ChevronRightIcon, PinIcon, PinOffIcon, SmileIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Pin, Reaction } from "@/lib/pins-api"
import { cn } from "@/lib/utils"

import { glyphOf, reactionLabel, REACTIONS, stepPin } from "./pins-logic"

const who = (label: string) => label.split(" (")[0]

export function PinBar({ pins, onJump }: { pins: Pin[]; onJump: (message: number) => void }) {
  const [index, setIndex] = useState(0)
  if (!pins.length) return null
  const at = stepPin(index, 0, pins.length)
  const pin = pins[at]
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-sm" role="region" aria-label="Pinned messages">
      <PinIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
        {at + 1} of {pins.length}
      </span>
      <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onJump(pin.message)} title={`Pinned by ${pin.pinned_by_label}`}>
        <span className="font-medium">{who(pin.sender_label)}:</span> {pin.excerpt}
      </button>
      {pins.length > 1 ? (
        <>
          <Button variant="ghost" size="icon-xs" aria-label="Previous pin" onClick={() => setIndex(stepPin(at, -1, pins.length))}>
            <ChevronLeftIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Next pin" onClick={() => setIndex(stepPin(at, 1, pins.length))}>
            <ChevronRightIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="hidden text-link sm:inline-flex" />}>All pins</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Pinned in this room</DropdownMenuLabel>
                {pins.map((p, i) => (
                  <DropdownMenuItem
                    key={p.message}
                    onClick={() => {
                      setIndex(i)
                      onJump(p.message)
                    }}
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{who(p.sender_label)}:</span> {p.excerpt}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  )
}

export function PinnedMark() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <PinIcon className="size-3" aria-hidden />
      Pinned
    </span>
  )
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}

/// The hover toolbar's React and Pin/Unpin buttons.
export function MessageExtraActions({ pinned, canPin, onReact, onPin }: { pinned: boolean; canPin: boolean; onReact: () => void; onPin: () => void }) {
  return (
    <>
      <ToolbarButton label="Add reaction" onClick={onReact}>
        <SmileIcon className="size-3.5" />
      </ToolbarButton>
      {canPin ? (
        <ToolbarButton label={pinned ? "Unpin" : "Pin"} onClick={onPin}>
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </ToolbarButton>
      ) : null}
    </>
  )
}

/// Reaction chips under a message, yours highlighted, plus the picker when open.
export function ReactionRow({ reactions, picking, readOnly, onToggle, onPick, onClosePicker }: {
  reactions: Reaction[]
  picking: boolean
  readOnly: boolean
  onToggle: (emoji: string) => void
  onPick: () => void
  onClosePicker: () => void
}) {
  if (!reactions.length && !picking) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={readOnly}
          aria-pressed={r.mine}
          aria-label={reactionLabel(r)}
          title={reactionLabel(r)}
          onClick={() => onToggle(r.emoji)}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs tabular-nums disabled:cursor-default",
            r.mine ? "border-ring/50 bg-accent text-accent-foreground" : "border-border bg-card text-muted-foreground enabled:hover:border-ring",
          )}
        >
          <span aria-hidden>{glyphOf(r.emoji)}</span>
          <span>{r.count}</span>
        </button>
      ))}
      {picking ? (
        <span role="group" aria-label="Pick a reaction" className="inline-flex items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 shadow-sm" onKeyDown={(e) => e.key === "Escape" && onClosePicker()}>
          {REACTIONS.map((r) => (
            <button
              key={r.id}
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-full text-sm hover:bg-accent"
              aria-label={r.label}
              title={r.label}
              onClick={() => {
                onToggle(r.id)
                onClosePicker()
              }}
            >
              {r.glyph}
            </button>
          ))}
        </span>
      ) : !readOnly ? (
        <button type="button" onClick={onPick} aria-label="Add reaction" className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100">
          <SmileIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
