/// Environments (design: project-endpoints.html): the servers this project
/// runs on, and which one is the default.
///
/// Owners and admins add, edit, remove and choose the default through the
/// #1139 handlers; everyone else reads. There is exactly one default whenever
/// any exist, and the project's API address follows it. Health is whatever
/// the server recorded; nothing checks it yet, so an unchecked row says so.
/// Agents don't receive either address yet (whoami serves neither), so the
/// copy doesn't claim they do.
import { useState } from "react"
import { PencilIcon, PlusIcon, ServerIcon, StarIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowProjectApiEndpoint } from "@/api/client"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { createEnvironment, deleteEnvironment, setDefaultEnvironment, updateEnvironment } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { myMembership } from "../invites/invites-logic"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { environmentFormError, isLocalUrl, projectPowers, removeEnvironment, sortEndpoints, upsertEnvironment, type EnvironmentForm } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

const ENV_LABEL: Record<TaskflowProjectApiEndpoint["environment"], string> = { production: "Production", staging: "Staging", preview: "Preview", local: "Local" }
const ENV_ORDER: TaskflowProjectApiEndpoint["environment"][] = ["local", "preview", "staging", "production"]

const HEALTH: Record<TaskflowProjectApiEndpoint["health"], { label: string; dot: string }> = {
  healthy: { label: "Healthy", dot: "bg-done" },
  degraded: { label: "Slow", dot: "bg-blocked" },
  down: { label: "Down", dot: "bg-destructive" },
  unknown: { label: "Not checked", dot: "bg-muted-foreground/40" },
}

const EMPTY_FORM: EnvironmentForm = { label: "", base_url: "", environment: "local", notes: "" }

function EnvironmentFields({ idPrefix, form, onChange }: { idPrefix: string; form: EnvironmentForm; onChange: (f: EnvironmentForm) => void }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-label`}>Name</FieldLabel>
          <Input id={`${idPrefix}-label`} value={form.label} maxLength={80} placeholder="Production" onChange={(e) => onChange({ ...form, label: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-kind`}>Kind</FieldLabel>
          <Select items={ENV_LABEL} value={form.environment} onValueChange={(v) => v && onChange({ ...form, environment: v as EnvironmentForm["environment"] })}>
            <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENV_ORDER.map((e) => (
                <SelectItem key={e} value={e}>
                  {ENV_LABEL[e]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-url`}>Base URL</FieldLabel>
        <Input id={`${idPrefix}-url`} value={form.base_url} className="font-mono" spellCheck={false} autoComplete="off" placeholder="https://api.example.com" onChange={(e) => onChange({ ...form, base_url: e.target.value })} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-notes`}>
          Notes <span className="font-normal text-muted-foreground">Optional</span>
        </FieldLabel>
        <Textarea id={`${idPrefix}-notes`} rows={2} value={form.notes} maxLength={1000} placeholder="Seeded with demo data; resets nightly." onChange={(e) => onChange({ ...form, notes: e.target.value })} />
      </Field>
    </div>
  )
}

function formFrom(e: TaskflowProjectApiEndpoint): EnvironmentForm {
  return { label: e.label, base_url: e.base_url, environment: e.environment, notes: e.notes_markdown ?? "" }
}

