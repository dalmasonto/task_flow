/// Edit an agent's name, provider and model (#1078). A rename keeps the
/// agent's id, keys and history; names are unique within the project. The
/// saved row is applied at once; realtime carries it to other tabs.
import { useState } from "react"
import { toast } from "sonner"

import type { TaskflowAgent } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { updateAgentProfile, type AgentProfileInput } from "@/lib/taskflow-api"

import { useWorkspace } from "../workspace"

const NONE = "none"
const PROVIDERS: Record<string, string> = { [NONE]: "Not set", anthropic: "Anthropic", openai: "OpenAI", google: "Google", other: "Other" }

export function EditAgentDialog({ agent, open, onOpenChange }: { agent: TaskflowAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { applyLiveUpdate } = useWorkspace()
  const [name, setName] = useState(agent.display_name)
  const [provider, setProvider] = useState(agent.provider ?? NONE)
  const [model, setModel] = useState(agent.model ?? "")
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  const nameError = !trimmed ? "Give it a name." : [...trimmed].length > 80 ? "At most 80 characters." : null

  function reset(next: boolean) {
    if (next) {
      setName(agent.display_name)
      setProvider(agent.provider ?? NONE)
      setModel(agent.model ?? "")
    }
    onOpenChange(next)
  }

  async function save() {
    const patch: AgentProfileInput = {}
    if (trimmed !== agent.display_name) patch.display_name = trimmed
    const p = provider === NONE ? null : (provider as AgentProfileInput["provider"])
    if (p !== (agent.provider ?? null)) patch.provider = p
    const m = model.trim() || null
    if (m !== (agent.model ?? null)) patch.model = m
    if (!Object.keys(patch).length) return reset(false)
    setBusy(true)
    try {
      const row = await updateAgentProfile(agent.id, patch)
      applyLiveUpdate((w) => ({ ...w, agents: w.agents.map((a) => (a.id === row.id ? { ...a, ...row } : a)) }))
      toast.success("Agent saved")
      reset(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the agent.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {agent.display_name}</DialogTitle>
          <DialogDescription>Renaming keeps its key, tasks and history. Names are unique in the project, so nobody mistakes one agent for another.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="agent-name">Name</FieldLabel>
            <Input id="agent-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError || undefined} />
            {nameError ? <FieldDescription className="text-destructive">{nameError}</FieldDescription> : null}
          </Field>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field>
              <FieldLabel htmlFor="agent-provider">Provider</FieldLabel>
              <Select items={PROVIDERS} value={provider} onValueChange={(v) => v && setProvider(String(v))}>
                <SelectTrigger id="agent-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDERS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-model">Model</FieldLabel>
              <Input id="agent-model" value={model} maxLength={80} placeholder="claude-opus-5-5" className="font-mono" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => reset(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !!nameError} onClick={save}>
            {busy ? <Spinner /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
