import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react"
import { PaperclipIcon, XIcon } from "lucide-react"

import { spliceAtCaret, fileReferenceText } from "@/lib/composer"

/** A staged (not-yet-uploaded) file. Structurally compatible with the chat
 *  composer's StagedFile, so callers can pass either. */
export type AttachableFile = { id: string; file: File }

/**
 * A markdown textarea with the chat composer's attach behaviour: pick files on
 * the fly, and click a staged file to drop `[its-name]` at the cursor. The same
 * caret-insertion primitive as the message composer (`spliceAtCaret` +
 * `fileReferenceText`), extracted so the task form and the chat input don't
 * drift. The textarea is controlled internally but carries `name`, so it still
 * submits its value through the surrounding form's FormData. Staged files are
 * owned by the parent (it uploads them after the row is created).
 */
export function AttachableTextarea({
  name,
  defaultValue = "",
  placeholder,
  className,
  files,
  onStageFiles,
  onRemoveFile,
}: {
  name: string
  defaultValue?: string
  placeholder?: string
  className?: string
  files: AttachableFile[]
  onStageFiles: (files: File[]) => void
  onRemoveFile: (id: string) => void
}) {
  const [value, setValue] = useState(defaultValue)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Where to put the caret after an insert re-renders (React resets it to the
  // end otherwise). Restored in the layout effect below, before paint.
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (pendingCaret.current == null) return
    const el = ref.current
    if (el) {
      el.selectionStart = el.selectionEnd = pendingCaret.current
      el.focus()
    }
    pendingCaret.current = null
  }, [value])

  const insertReference = (fileName: string) => {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const { value: next, caret } = spliceAtCaret(value, start, end, fileReferenceText(fileName))
    pendingCaret.current = caret
    setValue(next)
  }

  const handleSelect = (event: ChangeEvent<HTMLInputElement>) => {
    onStageFiles(Array.from(event.target.files ?? []))
    // Reset so picking the same file again re-fires change.
    event.target.value = ""
  }

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        name={name}
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition hover:bg-muted">
          <PaperclipIcon className="size-3.5" />
          Attach file
          <input type="file" multiple className="hidden" onChange={handleSelect} />
        </label>
        {files.map((staged) => (
          <span
            key={staged.id}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            <button
              type="button"
              className="max-w-[12rem] truncate font-medium hover:underline"
              title={`Insert [${staged.file.name}] at the cursor`}
              onClick={() => insertReference(staged.file.name)}
            >
              {staged.file.name}
            </button>
            <button
              type="button"
              className="text-muted-foreground transition hover:text-foreground"
              aria-label={`Remove ${staged.file.name}`}
              onClick={() => onRemoveFile(staged.id)}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
      </div>
      {files.length ? (
        <p className="text-xs text-muted-foreground">
          Click a file name to drop <code>[its-name]</code> at the cursor. Files upload when you save.
        </p>
      ) : null}
    </div>
  )
}
