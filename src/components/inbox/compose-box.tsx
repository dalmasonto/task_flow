import { useState, useRef } from 'react'
import { sendToAgent } from '@/hooks/use-agent-messages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ComposeBoxProps {
  recipient: string
  port: number
}

export function ComposeBox({ recipient, port }: ComposeBoxProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
      inputRef.current?.focus()
    }
  }

  return (
    <div className="border-t border-border p-4 bg-card">
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend() }}
          placeholder={`Send message to ${recipient}...`}
          disabled={sending}
          className="bg-muted/30 border-border text-sm"
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
