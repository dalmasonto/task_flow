import { useState } from 'react'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/components/markdown-renderer'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  className?: string
}

export function MarkdownEditor({ value, onChange, placeholder, rows = 5, className }: MarkdownEditorProps) {
  const [preview, setPreview] = useState(false)

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={cn(
            'px-3 py-1 text-[10px] uppercase tracking-widest font-bold transition-colors',
            !preview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={cn(
            'px-3 py-1 text-[10px] uppercase tracking-widest font-bold transition-colors',
            preview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Preview
        </button>
      </div>
      {preview ? (
        <div className="min-h-[120px] p-4 bg-input border-b border-border">
          {value ? (
            <MarkdownRenderer content={value} />
          ) : (
            <p className="text-muted-foreground/50 italic text-sm">Nothing to preview</p>
          )}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className="w-full bg-input border-0 border-b border-border focus:border-secondary focus:ring-0 text-sm py-4 px-2 placeholder:text-muted-foreground/30 placeholder:text-sm resize-y"
        />
      )}
    </div>
  )
}