export function ProjectEndpointsPage() {
  const { live, currentUser, applyLiveUpdate } = useWorkspace()
  const now = useLivenessNow()
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const rows = sortEndpoints(live?.apiEndpoints ?? [])
  const projectId = live?.project.id ?? null
  const [busy, setBusy] = useState<string | null>(null)
  const [add, setAdd] = useState<EnvironmentForm>(EMPTY_FORM)
  const [addDefault, setAddDefault] = useState(false)
  const [editing, setEditing] = useState<{ row: TaskflowProjectApiEndpoint; form: EnvironmentForm } | null>(null)
  const [removing, setRemoving] = useState<TaskflowProjectApiEndpoint | null>(null)
  const addError = add.label || add.base_url ? environmentFormError(add) : null

  const setRows = (f: (r: TaskflowProjectApiEndpoint[]) => TaskflowProjectApiEndpoint[]) => applyLiveUpdate((w) => ({ ...w, apiEndpoints: f(w.apiEndpoints) }))

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    try {
      await action()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <ProjectShell>
      <div className="grid gap-10">
        <Section title="Environments" description="The servers this project runs on. The default is what TaskFlow shows as this project's API.">
          {!live ? (
            // #1093: the list's own shape while it loads, not a spinner line.
            <div className="divide-y rounded-xl border bg-card" aria-busy="true" aria-label="Loading environments">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          ) : rows.length ? (
            <ul className="divide-y rounded-xl border bg-card">
              {rows.map((e) => {
                const local = isLocalUrl(e.base_url)
                const h = HEALTH[e.health] ?? HEALTH.unknown
                return (
                  <li key={e.id} className="grid gap-1 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{e.label}</span>
                      <Badge variant="outline">{ENV_LABEL[e.environment] ?? e.environment}</Badge>
                      {e.is_default ? <Badge>Default</Badge> : null}
                      {!local && e.last_checked_at ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={cn("size-2 rounded-full", h.dot)} aria-hidden />
                          {h.label}
                        </span>
                      ) : null}
                      {powers.edit && projectId != null ? (
                        <span className="ml-auto flex gap-1">
                          {!e.is_default ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() =>
                                run(`d:${e.id}`, async () => {
                                  const all = await setDefaultEnvironment(projectId, e.id)
                                  setRows(() => all)
                                  toast.success(`${e.label} is the default`)
                                })
                              }
                            >
                              {busy === `d:${e.id}` ? <Spinner /> : <StarIcon />}
                              Make default
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" aria-label={`Edit ${e.label}`} disabled={busy !== null} onClick={() => setEditing({ row: e, form: formFrom(e) })}>
                            <PencilIcon />
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Remove ${e.label}`} disabled={busy !== null} onClick={() => setRemoving(e)}>
                            <Trash2Icon />
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    <code className="truncate font-mono text-xs text-muted-foreground">{e.base_url}</code>
                    <p className="text-xs text-muted-foreground">
                      {local ? "Local addresses can't be checked from the server." : e.last_checked_at ? `Checked ${timeAgo(e.last_checked_at, now)?.toLowerCase()}.` : "Not checked."}
                    </p>
                    {e.notes_markdown ? <p className="text-xs">{e.notes_markdown}</p> : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <Empty className="rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon />
                </EmptyMedia>
                <EmptyTitle>No environments yet</EmptyTitle>
                <EmptyDescription>{powers.edit ? "Add the servers this project runs on. The first one becomes the default." : "An owner or admin adds the servers this project runs on."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </Section>

        {powers.edit && projectId != null ? (
          <Section title="Add environment">
            <div className="grid gap-4 rounded-xl border bg-card p-5">
              <EnvironmentFields idPrefix="env-add" form={add} onChange={setAdd} />
              {rows.length ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={addDefault} onCheckedChange={(v) => setAddDefault(!!v)} />
                  Make it the default
                </label>
              ) : (
                <FieldDescription>This is the first one, so it becomes the default.</FieldDescription>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={busy !== null || !add.label.trim() || !add.base_url.trim() || !!addError}
                  onClick={() =>
                    run("add", async () => {
                      const row = await createEnvironment(projectId, {
                        label: add.label.trim(),
                        base_url: add.base_url.trim(),
                        environment: add.environment,
                        notes_markdown: add.notes.trim() || null,
                        is_default: addDefault,
                      })
                      setRows((r) => upsertEnvironment(r, row))
                      setAdd(EMPTY_FORM)
                      setAddDefault(false)
                      toast.success(`${row.label} added`)
                    })
                  }
                >
                  {busy === "add" ? <Spinner /> : <PlusIcon />}
                  Add environment
                </Button>
                {addError ? <p className="text-sm text-destructive">{addError}</p> : null}
              </div>
            </div>
          </Section>
        ) : null}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.row.label}</DialogTitle>
          </DialogHeader>
          {editing ? <EnvironmentFields idPrefix="env-edit" form={editing.form} onChange={(form) => setEditing({ ...editing, form })} /> : null}
          {editing && environmentFormError(editing.form) ? <p className="text-sm text-destructive">{environmentFormError(editing.form)}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={!editing || !!environmentFormError(editing.form) || busy !== null}
              onClick={() =>
                editing &&
                projectId != null &&
                run("edit", async () => {
                  const f = editing.form
                  const row = await updateEnvironment(projectId, editing.row.id, { label: f.label.trim(), base_url: f.base_url.trim(), environment: f.environment, notes_markdown: f.notes.trim() || null })
                  setRows((r) => upsertEnvironment(r, row))
                  setEditing(null)
                  toast.success(`${row.label} saved`)
                })
              }
            >
              {busy === "edit" ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.is_default && rows.length > 1 ? "It's the default, so the oldest remaining environment becomes the default. " : ""}
              This only removes it from TaskFlow; the server itself is untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                removing &&
                projectId != null &&
                run(`r:${removing.id}`, async () => {
                  const res = await deleteEnvironment(projectId, removing.id)
                  setRows((r) => removeEnvironment(r, res))
                  toast.success(`${removing.label} removed`)
                  setRemoving(null)
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProjectShell>
  )
}
