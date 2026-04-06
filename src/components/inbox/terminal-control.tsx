import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { sendKeys, useTerminalCapture } from '@/hooks/use-terminal'

interface TerminalControlProps {
  agentName: string
  port: number
}

const QUICK_ACTIONS = [
  { label: 'Yes', keys: 'yes' },
  { label: 'No', keys: 'no' },
  { label: 'y', keys: 'y' },
  { label: 'n', keys: 'n' },
  { label: '1', keys: '1' },
  { label: '2', keys: '2' },
  { label: '3', keys: '3' },
  { label: '4', keys: '4' },
  { label: '5', keys: '5' },
]

export function TerminalControl({ agentName, port }: TerminalControlProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(true)
  const previewRef = useRef<HTMLPreElement>(null)
  const { content, error, refresh } = useTerminalCapture(
    showPreview ? agentName : null,
    port,
    3000,
  )

  // Auto-scroll preview to bottom
  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight
    }
  }, [content])

  const handleSend = async (keys: string, enter = true) => {
    if (!keys && enter) return
    setSending(true)
    try {
      await sendKeys(agentName, keys, port, enter)
      setLastSent(keys)
      setInput('')
      // Refresh terminal preview after sending
      setTimeout(refresh, 500)
    } catch (err) {
      console.error('Failed to send keys:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 h-[60px] px-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary text-sm">terminal</span>
          <span className="text-[10px] tracking-widest uppercase text-secondary font-bold">
            Terminal
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {agentName}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px] uppercase tracking-widest"
          onClick={() => setShowPreview(!showPreview)}
        >
          {showPreview ? 'Hide' : 'Show'} Preview
        </Button>
      </div>

      {/* Terminal preview */}
      {showPreview && (
        <div className="flex-1 min-h-0 border-b border-border relative">
          <pre
            ref={previewRef}
            className="h-full overflow-auto p-3 text-[11px] leading-tight font-mono bg-black/40 text-green-400/80 whitespace-pre-wrap"
          >
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : content ? (
              content
            ) : (
              <span className="text-muted-foreground">Loading...</span>
            )}
          </pre>
          <button
            onClick={refresh}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>
      )}

      {/* Quick actions */}
      <div className="shrink-0 p-3 space-y-3">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
            Quick Response
          </div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action) => (
              <Button
                key={action.keys}
                variant="outline"
                size="sm"
                disabled={sending}
                className="uppercase tracking-widest text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-7 min-w-[2rem]"
                onClick={() => handleSend(action.keys)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Raw input */}
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
            Send Raw Input
          </div>
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend(input)
                }
              }}
              placeholder="Type and press Enter..."
              disabled={sending}
              className="bg-muted/30 border-border text-xs h-8 font-mono"
            />
            <Button
              onClick={() => handleSend(input)}
              disabled={sending || !input.trim()}
              size="sm"
              className="uppercase tracking-widest text-[10px] font-bold h-8"
            >
              {sending ? '...' : 'Send'}
            </Button>
          </div>
        </div>

        {/* Last sent indicator */}
        {lastSent !== null && (
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-widest flex items-center gap-1">
            <span className="material-symbols-outlined text-xs text-secondary">check</span>
            Sent: "{lastSent}"
          </div>
        )}
      </div>
    </div>
  )
}
