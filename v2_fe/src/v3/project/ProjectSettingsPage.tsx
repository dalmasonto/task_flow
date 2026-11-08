/// Project settings (design: project-settings.html): the project's name,
/// short name and description; links to where the rest is configured, each
/// with a real one-line summary; and archive / delete for owners.
///
/// Writes go through `PATCH /api/taskflow/projects/{p}` (#1137, owner/admin;
/// archiving needs an owner) and the owner-only DELETE. The saved row is
/// applied at once, and realtime carries it to other tabs. Left out until the
/// backend has them: the design's Organisation and Lead fields, and "Move to
/// another organisation" (organisations are #1133; a project has no lead).
import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArchiveIcon, ArchiveRestoreIcon, ChevronRightIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { deleteProject, fetchGithubProjectStatus, updateTaskflowProject, type ProjectSettingsPatch } from "@/lib/taskflow-api"

import { myMembership } from "../invites/invites-logic"
import { useLoad } from "../lib/use-load"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { aboutError, aboutFrom, aboutPatch, endpointsSummary, projectPowers, type AboutForm } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

function AboutSection({ projectId, saved, canEdit, onSave }: { projectId: number; saved: AboutForm; canEdit: boolean; onSave: (patch: ProjectSettingsPatch) => Promise<void> }) {
  // The draft is kept against the saved values it started from, so a change
  // arriving from elsewhere resets an untouched form.
  const [draft, setDraft] = useState<{ base: AboutForm; form: AboutForm } | null>(null)
  const form = draft && draft.base === saved ? draft.form : saved
  const patch = aboutPatch(saved, form)
  const dirty = Object.keys(patch).length > 0
  const error = dirty ? aboutError(form) : null
  const [saving, setSaving] = useState(false)
  const set = (k: keyof AboutForm, v: string) => setDraft({ base: saved, form: { ...form, [k]: v } })

  async function save() {
    setSaving(true)
    try {
      await onSave(patch)
      setDraft(null)
      toast.success("Project saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the project.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      title="About the project"
      description={
        <>
          Agents see the description in <code className="rounded bg-muted px-1 font-mono text-xs">whoami</code>.
        </>
      }
    >
      <div className="grid gap-4 rounded-xl border bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`p-name-${projectId}`}>Name</FieldLabel>
            <Input id={`p-name-${projectId}`} value={form.name} disabled={!canEdit} onChange={(e) => set("name", e.target.value)} maxLength={160} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`p-slug-${projectId}`}>Short name</FieldLabel>
            <Input id={`p-slug-${projectId}`} value={form.slug} disabled={!canEdit} onChange={(e) => set("slug", e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" />
            <FieldDescription>Used in links and agent notices.</FieldDescription>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`p-desc-${projectId}`}>Description</FieldLabel>
          <Textarea id={`p-desc-${projectId}`} rows={4} value={form.description} disabled={!canEdit} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {canEdit ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error ? <p className="mr-auto text-sm text-destructive">{error}</p> : null}
            <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button disabled={!dirty || !!error || saving} onClick={save}>
              {saving ? <Spinner /> : null}
              Save changes
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only the project&apos;s owners and admins can change these.</p>
        )}
      </div>
    </Section>
  )
}

function SetupRow({ to, title, line }: { to: string; title: string; line: string }) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{line}</span>
        </span>
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </Link>
    </li>
  )
}

