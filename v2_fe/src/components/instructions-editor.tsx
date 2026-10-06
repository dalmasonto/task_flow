import { useState } from "react"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { cn } from "@/lib/utils"
import {
  INSTRUCTION_TEMPLATES,
  insertTemplate,
  instructionsChanged,
  normalizeInstructions,
} from "@/lib/agent-instructions"

const EDITOR_CLASS =
  "min-h-48 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-xs leading-5 outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-60"

/// #615/#616: a markdown textarea with a Write / Preview toggle and,
/// optionally, the starter-role templates. Controlled: the caller owns the text.
export function InstructionsEditor({
  label,
  value,
  onChange,
  disabled = false,
  showTemplates = false,
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  showTemplates?: boolean
  placeholder?: string
}) {
  const [mode, setMode] = useState<"write" | "preview">("write")
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={`${label} view`} className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {(["write", "preview"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={mode === option}
              onClick={() => setMode(option)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
        {showTemplates ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">Insert template:</span>
            {INSTRUCTION_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                type="button"
                variant="outline"
                size="xs"
                disabled={disabled}
                onClick={() => {
                  onChange(insertTemplate(value, template.markdown))
                  setMode("write")
                }}
              >
                {template.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {mode === "write" ? (
        <textarea
          aria-label={label}
          className={EDITOR_CLASS}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
      ) : (
        <div className="min-h-48 rounded-lg border bg-background p-3">
          {value.trim() ? (
            <MarkdownRenderer content={value} />
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

/// #615: edit one agent's role instructions. Mount it with `key={agent.id}` so
/// the draft starts from that agent's saved text. It stays open while saving
/// and shows a refusal (403) inline.
export function AgentInstructionsDialog({
  open,
  onOpenChange,
  agentName,
  saved,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentName: string
  saved: string | null
  onSave: (markdown: string | null) => Promise<void>
}) {
  const [draft, setDraft] = useState(saved ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = instructionsChanged(saved, draft)

  const change = (next: boolean) => {
    if (busy) return
    onOpenChange(next)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(normalizeInstructions(draft))
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the instructions.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Role &amp; instructions — {agentName}</DialogTitle>
          <DialogDescription>
            Markdown {agentName} reads through whoami: its role, responsibilities and conventions. Changes apply on its
            next whoami, with no new key and no restart. Leave it empty to remove them.
          </DialogDescription>
        </DialogHeader>
        <InstructionsEditor label="Role & instructions" value={draft} onChange={setDraft} disabled={busy} showTemplates />
        {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
