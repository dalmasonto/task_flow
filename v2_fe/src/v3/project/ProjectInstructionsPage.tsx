/// Project agent instructions (design: project-instructions.html): the rules
/// every agent in the project reads through `whoami`. Write or preview them;
/// owners and admins save through the gated PUT (#616), everyone else reads.
/// The saved block is applied to the live project at once.
import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { patchProjectInstructions } from "@/lib/agent-instructions"
import { setProjectAgentInstructions } from "@/lib/taskflow-api"

import { myMembership } from "../invites/invites-logic"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { projectPowers } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

const ORDER = ["What you tell the agent directly", "Its role instructions", "These project instructions", "TaskFlow's defaults"]

export function ProjectInstructionsPage() {
  const { live, currentUser, applyLiveUpdate } = useWorkspace()
  const now = useLivenessNow()
  const project = live?.project ?? null
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const saved = project?.agent_instructions_markdown ?? ""
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null)
  const text = draft && draft.base === saved ? draft.text : saved
  const dirty = text.trim() !== saved.trim()
  const [tab, setTab] = useState<"write" | "preview">("write")
  const [saving, setSaving] = useState(false)
  const agents = live?.agents.length ?? 0

  async function save() {
    if (!project) return
    setSaving(true)
    try {
      const block = await setProjectAgentInstructions(project.id, text)
      applyLiveUpdate((w) => ({ ...w, project: patchProjectInstructions(w.project, block) }))
      setDraft(null)
      toast.success("Instructions saved. Agents get them on their next whoami.")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the instructions.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ProjectShell>
      {!project ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <div className="grid gap-10">
          <Section
            title="Project agent instructions"
            description={
              <>
                Every agent in {project.name} reads this on <code className="rounded bg-muted px-1 font-mono text-xs">whoami</code>.
              </>
            }
          >
            <div className="grid gap-3 rounded-xl border bg-card p-4">
              <Tabs value={tab} onValueChange={(v) => setTab(v as "write" | "preview")}>
                <TabsList>
                  <TabsTrigger value="write">Write</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>
              </Tabs>
              {tab === "write" ? (
                <Textarea
                  aria-label="Project agent instructions, markdown"
                  rows={16}
                  className="min-h-80 font-mono text-sm"
                  value={text}
                  readOnly={!powers.edit}
                  placeholder={powers.edit ? "## Branches\nWork on a branch off main. …" : "No project instructions yet."}
                  onChange={(e) => setDraft({ base: saved, text: e.target.value })}
                />
              ) : (
                <div className="min-h-64 rounded-lg border p-4 text-sm">{text.trim() ? <MarkdownRenderer content={text} /> : <p className="text-muted-foreground">Nothing to preview.</p>}</div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <p className="flex-1 text-xs text-muted-foreground">
                  {project.agent_instructions_updated_at ? `Last saved ${timeAgo(project.agent_instructions_updated_at, now)?.toLowerCase()}. ` : "Not saved yet. "}
                  {agents ? `${agents} ${agents === 1 ? "agent" : "agents"} will see the change.` : ""}
                  {!powers.edit ? " Only owners and admins can change these." : ""}
                </p>
                {powers.edit ? (
                  <>
                    <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(null)}>
                      Discard
                    </Button>
                    <Button disabled={!dirty || saving} onClick={save}>
                      {saving ? <Spinner /> : null}
                      Save instructions
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </Section>

          <div className="grid gap-6 sm:grid-cols-2">
            <Section title="Which wins">
              <ol className="grid gap-2 text-sm">
                {ORDER.map((line, i) => (
                  <li key={line} className="flex gap-3">
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">{i + 1}</span>
                    <span className={i === 2 ? "font-medium" : "text-muted-foreground"}>{line}</span>
                  </li>
                ))}
              </ol>
            </Section>
            <Section title="Role instructions" description="Each agent also has its own. Edit them on the agent's page.">
              <Button variant="outline" className="justify-self-start" nativeButton={false} render={<Link to="/v3/agents" />}>
                Open agents
              </Button>
            </Section>
          </div>
        </div>
      )}
    </ProjectShell>
  )
}
