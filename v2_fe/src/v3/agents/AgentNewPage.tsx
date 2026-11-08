/// Add an agent (design: agent-new.html): model, name, profile, optional role
/// instructions and what its key may do. The key is shown once, here, and
/// held in memory only; the page then gives the profile block to paste into
/// the repo's .taskflow.json and the command to start it.
import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { CheckCircle2Icon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { PROFILE_PATTERN } from "@/lib/agent-profile"
import { isAgentOnline } from "@/lib/live-mappers"
import { AGENT_CAPABILITIES } from "@/lib/agent-scopes"
import { API_BASE_URL } from "@/lib/auth-api"
import { linkAgent, type LinkAgentResult } from "@/lib/taskflow-api"

import type { ModelId } from "../components/actor-models"
import { CopyBlock } from "../components/copy-block"
import { ModelPicker } from "../components/model-picker"
import { initCommand } from "../onboarding/onboarding-logic"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { keyScopes } from "./agents-logic"
import { useAgentSlices } from "./use-agent-slices"

/// Step 4 of adding an agent: wait, live, for it to connect, so the person
/// knows the key and profile worked without hunting for it.
function ConnectionWatch({ agentId, name }: { agentId: number; name: string }) {
  useAgentSlices()
  const { live } = useWorkspace()
  const now = useLivenessNow()
  const online = live ? isAgentOnline(agentId, live.agents, live.agentSessions, now) : false
  return online ? (
    <p className="flex items-center gap-2 rounded-lg border border-running/40 bg-running/10 px-3 py-2 text-sm">
      <CheckCircle2Icon className="size-4 text-running" aria-hidden />
      {name} is connected.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
      <Spinner />
      Waiting for {name} to connect…
    </p>
  )
}

export function AgentNewPage() {
  const { live, activeProject, currentUser } = useWorkspace()
  const [model, setModel] = useState<ModelId>("claude")
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(AGENT_CAPABILITIES.map((c) => [c.id, c.defaultOn])))
  const [errors, setErrors] = useState<{ name?: string; profile?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [made, setMade] = useState<LinkAgentResult | null>(null)

  const role = live?.members.find((m) => m.user === currentUser?.id)?.role
  const canScope = role === "owner" || role === "admin"
  const profiles = new Set((live?.agents ?? []).map((a) => a.identifier.split(":").pop() ?? ""))

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!live) return
    const f = new FormData(e.currentTarget)
    const name = String(f.get("name") ?? "").trim()
    const profile = String(f.get("profile") ?? "").trim()
    const instructions = String(f.get("instructions") ?? "").trim()
    const errs = {
      name: name ? undefined : "Give it a name.",
      profile: PROFILE_PATTERN.test(profile) ? undefined : "Lowercase letters, digits, - or _, up to 32.",
    }
    setErrors(errs)
    if (errs.name || errs.profile) return
    setPending(true)
    setError(null)
    try {
      const { scopes, denied_scopes } = keyScopes(checked)
      const result = await linkAgent({
        project: live.project.id,
        display_name: name,
        profile,
        runtime: model,
        ...(instructions ? { instructions_markdown: instructions } : {}),
        ...(canScope && scopes.length ? { scopes } : {}),
        ...(canScope && denied_scopes.length ? { denied_scopes } : {}),
      })
      setMade(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the agent.")
    } finally {
      setPending(false)
    }
  }

  if (made) {
    const block = JSON.stringify({ [made.profile]: { agent_id: made.agent_id, key: made.key, display_name: made.display_name } }, null, 2)
    const whole = JSON.stringify({ server: API_BASE_URL || window.location.origin, project: made.project, default_profile: made.profile, profiles: JSON.parse(block) }, null, 2)
    return (
      <V3Shell title="Add agent">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{made.display_name} is ready to connect</h2>
            <p className="mt-1 text-sm text-muted-foreground">Copy the key now. It isn't stored anywhere you can read it again.</p>
          </div>
          <Alert className="rounded-xl border-blocked/40 bg-blocked/10">
            <TriangleAlertIcon />
            <AlertDescription className="text-foreground">This key is shown once. If you lose it, open the agent and make a new key; the old one stops at once.</AlertDescription>
          </Alert>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">1. Install TaskFlow, once per machine</h3>
            <CopyBlock label="Terminal" text={initCommand([model])} />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">2. Add the profile to the repo&apos;s .taskflow.json</h3>
            <p className="text-sm text-muted-foreground">
              Already have one? Paste this into its <code className="font-mono text-xs">profiles</code>. Otherwise use the whole file below. Keep the file out of git.
            </p>
            <CopyBlock label="profile" text={block} />
            <CopyBlock label=".taskflow.json" text={whole} />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">3. Start it in that repo</h3>
            <p className="text-sm text-muted-foreground">
              Open your agent there ({made.display_name}). It connects{activeProject ? ` to ${activeProject.name}` : ""} as soon as it calls whoami.
            </p>
            <ConnectionWatch agentId={made.agent_id} name={made.display_name} />
          </section>
          <div className="flex gap-2">
            <Button render={<Link to={`/v3/agents/${made.agent_id}`} />} nativeButton={false}>
              Open {made.display_name}
            </Button>
            <Button variant="ghost" onClick={() => setMade(null)}>
              Add another
            </Button>
          </div>
        </div>
      </V3Shell>
    )
  }

  return (
    <V3Shell title="Add agent">
      <form className="mx-auto max-w-3xl space-y-6" onSubmit={submit} noValidate aria-label="Add an agent">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Add an agent{activeProject ? ` to ${activeProject.name}` : ""}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick the model, name it, and paste its profile into the repo where it runs. It joins the board and the rooms as soon as it calls whoami.</p>
        </div>
        {error ? (
          <Alert variant="destructive" className="rounded-xl">
            <TriangleAlertIcon />
            <AlertDescription className="text-foreground">{error}</AlertDescription>
          </Alert>
        ) : null}
        <FieldGroup className="gap-6">
          <FieldSet>
            <FieldLegend variant="label">Model</FieldLegend>
            <ModelPicker value={model} onChange={setModel} name="New agent" />
          </FieldSet>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="ag-name">Display name</FieldLabel>
              <Input id="ag-name" name="name" placeholder="Claude (frontend)" autoComplete="off" aria-invalid={!!errors.name} />
              {errors.name ? <FieldError>{errors.name}</FieldError> : <FieldDescription>How people and other agents mention it.</FieldDescription>}
            </Field>
            <Field data-invalid={errors.profile ? true : undefined}>
              <FieldLabel htmlFor="ag-prof">Profile</FieldLabel>
              <Input id="ag-prof" name="profile" placeholder="frontend" autoComplete="off" spellCheck={false} aria-invalid={!!errors.profile} />
              {errors.profile ? (
                <FieldError>{errors.profile}</FieldError>
              ) : (
                <FieldDescription>One profile per terminal.{profiles.size ? ` Taken: ${[...profiles].filter(Boolean).slice(0, 5).join(", ")}.` : ""}</FieldDescription>
              )}
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="ag-role">
              Role instructions <span className="font-normal text-muted-foreground">Optional</span>
            </FieldLabel>
            <Textarea id="ag-role" name="instructions" rows={4} placeholder="For example: you build the v3 pages from the approved designs, and ask the reviewer before marking anything done." />
            <FieldDescription>The agent reads these at whoami, after the project instructions.</FieldDescription>
          </Field>
          <FieldSet>
            <FieldLegend variant="label">What its key may do</FieldLegend>
            {!canScope ? <FieldDescription>Only owners and admins can change these; the key gets the defaults.</FieldDescription> : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {AGENT_CAPABILITIES.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
                  <Checkbox checked={!!checked[c.id]} disabled={!canScope} onCheckedChange={(v) => setChecked((cur) => ({ ...cur, [c.id]: v === true }))} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.description} <code className="font-mono">{c.id}</code>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </FieldSet>
        </FieldGroup>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" render={<Link to="/v3/agents" />} nativeButton={false} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !live}>
            {pending ? <Spinner /> : null}
            {pending ? "Adding…" : "Add agent"}
          </Button>
        </div>
      </form>
    </V3Shell>
  )
}
