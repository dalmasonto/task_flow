/// #508: naming or removing one link on the Flow view.

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function EdgeEditor({
  title,
  label,
  onSave,
  onDelete,
  onClose,
}: {
  title: string
  label: string
  onSave: (label: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(label)
  return (
    <form
      className="w-72 space-y-2 rounded-lg border bg-background p-3 shadow-lg"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <p className="truncate text-sm font-semibold">{title}</p>
      <Input
        value={draft}
        maxLength={40}
        autoFocus
        placeholder="Label, e.g. new user"
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Link label"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" variant="ghost" className="ml-auto text-rose-600" onClick={onDelete}>
          Remove link
        </Button>
      </div>
    </form>
  )
}
