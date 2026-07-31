import { AttachableTextarea } from "@/components/attachable-textarea"
import { type AttachableFile } from "@/components/attachable-textarea"
import { Button } from "@/components/ui/button"
import { CheckIcon, ClipboardCheckIcon, FileJsonIcon, FileTextIcon, FolderKanbanIcon, PencilIcon, PlusIcon, UserRoundPlusIcon, XIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { ProjectFormError } from "@/lib/taskflow-api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { inviteTypeOptions, priorityOptions, projectStatusOptions, reviewDecisionOptions, statusOptions, syncModeOptions, type ColumnId, type DialogMode, type Priority, type Project, type Task } from "@/lib/workspace-view"
import { slugifyProjectName } from "@/lib/live-mappers"
import { type TaskflowAgent, type TaskflowProjectMember } from "@/api/client"
import { useState, type FormEvent } from "react"


export function WorkspaceDialog({
  mode,
  activeProject,
  reviewTask,
  editTask,
  members,
  agents,
  taskOwner,
  onTaskOwnerChange,
  taskOperator,
  onTaskOperatorChange,
  taskDue,
  onTaskDueChange,
  onClose,
  onEditProject,
  onCreateProject,
  onUpdateProject,
  onCreateTask,
  onCreateInvite,
  onReviewDecision,
}: {
  mode: DialogMode
  activeProject: Project | undefined
  reviewTask?: Task
  editTask?: {
    title: string
    status: ColumnId
    priority: Priority
    estimate: string
    description: string
    notes: string
    review: string
  }
  members: TaskflowProjectMember[]
  agents: TaskflowAgent[]
  taskOwner: { id: number; label: string } | null
  onTaskOwnerChange: (owner: { id: number; label: string } | null) => void
  taskOperator: string
  onTaskOperatorChange: (operator: string) => void
  taskDue: string
  onTaskDueChange: (due: string) => void
  onClose: () => void
  onEditProject?: () => void
  onCreateProject: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onUpdateProject: (event: FormEvent<HTMLFormElement>) => void
  onCreateTask: (event: FormEvent<HTMLFormElement>, files: File[]) => void
  onCreateInvite: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onReviewDecision: (event: FormEvent<HTMLFormElement>) => void
}) {
  // Dialog-local submit state so create/invite errors show INLINE and the
  // dialog stays open on failure. The dialog is keyed by `mode` at its call
  // site, so a mode change remounts it and resets this state — no effect needed.
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [formError, setFormError] = useState<string | null>(null)
  // Files staged in the task description; uploaded to the task after it saves.
  // The dialog is keyed by mode at its call site, so this resets on remount.
  const [taskFiles, setTaskFiles] = useState<AttachableFile[]>([])
  const stageTaskFiles = (incoming: File[]) => {
    if (!incoming.length) return
    setTaskFiles((current) => [
      ...current,
      ...incoming.map((file) => ({
        id: `staged:${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`,
        file,
      })),
    ])
  }
  const removeTaskFile = (id: string) => setTaskFiles((current) => current.filter((f) => f.id !== id))

  // Wrap an async submit handler: show the spinner, clear prior errors, and on
  // failure map ProjectFormError field errors + form message and stay open. On
  // success, close the dialog.
  async function runSubmit(
    event: FormEvent<HTMLFormElement>,
    handler: (event: FormEvent<HTMLFormElement>) => Promise<void>
  ) {
    event.preventDefault()
    setSubmitting(true)
    setFieldErrors({})
    setFormError(null)
    try {
      await handler(event)
      onClose()
    } catch (error) {
      if (error instanceof ProjectFormError) {
        setFieldErrors(error.fieldErrors)
        setFormError(error.message || "Please fix the errors below.")
      } else {
        setFormError(error instanceof Error ? error.message : "Something went wrong. Please try again.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!mode) return null
  // Every mode except "new-project" acts on the active project. If there is no
  // active project, only project creation is valid.
  if (mode !== "new-project" && !activeProject) return null

  const titles: Record<Exclude<DialogMode, null>, string> = {
    "new-project": "Create Project",
    "edit-project": "Edit Project",
    "project-info": "Project Info",
    "new-task": "Create Task",
    "edit-task": "Edit Task",
    invite: "Invite User Or Agent",
    "api-contract": "API Contract",
    "review-decision": "Human Review",
  }

  // Radix Select forbids an empty-string item value, so an "unassigned" choice
  // uses this sentinel and maps back to null/"" in the change handlers.
  const NONE_OPTION = "__none__"
  const activeMembers = members.filter((member) => member.status === "active" && member.user != null)

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-[60] bg-foreground/15"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={titles[mode]}
        className="fixed inset-2 z-[70] flex flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90svh] sm:w-[min(39rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2"
      >
        <header
          className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--primary) 16%, transparent), transparent)",
          }}
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{activeProject?.name ?? "New workspace"}</p>
            <h2 className="mt-1 text-xl font-semibold">{titles[mode]}</h2>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {mode === "new-project" ? (
          <form className="space-y-4 p-5" onSubmit={(event) => void runSubmit(event, onCreateProject)}>
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <FormField label="Project name" error={fieldErrors.name?.[0]}>
                <Input name="name" required placeholder="Acme Web App" />
              </FormField>
              <FormField label="Slug" error={fieldErrors.slug?.[0]}>
                <Input name="slug" placeholder="acme-web-app" />
              </FormField>
            </div>
            <FormField label="Description, markdown" error={fieldErrors.description_markdown?.[0]}>
              <textarea
                name="description_markdown"
                className={textareaClass}
                placeholder={"### Mission\nDescribe what this project owns and how humans/agents should operate."}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Repository URL" error={fieldErrors.repository_url?.[0]}>
                <Input name="repository_url" placeholder="https://github.com/org/repo" />
              </FormField>
              <FormField label="API base" error={fieldErrors.default_api_base_url?.[0]}>
                <Input name="default_api_base_url" defaultValue="/api" />
              </FormField>
            </div>
            <DialogFormError message={formError} />
            <DialogActions onClose={onClose} submitLabel="Create Project" submitIcon={<FolderKanbanIcon />} submitting={submitting} />
          </form>
        ) : null}

        {mode === "edit-project" ? (
          <form className="space-y-4 p-5" onSubmit={onUpdateProject}>
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <FormField label="Project name">
                <Input name="name" required defaultValue={activeProject?.name ?? ""} />
              </FormField>
              <FormField label="Slug">
                <Input name="slug" defaultValue={slugifyProjectName(activeProject?.name ?? "")} />
              </FormField>
            </div>
            <FormField label="Description, markdown">
              <textarea
                name="description_markdown"
                className={textareaClass}
                defaultValue={activeProject?.objective ?? ""}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Repository URL">
                <Input name="repository_url" placeholder="https://github.com/org/repo" />
              </FormField>
              <FormField label="API base">
                <Input name="default_api_base_url" defaultValue={activeProject?.apiBase ?? ""} />
              </FormField>
              <FormField label="Status">
                <SelectField
                  name="status"
                  defaultValue={activeProject?.status === "seeded" ? "active" : activeProject?.status ?? "active"}
                  options={projectStatusOptions}
                />
              </FormField>
            </div>
            <DialogActions onClose={onClose} submitLabel="Save Project" submitIcon={<CheckIcon />} />
          </form>
        ) : null}

        {mode === "new-task" || mode === "edit-task" ? (
          <form
            className="space-y-4 p-5"
            onSubmit={(event) => onCreateTask(event, taskFiles.map((staged) => staged.file))}
          >
            <FormField label="Task title">
              <Input
                name="title"
                required
                placeholder="Write the outcome, not just the activity"
                defaultValue={editTask?.title}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Status">
                <SelectField name="status" defaultValue={editTask?.status ?? "not_started"} options={statusOptions} />
              </FormField>
              <FormField label="Priority">
                <SelectField name="priority" defaultValue={editTask?.priority ?? "high"} options={priorityOptions} />
              </FormField>
              <FormField label="Owner">
                <Select
                  value={taskOwner ? String(taskOwner.id) : NONE_OPTION}
                  items={[
                    { value: NONE_OPTION, label: "Unassigned" },
                    ...activeMembers.map((member) => ({
                      value: String(member.user),
                      label: member.display_name,
                    })),
                  ]}
                  onValueChange={(value) => {
                    if (value === NONE_OPTION) {
                      onTaskOwnerChange(null)
                      return
                    }
                    const member = activeMembers.find((m) => String(m.user) === value)
                    onTaskOwnerChange(
                      member?.user != null ? { id: member.user, label: member.display_name } : null
                    )
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_OPTION}>Unassigned</SelectItem>
                    {activeMembers.map((member) => (
                      <SelectItem key={member.user} value={String(member.user)}>
                        {member.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Operator">
                <Select
                  value={taskOperator || NONE_OPTION}
                  items={[
                    { value: NONE_OPTION, label: "Unassigned" },
                    ...activeMembers.map((member) => ({
                      value: `user:${member.user}`,
                      label: member.display_name,
                    })),
                    ...agents.map((agent) => ({
                      value: `agent:${agent.id}`,
                      label: agent.display_name,
                    })),
                  ]}
                  onValueChange={(value) => onTaskOperatorChange(!value || value === NONE_OPTION ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_OPTION}>Unassigned</SelectItem>
                    {activeMembers.map((member) => (
                      <SelectItem key={`user:${member.user}`} value={`user:${member.user}`}>
                        {member.display_name}
                      </SelectItem>
                    ))}
                    {agents.map((agent) => (
                      <SelectItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>
                        {agent.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Due">
                <Input
                  type="datetime-local"
                  value={taskDue}
                  onChange={(event) => onTaskDueChange(event.target.value)}
                />
              </FormField>
              <FormField label="Estimate">
                <Input name="estimate" placeholder="minutes, e.g. 90" defaultValue={editTask?.estimate} />
              </FormField>
            </div>
            <FormField label="Tags">
              <Input name="tags" placeholder="api, review, frontend" />
            </FormField>
            <FormField label="Description">
              <span className="text-xs text-muted-foreground">
                markdown — attach a file and click it to drop its name at the cursor
              </span>
              <AttachableTextarea
                name="description"
                className={textareaClass}
                placeholder={"### Goal\nDescribe the outcome, acceptance criteria, and constraints."}
                defaultValue={editTask?.description ?? ""}
                files={taskFiles}
                onStageFiles={stageTaskFiles}
                onRemoveFile={removeTaskFile}
              />
            </FormField>
            <FormField label="Notes">
              <span className="text-xs text-muted-foreground">you can write in markdown</span>
              <textarea
                name="notes"
                className={textareaClass}
                placeholder={"- Implementation detail\n- Link to related decision\n- Follow-up to verify"}
                defaultValue={editTask?.notes}
              />
            </FormField>
            <FormField label="Review gate">
              <textarea
                name="review"
                className={textareaClass}
                placeholder="What must a human approve before this can ship?"
                defaultValue={editTask?.review}
              />
            </FormField>
            <DialogActions
              onClose={onClose}
              submitLabel={mode === "edit-task" ? "Save changes" : "Create Task"}
              submitIcon={mode === "edit-task" ? <PencilIcon /> : <PlusIcon />}
            />
          </form>
        ) : null}

        {mode === "invite" ? (
          <form className="space-y-4 p-5" onSubmit={(event) => void runSubmit(event, onCreateInvite)}>
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <FormField label="Email or agent name">
                <Input name="recipient" required placeholder="teammate@example.com" />
              </FormField>
              <FormField label="Type">
                <SelectField name="type" defaultValue="user" options={inviteTypeOptions} />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className={choiceClass}>
                <input type="radio" name="role" defaultChecked value="owner" />
                <span>Owner</span>
                <small>Full project control</small>
              </label>
              <label className={choiceClass}>
                <input type="radio" name="role" value="developer" />
                <span>Developer</span>
                <small>Tasks, agents, code</small>
              </label>
              <label className={choiceClass}>
                <input type="radio" name="role" value="viewer" />
                <span>Viewer</span>
                <small>Read-only context</small>
              </label>
            </div>
            <FormField label="Message">
              <textarea name="message" className={textareaClass} placeholder="Add context for the invite." />
            </FormField>
            <DialogFormError message={formError} />
            <DialogActions onClose={onClose} submitLabel="Send Invite" submitIcon={<UserRoundPlusIcon />} submitting={submitting} />
          </form>
        ) : null}

        {mode === "api-contract" ? (
          <form className="space-y-4 p-5" onSubmit={onUpdateProject}>
            <div className="rounded-xl border bg-background p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileJsonIcon className="size-4 text-primary" />
                Live API Preview
              </div>
              <code className="mt-3 block overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                GET {activeProject?.apiBase ?? ""}/workspace?include=tasks,agents,reviews,activity
              </code>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="API base">
                <Input name="default_api_base_url" defaultValue={activeProject?.apiBase ?? ""} />
              </FormField>
              <FormField label="Sync mode">
                <SelectField name="syncMode" defaultValue="realtime" options={syncModeOptions} />
              </FormField>
            </div>
            <FormField label="Required response keys">
              <textarea
                className={textareaClass}
                defaultValue={"project\nmembers\ntasks[].description\ntasks[].notes\nagents\nreviewQueue\nactivityCursor"}
              />
            </FormField>
            <DialogActions onClose={onClose} submitLabel="Save Contract" submitIcon={<CheckIcon />} />
          </form>
        ) : null}

        {mode === "review-decision" ? (
          <form className="space-y-4 p-5" onSubmit={onReviewDecision}>
            <div className="rounded-xl border bg-background p-3">
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Reviewing</p>
              <p className="mt-1 text-sm font-semibold">{reviewTask?.title ?? "No task selected"}</p>
              <MarkdownRenderer
                content={reviewTask?.review ?? "Select a task that needs review."}
                compact
                className="mt-2 [&_p]:text-sm"
              />
            </div>
            <FormField label="Decision">
              <SelectField name="decision" defaultValue="approve" options={reviewDecisionOptions} />
            </FormField>
            <FormField label="Decision note">
              <textarea name="note" className={textareaClass} placeholder="Add the reason. This becomes part of activity." />
            </FormField>
            <DialogActions onClose={onClose} submitLabel="Submit Decision" submitIcon={<ClipboardCheckIcon />} />
          </form>
        ) : null}

        {mode === "project-info" ? (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-primary/10 px-2 py-1 font-mono text-xs font-medium text-primary ring-1 ring-primary/20">
                {activeProject?.code}
              </span>
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/20">
                {activeProject?.health}
              </span>
              <span className="text-xs text-muted-foreground">{activeProject?.apiBase}</span>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <MarkdownRenderer
                content={activeProject?.objective?.trim() || "No description yet."}
                className="[&_p]:text-sm [&_p]:leading-6"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => onEditProject?.()}>
                <FileTextIcon />
                Edit Project
              </Button>
            </div>
          </div>
        ) : null}
        </div>
      </section>
    </>
  )
}


export const textareaClass =
  "min-h-32 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50"


export const choiceClass =
  "grid cursor-pointer gap-1 rounded-xl border bg-background p-3 text-sm transition has-checked:border-primary has-checked:bg-primary/10"


export function FormField({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {error ? (
        <span className="text-xs font-normal text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}


/// Form-level error shown near a dialog's submit button. Renders nothing when
/// there is no message.
export function DialogFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  )
}


export function SelectField({
  name,
  defaultValue,
  options,
  placeholder = "Select an option",
}: {
  name: string
  defaultValue: string
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <Select name={name} defaultValue={defaultValue} items={options}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}


export function DialogActions({
  onClose,
  submitLabel,
  submitIcon,
  submitting = false,
}: {
  onClose: () => void
  submitLabel: string
  submitIcon: React.ReactNode
  submitting?: boolean
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t pt-4">
      <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={submitting}>
        {submitIcon}
        {submitting ? "Working…" : submitLabel}
      </Button>
    </div>
  )
}
