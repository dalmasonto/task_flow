import { BotIcon, CheckIcon, UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useState } from "react"


/// #42: a person or agent you can start a conversation with. `member` is the
/// shape the create-channel endpoint expects.
export type ConversationCandidate = {
  key: string
  label: string
  type: "user" | "agent"
  member: { kind: "user"; user: number } | { kind: "agent"; agent: number }
}


/// #42: explicit conversation creation — a DM (one other party) or a named group
/// (any members). Replaces the auto-invented DM placeholders. `onCreate` throws
/// on failure so the panel can surface the reason inline.
export function NewConversationPanel({
  candidates,
  onCreate,
  onClose,
}: {
  candidates: ConversationCandidate[]
  onCreate: (
    kind: "direct" | "group",
    title: string,
    members: ConversationCandidate["member"][]
  ) => Promise<void>
  onClose: () => void
}) {
  const [mode, setMode] = useState<"direct" | "group">("direct")
  const [groupTitle, setGroupTitle] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shown = candidates.filter((candidate) =>
    candidate.label.toLowerCase().includes(query.trim().toLowerCase())
  )

  const run = async (kind: "direct" | "group", title: string, members: ConversationCandidate["member"][]) => {
    setBusy(true)
    setError(null)
    try {
      await onCreate(kind, title, members)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the conversation.")
    } finally {
      setBusy(false)
    }
  }

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const selectedMembers = candidates.filter((c) => selected.has(c.key)).map((c) => c.member)

  return (
    <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-2xl">
      <div className="mb-2 flex items-center gap-1 rounded-lg bg-muted/60 p-0.5 text-xs">
        {(["direct", "group"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={cn(
              "flex-1 rounded-md px-2 py-1 font-medium transition-colors",
              mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option === "direct" ? "New DM" : "New group"}
          </button>
        ))}
      </div>

      {mode === "group" ? (
        <Input
          value={groupTitle}
          onChange={(event) => setGroupTitle(event.target.value)}
          placeholder="Group name…"
          className="mb-2 h-8 text-sm"
        />
      ) : null}

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people & agents…"
        className="mb-2 h-8 text-sm"
      />

      <div className="max-h-60 space-y-0.5 overflow-y-auto">
        {shown.length ? (
          shown.map((candidate) =>
            mode === "direct" ? (
              <button
                key={candidate.key}
                type="button"
                disabled={busy}
                onClick={() => run("direct", candidate.label, [candidate.member])}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
              >
                {candidate.type === "agent" ? (
                  <BotIcon className="size-4 shrink-0 text-violet-500" />
                ) : (
                  <UserIcon className="size-4 shrink-0 text-sky-500" />
                )}
                <span className="truncate">{candidate.label}</span>
              </button>
            ) : (
              <button
                key={candidate.key}
                type="button"
                onClick={() => toggle(candidate.key)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    selected.has(candidate.key) ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  )}
                >
                  {selected.has(candidate.key) ? <CheckIcon className="size-3" /> : null}
                </span>
                {candidate.type === "agent" ? (
                  <BotIcon className="size-4 shrink-0 text-violet-500" />
                ) : (
                  <UserIcon className="size-4 shrink-0 text-sky-500" />
                )}
                <span className="truncate">{candidate.label}</span>
              </button>
            )
          )
        ) : (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No people or agents match.</p>
        )}
      </div>

      {error ? <p className="mt-2 px-1 text-xs text-destructive">{error}</p> : null}

      {mode === "group" ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
          <span className="text-xs text-muted-foreground">{selected.size} selected</span>
          <Button
            type="button"
            size="sm"
            disabled={busy || !groupTitle.trim() || selected.size === 0}
            onClick={() => run("group", groupTitle.trim(), selectedMembers)}
          >
            {busy ? "Creating…" : "Create group"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
