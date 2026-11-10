/// Create or edit a model group: its name, its slug (picked from the name
/// unless you set it yourself) and its colour. The one place groups are
/// managed; models then pick a group from a list, never by typing a label.
import { useState } from "react"
import { CheckIcon, PencilIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { DbGroup, DbSchemaDoc } from "@/lib/db-api"
import { cn } from "@/lib/utils"

import { GROUP_COLORS, nextColor, slugify, slugTaken } from "./db-groups"

export function GroupDialog({
  doc,
  group,
  modelCount,
  busy,
  onSave,
  onDelete,
  onClose,
}: {
  doc: DbSchemaDoc
  /// The group being edited; null to create one.
  group: DbGroup | null
  modelCount: number
  busy: boolean
  onSave: (group: DbGroup, previousSlug: string | undefined) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(group?.name ?? "")
  const [slug, setSlug] = useState(group?.slug ?? "")
  // The slug follows the name until you edit it yourself (a new group), and
  // stays put when editing an existing one unless you open it.
  const [slugEdited, setSlugEdited] = useState(group != null)
  const [editingSlug, setEditingSlug] = useState(false)
  const [color, setColor] = useState(group?.color ?? nextColor(doc))
  const [tried, setTried] = useState(false)

  const effectiveSlug = slugEdited ? slug : slugify(name)
  const nameError = !name.trim() ? "Give the group a name." : name.trim().length > 60 ? "Keep it under 60 characters." : null
  const slugError = !effectiveSlug
    ? "The slug needs at least one letter or digit."
    : !/^[a-z0-9][a-z0-9-]*$/.test(effectiveSlug)
      ? "Lowercase letters, digits and dashes only."
      : slugTaken(doc, effectiveSlug, group?.slug)
        ? "Another group already uses this slug."
        : null

  const submit = () => {
    setTried(true)
    if (nameError || slugError) return
    onSave({ slug: effectiveSlug, name: name.trim(), color }, group?.slug)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
          <DialogDescription>Groups colour and cluster models on the map and in the list.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Field data-invalid={tried && nameError ? true : undefined}>
            <FieldLabel htmlFor="group-name">Name</FieldLabel>
            <Input id="group-name" autoFocus value={name} maxLength={60} placeholder="Blog" onChange={(e) => setName(e.target.value)} />
            {tried && nameError ? <FieldError>{nameError}</FieldError> : null}
          </Field>
          <Field data-invalid={tried && slugError ? true : undefined}>
            <FieldLabel htmlFor="group-slug">Slug</FieldLabel>
            {editingSlug ? (
              <Input
                id="group-slug"
                value={effectiveSlug}
                maxLength={40}
                className="font-mono"
                onChange={(e) => {
                  setSlugEdited(true)
                  setSlug(e.target.value.toLowerCase())
                }}
              />
            ) : (
              <div className="flex h-9 items-center gap-2 rounded-md border border-dashed border-border px-3">
                <code className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">{effectiveSlug || "picked from the name"}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit the slug"
                  onClick={() => {
                    setSlug(effectiveSlug)
                    setSlugEdited(true)
                    setEditingSlug(true)
                  }}
                >
                  <PencilIcon />
                </Button>
              </div>
            )}
            <FieldDescription>What models and agents use to name the group.{group && modelCount ? ` Changing it moves its ${modelCount} ${modelCount === 1 ? "model" : "models"} along.` : ""}</FieldDescription>
            {tried && slugError ? <FieldError>{slugError}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel id="group-colour">Colour</FieldLabel>
            <div role="radiogroup" aria-labelledby="group-colour" className="flex flex-wrap gap-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={color === c.id}
                  aria-label={c.label}
                  title={c.label}
                  onClick={() => setColor(c.id)}
                  className={cn("inline-flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow", c.dot, color === c.id && "ring-2 ring-ring")}
                >
                  {color === c.id ? <CheckIcon className="size-3.5 text-background" /> : null}
                </button>
              ))}
            </div>
          </Field>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            {group && onDelete ? (
              <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={onDelete}>
                <Trash2Icon />
                Delete group
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {group ? "Save group" : "Create group"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