export function ProjectSettingsPage() {
  const { live, currentUser, applyLiveUpdate, refresh } = useWorkspace()
  const navigate = useNavigate()
  const now = useLivenessNow()
  const project = live?.project ?? null
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const github = useLoad(project ? `gh-status:${project.id}` : null, () => fetchGithubProjectStatus(project!.id))
  const [busy, setBusy] = useState<null | "archive" | "delete">(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmName, setConfirmName] = useState("")

  if (!project) {
    return (
      <ProjectShell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading the project…
        </div>
      </ProjectShell>
    )
  }

  const save = async (patch: ProjectSettingsPatch) => {
    const row = await updateTaskflowProject(project.id, patch)
    applyLiveUpdate((w) => ({ ...w, project: row }))
  }

  const archived = project.status === "archived"
  async function toggleArchive() {
    setBusy("archive")
    try {
      await save({ status: archived ? "active" : "archived" })
      toast.success(archived ? "Project is active again" : "Project archived")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setBusy("delete")
    try {
      await deleteProject(project!.id)
      toast.success(`${project!.name} deleted`)
      setDeleteOpen(false)
      refresh()
      navigate("/v3/home", { replace: true })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete the project.")
      setBusy(null)
    }
  }

  const members = (live?.members ?? []).filter((m) => m.status === "active").length
  const waiting = (live?.invites ?? []).filter((i) => i.status === "pending").length
  const repos = github.data?.repos ?? (github.data?.github_repo ? [{ repo: github.data.github_repo, is_default: true }] : [])
  const defRepo = repos.find((r) => r.is_default)?.repo

  return (
    <ProjectShell>
      <div className="grid gap-10">
        <AboutSection key={project.id} projectId={project.id} saved={aboutFrom(project)} canEdit={powers.edit} onSave={save} />

        <Section title="Set up" description="Where the rest of this project is configured.">
          <ul className="divide-y rounded-xl border bg-card">
            <SetupRow
              to="/v3/project/instructions"
              title="Agent instructions"
              line={project.agent_instructions_markdown ? `Rules every agent here follows. Updated ${timeAgo(project.agent_instructions_updated_at, now)?.toLowerCase() ?? "earlier"}.` : "None yet. Agents follow TaskFlow's defaults."}
            />
            <SetupRow to="/v3/project/workflow" title="Workflow" line="The board's five columns and the statuses in each." />
            <SetupRow
              to="/v3/project/repos"
              title="Repositories"
              line={github.error ? "Couldn't check GitHub." : !github.data ? "Checking…" : repos.length ? `${repos.length} linked${defRepo ? `. Default ${defRepo}` : ""}.` : "None linked."}
            />
            <SetupRow
              to="/v3/project/github"
              title="GitHub"
              line={!github.data ? "…" : github.data.project_linked ? (github.data.auto_mirror ? "Comments mirror to issues automatically." : "Linked. Comments mirror only when someone chooses.") : "Not linked."}
            />
            <SetupRow to="/v3/project/endpoints" title="Environments" line={endpointsSummary(live?.apiEndpoints ?? [])} />
            <SetupRow to="/v3/invites" title="Members" line={`${members} ${members === 1 ? "member" : "members"}${waiting ? `, ${waiting} ${waiting === 1 ? "invite" : "invites"} waiting` : ""}.`} />
          </ul>
        </Section>

        {powers.owner ? (
          <Section title="Archive or delete" description="Project owners only.">
            <ul className="divide-y rounded-xl border border-destructive/30 bg-card">
              <li className="flex flex-wrap items-center gap-3 px-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{archived ? "Bring the project back" : "Archive project"}</p>
                  <p className="text-xs text-muted-foreground">{archived ? "It's read-only while archived. Bring it back to work in it again." : "Read-only. Agents are disconnected; you can bring it back any time."}</p>
                </div>
                <Button variant="outline" disabled={busy !== null} onClick={toggleArchive}>
                  {busy === "archive" ? <Spinner /> : archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {archived ? "Unarchive" : "Archive"}
                </Button>
              </li>
              <li className="flex flex-wrap items-center gap-3 px-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Delete project</p>
                  <p className="text-xs text-muted-foreground">Deletes every task, room, file and agent key in it. Can&apos;t be undone.</p>
                </div>
                <Button variant="destructive" disabled={busy !== null} onClick={() => setDeleteOpen(true)}>
                  <Trash2Icon />
                  Delete {project.name}
                </Button>
              </li>
            </ul>
          </Section>
        ) : null}
      </div>

      <Dialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o)
          if (!o) setConfirmName("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>Every task, room, message, file, design page and agent key in it is deleted for everyone. Agents using its keys stop at once. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="confirm-project-name">Type {project.name} to confirm</FieldLabel>
            <Input id="confirm-project-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={confirmName.trim() !== project.name || busy !== null} onClick={remove}>
              {busy === "delete" ? <Spinner /> : null}
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProjectShell>
  )
}
