/// Minimal ⌘K command palette (§9.7): jump to route, component, or comment.
/// Deliberately dependency-free — one input, one list, keyboard-first.

import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export type PaletteItem = {
  key: string
  label: string
  hint: string
  group: "Routes" | "Components" | "Comments"
  run: () => void
}

export function CommandPalette({
  onClose,
  items,
}: {
  /** The parent mounts this only while open, so query/active start clean. */
  onClose: () => void
  items: PaletteItem[]
}) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => `${i.label} ${i.hint} ${i.group}`.toLowerCase().includes(q))
  }, [items, query])

  const runAt = (index: number) => {
    const item = filtered[index]
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose()
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, filtered.length - 1))
            }
            if (e.key === "ArrowUp") {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            }
            if (e.key === "Enter") runAt(active)
          }}
          placeholder="Jump to route, component, or comment…"
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
        />
        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.map((item, i) => (
            <li key={item.key}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm",
                  i === active ? "bg-accent/10 text-accent" : "hover:bg-muted",
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.group}
                </span>
                <span className="truncate">{item.label}</span>
                <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                  {item.hint}
                </span>
              </button>
            </li>
          ))}
          {!filtered.length ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing matches.</li>
          ) : null}
        </ul>
      </div>
    </div>
  )
}
