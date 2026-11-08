/// A terminal-styled block with a Copy button (commands, config files).
import { useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-terminal text-terminal-foreground">
      <div className="flex items-center justify-between border-b border-terminal-foreground/10 px-4 py-2">
        <span className="font-mono text-xs opacity-70">{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs opacity-80 hover:bg-terminal-foreground/10 hover:opacity-100"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-sm leading-6">{text}</pre>
    </div>
  )
}
