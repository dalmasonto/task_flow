/// Make a new key for an agent (#1136 rotate): confirm, then show the raw key
/// ONCE. The key lives only in this dialog's state, never in storage, the
/// workspace or the URL, and is dropped when the dialog closes. The old keys
/// stop at once; the new one keeps the agent's capabilities.
import { useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowAgent } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { rotateAgentKey } from "@/lib/taskflow-api"

import { CopyBlock } from "../components/copy-block"
import { useWorkspace } from "../workspace"
import { applyRotation } from "./api-keys-logic"

export function RotateKeyDialog({ agent, open, onOpenChange }: { agent: Pick<TaskflowAgent, "id" | "display_name">; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { applyLiveUpdate } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<string | null>(null)

  function close(next: boolean) {
    // Not while the rotation is in flight: by the time it answers, the old key
    // has stopped and the new one is live, so its only copy must be shown.
    if (!next && busy) return
    if (!next) setKey(null)
    onOpenChange(next)
  }

  async function rotate() {
    setBusy(true)
    try {
      const res = await rotateAgentKey(agent.id)
      const now = new Date().toISOString()
      applyLiveUpdate((w) => ({ ...w, agentCredentials: applyRotation(w.agentCredentials, agent.id, res.credential, now) }))
      setKey(res.key)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't make a new key.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {key ? (
          <>
            <DialogHeader>
              <DialogTitle>{agent.display_name}&apos;s new key</DialogTitle>
              <DialogDescription>Copy it now. It isn&apos;t shown again. Put it in the agent&apos;s .taskflow.json in place of the old one; the old key has already stopped.</DialogDescription>
            </DialogHeader>
            <CopyBlock label="Agent key" text={key} />
            <DialogFooter>
              <Button onClick={() => close(false)}>I&apos;ve copied it</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Make a new key for {agent.display_name}?</DialogTitle>
              <DialogDescription>
                Its current key stops at once, so it disconnects until you give it the new one. Its tasks, messages and activity stay, and the new key keeps the same capabilities.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => close(false)}>
                Keep the key
              </Button>
              <Button disabled={busy} onClick={rotate}>
                {busy ? <Spinner /> : <KeyRoundIcon />}
                Make a new key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
