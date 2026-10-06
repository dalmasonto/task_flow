import { useState, type ReactNode } from "react"
import { Loader2Icon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/// "Are you sure?" for an irreversible delete. The dialog stays open while the
/// delete runs and shows its error inline, so a refused delete (403) is read,
/// not lost. `confirmText`, when given, must be typed exactly before the button
/// arms — kept for deletes that take a lot with them, like a whole project.
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  confirmText,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel?: string
  confirmText?: string
  onConfirm: () => Promise<void>
}) {
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const armed = !confirmText || typed.trim() === confirmText

  const change = (next: boolean) => {
    if (busy) return
    if (!next) {
      setTyped("")
      setError(null)
    }
    onOpenChange(next)
  }

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      setTyped("")
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {confirmText ? (
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            <span>
              Type <code className="rounded bg-muted px-1 py-0.5 text-foreground">{confirmText}</code> to confirm
            </span>
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus disabled={busy} />
          </label>
        ) : null}
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" size="sm" disabled={busy} />}>Cancel</DialogClose>
          <Button type="button" variant="destructive" size="sm" disabled={!armed || busy} onClick={() => void run()}>
            {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
