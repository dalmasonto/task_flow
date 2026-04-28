import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sendKeys, useTerminalCapture } from '@/hooks/use-terminal'
import { sendToAgent } from '@/hooks/use-agent-messages'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { db } from '@/db/database'

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

const CRITICAL_KEYS: KeyAction[] = [
  { label: 'Ctrl+C', keys: 'C-c', enter: false, literal: false },
  { label: '/exit', keys: '/exit', enter: true, literal: true },
]

export function TerminalControl({ agentName, port }: TerminalControlProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(true)
  const [rawMode, setRawMode] = useState(false)
  const [expandKeys, setExpandKeys] = useState(false)
  const [inputMode, setInputMode] = useState<'message' | 'command'>('message')
  const previewRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // True when the user is at (or pinned to) the bottom — auto-scroll follows new content.
  // Starts true so the terminal opens scrolled to the end.
  const pinnedToBottom = useRef(true)
  const { content, error, refresh } = useTerminalCapture(
    showPreview ? agentName : null,
    port,
    3000,
  )

  // Detect active Claude Code permission prompts from terminal content.
  // Only checks last 10 lines for "Esc to cancel" / "Tab to amend" —
  // the definitive footer that only appears during active prompts.
  const promptHints = (() => {
    if (!content) return null
    const tail = content.split('\n').slice(-10).join('\n')

    const hasEsc = /Esc to cancel/i.test(tail)
    const hasTab = /Tab to amend/i.test(tail)

    if (!hasEsc && !hasTab) return null
    return { awaiting: true }
  })()

  // Auto-scroll: only follow new content when pinned to bottom.
  // Pinned state is updated by the scroll handler below.
  useEffect(() => {
    const el = previewRef.current
    if (!el || !pinnedToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [content])

  const handleScroll = () => {
    const el = previewRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedToBottom.current = distanceFromBottom < 60
  }

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
      toast.success(`Sent "${keys}" to ${agentName}`)
      db.agentRegistry.where('name').equals(agentName).modify({ awaitingInput: false })
      setTimeout(refresh, 500)
    } catch (err: any) {
      toast.error(`Failed to send keys: ${err.message}`)
    } finally {
      setSending(false)
    }
  }

  /** Send text via agent inbox — the tmux bridge handles delivery with proper Enter key timing */
  const handleMessage = async (message: string) => {
    if (!message.trim()) return
    setSending(true)
    try {
      await sendToAgent(agentName, message.trim(), port)
      setLastSent(message)
      setInput('')
      toast.success(`Sent message to ${agentName}`)
      db.agentRegistry.where('name').equals(agentName).modify({ awaitingInput: false })
      setTimeout(refresh, 500)
    } catch (err: any) {
      toast.error(`Failed to send message: ${err.message}`)
    } finally {
      setSending(false)
    }
  }

  // Button styles shift for better contrast when input is required
  const btnBase = promptHints
    ? '!bg-amber-500/15 !border-amber-500/50 hover:!bg-amber-500/30 hover:!border-amber-400 text-amber-200'
    : 'border-secondary/40 hover:bg-secondary/10 hover:border-secondary'
  const labelColor = promptHints ? 'text-amber-400/70' : 'text-muted-foreground/60'

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
            onScroll={handleScroll}
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
            onClick={() => { pinnedToBottom.current = true; refresh() }}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>
      )}

      {/* Keyboard */}
      <div className={`shrink-0 p-3 space-y-2 transition-colors ${promptHints ? 'bg-amber-500/10 border-t border-amber-500/30' : ''}`}>
        {/* Header with expand toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {promptHints && (
              <span className="material-symbols-outlined text-amber-500 text-sm animate-pulse">warning</span>
            )}
            <div className={`text-[10px] font-bold uppercase tracking-widest ${promptHints ? 'text-amber-500' : 'text-muted-foreground'}`}>
              {promptHints ? 'Input Required' : 'Quick Response'}
            </div>
          </div>
          <button
            onClick={() => setExpandKeys(!expandKeys)}
            className="text-muted-foreground hover:text-foreground"
          >
            <span className="material-symbols-outlined text-sm">
              {expandKeys ? 'expand_less' : 'expand_more'}
            </span>
          </button>
        </div>

        {/* Compact strip — always visible: choices + confirm + critical in one row */}
        <div className="flex flex-wrap gap-1">
          {CHOICE_KEYS.map((k) => (
            <Button key={k.keys} variant="outline" size="sm" disabled={sending}
              className={`text-[10px] font-bold h-7 w-7 p-0 ${btnBase}`}
              onClick={() => handleSend(k.keys, k.enter ?? true, k.literal ?? true)}
            >{k.label}</Button>
          ))}
          <div className="w-px bg-border/50 mx-0.5" />
          {CONFIRM_KEYS.map((k) => (
            <Button key={k.keys} variant="outline" size="sm" disabled={sending}
              className={`uppercase tracking-widest text-[10px] font-bold h-7 px-2 ${btnBase}`}
              onClick={() => handleMessage(k.keys)}
            >{k.label}</Button>
          ))}
          <div className="w-px bg-border/50 mx-0.5" />
          <Button variant="outline" size="sm" disabled={sending}
            className={`text-[10px] font-bold h-7 px-2 ${btnBase}`}
            onClick={() => handleSend('Escape', false, false)}
          >Esc</Button>
          <Button variant="outline" size="sm" disabled={sending}
            className={`text-[10px] font-bold h-7 px-2 ${btnBase}`}
            onClick={() => handleSend('Enter', false, false)}
          >Enter</Button>
          <div className="w-px bg-border/50 mx-0.5" />
          {CRITICAL_KEYS.map((k) => (
            <Button key={k.keys} variant="outline" size="sm" disabled={sending}
              className={`text-[10px] font-bold h-7 px-2 ${
                promptHints
                  ? '!bg-red-500/15 !border-red-500/50 hover:!bg-red-500/30 hover:!border-red-400 text-red-300'
                  : 'border-red-500/30 hover:bg-red-500/10 hover:border-red-500/60 text-red-400'
              }`}
              onClick={() => handleSend(k.keys, k.enter ?? true, k.literal ?? true)}
            >{k.label}</Button>
          ))}
        </div>

        {/* Expanded section — navigation, control, critical */}
        {expandKeys && (
          <div className="space-y-2 pt-1 border-t border-border/30">
            <div className="grid grid-cols-2 gap-2">
              {/* Navigation */}
              <div className="space-y-1.5">
                <div className={`text-[9px] uppercase tracking-widest ${labelColor}`}>Navigation</div>
                <div className="flex flex-col items-center gap-0.5">
                  <Button variant="outline" size="sm" disabled={sending}
                    className={`text-[10px] font-bold h-6 w-7 p-0 ${btnBase}`}
                    onClick={() => handleSend('Up', false, false)}>
                    <span className="material-symbols-outlined text-xs">keyboard_arrow_up</span>
                  </Button>
                  <div className="flex gap-0.5">
                    <Button variant="outline" size="sm" disabled={sending}
                      className={`text-[10px] font-bold h-6 w-7 p-0 ${btnBase}`}
                      onClick={() => handleSend('Left', false, false)}>
                      <span className="material-symbols-outlined text-xs">keyboard_arrow_left</span>
                    </Button>
                    <div className="h-6 w-7 rounded border border-border/30" />
                    <Button variant="outline" size="sm" disabled={sending}
                      className={`text-[10px] font-bold h-6 w-7 p-0 ${btnBase}`}
                      onClick={() => handleSend('Right', false, false)}>
                      <span className="material-symbols-outlined text-xs">keyboard_arrow_right</span>
                    </Button>
                  </div>
                  <Button variant="outline" size="sm" disabled={sending}
                    className={`text-[10px] font-bold h-6 w-7 p-0 ${btnBase}`}
                    onClick={() => handleSend('Down', false, false)}>
                    <span className="material-symbols-outlined text-xs">keyboard_arrow_down</span>
                  </Button>
                </div>
              </div>

              {/* Control */}
              <div className="space-y-1.5">
                <div className={`text-[9px] uppercase tracking-widest ${labelColor}`}>Control</div>
                <div className="grid grid-cols-2 gap-1">
                  {CONTROL_KEYS.map((k) => (
                    <Button key={k.keys} variant="outline" size="sm" disabled={sending}
                      className={`text-[10px] font-bold h-7 px-2 ${btnBase}`}
                      onClick={() => handleSend(k.keys, false, false)}
                    >{k.label}</Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Input mode toggle + raw input */}
        <div className="space-y-1.5">
          {/* Mode toggle */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setInputMode('message')}
              className={`text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 rounded transition-colors ${
                inputMode === 'message'
                  ? 'bg-secondary/20 text-secondary border border-secondary/40'
                  : 'text-muted-foreground/50 hover:text-muted-foreground border border-transparent'
              }`}
            >
              Message
            </button>
            <button
              onClick={() => setInputMode('command')}
              className={`text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 rounded transition-colors ${
                inputMode === 'command'
                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/40'
                  : 'text-muted-foreground/50 hover:text-muted-foreground border border-transparent'
              }`}
            >
              Command
            </button>
            {inputMode === 'command' && (
              <span className="text-[9px] text-amber-500/70 ml-1">raw — no prefix</span>
            )}
          </div>

          <div className="flex gap-2 items-end">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (inputMode === 'command') {
                    handleSend(input, true, true)
                  } else {
                    handleMessage(input)
                  }
                }
              }}
              placeholder={
                inputMode === 'command'
                  ? '> /exit, /models, /help, y, n...'
                  : 'Type a message... (Shift+Enter for new line)'
              }
              disabled={sending}
              rows={1}
              className={`text-xs min-h-8 max-h-32 font-mono resize-none ${
                inputMode === 'command'
                  ? 'bg-amber-500/5 border-amber-500/30 text-amber-100 placeholder:text-amber-500/40'
                  : 'bg-muted/30 border-border'
              }`}
            />
            <Button
              onClick={() => {
                if (inputMode === 'command') {
                  handleSend(input, true, true)
                } else {
                  handleMessage(input)
                }
              }}
              disabled={sending || !input.trim()}
              size="sm"
              className={`uppercase tracking-widest text-[10px] font-bold h-8 ${
                inputMode === 'command' ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40' : ''
              }`}
            >
              {sending ? '...' : inputMode === 'command' ? 'Run' : 'Send'}
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
