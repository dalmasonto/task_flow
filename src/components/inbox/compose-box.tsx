import { useState, useRef } from 'react'
import { sendToAgent } from '@/hooks/use-agent-messages'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ComposeBoxProps {
  recipient: string
  port: number
}

export function ComposeBox({ recipient, port }: ComposeBoxProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = async () => {
    if (!input.trim()) return
    setSending(true)
    try {
      await sendToAgent(recipient, input.trim(), port)
      setInput('')
    } catch (err) {
      console.error('Failed to send:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border p-4 bg-card">
      <div className="flex gap-2 items-end">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder={`Send message to ${recipient}... (Shift+Enter for new line)`}
          disabled={sending}
          rows={1}
          className="bg-muted/30 border-border text-sm min-h-9 max-h-32 resize-none"
        />
        <Button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          className="uppercase tracking-widest text-xs font-bold"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
