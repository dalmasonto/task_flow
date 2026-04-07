import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { sendKeys, useTerminalCapture } from '@/hooks/use-terminal'
import { MarkdownRenderer } from '@/components/markdown-renderer'

interface TerminalControlProps {
  agentName: string
  port: number
}

interface KeyAction {
  label: string
  keys: string
  enter?: boolean   // default true
  literal?: boolean // default true
}

const CHOICE_KEYS: KeyAction[] = [
  { label: '1', keys: '1' },
  { label: '2', keys: '2' },
  { label: '3', keys: '3' },
  { label: '4', keys: '4' },
  { label: '5', keys: '5' },
]

const CONFIRM_KEYS: KeyAction[] = [
  { label: 'Yes', keys: 'yes' },
  { label: 'No', keys: 'no' },
  { label: 'y', keys: 'y' },
  { label: 'n', keys: 'n' },
]

const CONTROL_KEYS: KeyAction[] = [
  { label: 'Esc', keys: 'Escape', enter: false, literal: false },
  { label: 'Enter', keys: 'Enter', enter: false, literal: false },
  { label: 'Tab', keys: 'Tab', enter: false, literal: false },
  { label: 'S-Tab', keys: 'BTab', enter: false, literal: false },
]

export function TerminalControl({ agentName, port }: TerminalControlProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(true)
  const [rawMode, setRawMode] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
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

  // Clean up terminal artifacts and convert indented code blocks to fenced markdown
  const cleanContent = (text: string) => {
    let cleaned = text
      .replace(/^[─━—\-═╌╍┄┅╭╰╮╯│┃]{5,}.*$/gm, '') // strip decorator/box-drawing lines
      .replace(/^[│┃]\s.*$/gm, '')                     // strip box content lines
      .replace(/●/g, '-')                               // replace bullet dots with dashes

    // Convert 2-space indented code blocks into fenced code blocks
    // A code block is 2+ consecutive lines starting with exactly 2+ spaces
    // that look like code (not list items or blockquotes)
    cleaned = cleaned.replace(
      /(?:^  .+\n?){2,}/gm,
      (block) => {
        const lines = block.split('\n').filter(l => l.length > 0)
        // Check it's actually code-like (not just indented prose)
        const hasCodeSignals = lines.some(l =>
          /^\s*(\/\/|\/\*|\*|import |export |const |let |var |type |interface |function |class |return |if |for |while |switch |try |catch |\{|\}|=>|[a-zA-Z]+\(|[a-zA-Z]+:|<[a-zA-Z])/.test(l.trim())
        )
        if (!hasCodeSignals) return block
        const dedented = lines.map(l => l.replace(/^ {2}/, '')).join('\n')
        return '\n```ts\n' + dedented + '\n```\n'
      }
    )

    return cleaned.replace(/\n{3,}/g, '\n\n')
  }

  // Split content into segments: user input (❯) lines vs markdown content
  const renderContent = (text: string) => {
    const cleaned = cleanContent(text)
    const segments: { type: 'input' | 'markdown'; text: string }[] = []
    let currentMarkdown = ''

    for (const line of cleaned.split('\n')) {
      if (line.trimStart().startsWith('❯')) {
        if (currentMarkdown.trim()) {
          segments.push({ type: 'markdown', text: currentMarkdown })
          currentMarkdown = ''
        }
        segments.push({ type: 'input', text: line })
      } else {
        currentMarkdown += line + '\n'
      }
    }
    if (currentMarkdown.trim()) {
      segments.push({ type: 'markdown', text: currentMarkdown })
    }

    return segments.map((seg, i) =>
      seg.type === 'input' ? (
        <div
          key={i}
          className="flex items-start gap-2 my-1.5 px-2 py-1 bg-secondary/10 border-l-2 border-secondary rounded-r text-sm font-mono"
        >
          <span className="text-secondary shrink-0">❯</span>
          <span className="text-foreground">{seg.text.replace(/^\s*❯\s*/, '')}</span>
        </div>
      ) : (
        <MarkdownRenderer key={i} content={seg.text} className="text-sm" />
      )
    )
  }

  const handleSend = async (keys: string, enter = true, literal = true) => {
    if (!keys && enter) return
    setSending(true)
    try {
      await sendKeys(agentName, keys, port, enter, literal)
      setLastSent(keys)
      setInput('')
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
        <div className="flex items-center gap-1">
          {showPreview && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] uppercase tracking-widest"
              onClick={() => setRawMode(!rawMode)}
            >
              {rawMode ? 'Rendered' : 'Raw'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] uppercase tracking-widest"
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>

      {/* Terminal preview */}
      {showPreview && (
        <div className="flex-1 min-h-0 border-b border-border relative">
          <div
            ref={previewRef}
            className="h-full overflow-auto p-3"
          >
            {error ? (
              <span className="text-destructive text-xs">{error}</span>
            ) : content ? (
              rawMode ? (
                <pre className="text-xs leading-tight font-mono text-green-400/80 whitespace-pre-wrap bg-black/40 p-2 rounded">
                  {content}
                </pre>
              ) : (
                renderContent(content)
              )
            ) : (
              <span className="text-muted-foreground text-xs">Loading...</span>
            )}
          </div>
          <button
            onClick={refresh}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>
      )}

      {/* Keyboard */}
      <div className="shrink-0 p-3 space-y-3">
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
          Quick Response
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* Choices */}
          <div className="space-y-1.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">Choices</div>
            <div className="flex gap-1">
              {CHOICE_KEYS.map((k) => (
                <Button
                  key={k.keys}
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-7 w-7 p-0"
                  onClick={() => handleSend(k.keys, k.enter ?? true, k.literal ?? true)}
                >
                  {k.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Navigation */}
          <div className="space-y-1.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">Navigation</div>
            <div className="flex flex-col items-center gap-0.5">
              <Button
                variant="outline"
                size="sm"
                disabled={sending}
                className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-6 w-7 p-0"
                onClick={() => handleSend('Up', false, false)}
              >
                <span className="material-symbols-outlined text-xs">keyboard_arrow_up</span>
              </Button>
              <div className="flex gap-0.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-6 w-7 p-0"
                  onClick={() => handleSend('Left', false, false)}
                >
                  <span className="material-symbols-outlined text-xs">keyboard_arrow_left</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-6 w-7 p-0"
                  onClick={() => handleSend('Down', false, false)}
                >
                  <span className="material-symbols-outlined text-xs">keyboard_arrow_down</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-6 w-7 p-0"
                  onClick={() => handleSend('Right', false, false)}
                >
                  <span className="material-symbols-outlined text-xs">keyboard_arrow_right</span>
                </Button>
              </div>
            </div>
          </div>

          {/* Confirm */}
          <div className="space-y-1.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">Confirm</div>
            <div className="flex gap-1">
              {CONFIRM_KEYS.map((k) => (
                <Button
                  key={k.keys}
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="uppercase tracking-widest text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-7 px-2"
                  onClick={() => handleSend(k.keys, k.enter ?? true, k.literal ?? true)}
                >
                  {k.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Control */}
          <div className="space-y-1.5">
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">Control</div>
            <div className="grid grid-cols-2 gap-1">
              {CONTROL_KEYS.map((k) => (
                <Button
                  key={k.keys}
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  className="text-[10px] font-bold border-secondary/40 hover:bg-secondary/10 hover:border-secondary h-7 px-2"
                  onClick={() => handleSend(k.keys, false, false)}
                >
                  {k.label}
                </Button>
              ))}
            </div>
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
