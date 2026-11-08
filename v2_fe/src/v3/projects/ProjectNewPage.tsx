/// Create a project (design: project-new.html). Name, what it's for (which
/// becomes the instructions every agent reads), an optional GitHub repo, then
/// either straight to the board or on to pairing two agents.
import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { ArrowRightIcon, LockIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { addGithubProjectRepo, setProjectAgentInstructions } from "@/lib/taskflow-api"

import { GithubMark } from "../auth/auth-ui"
import { ActorAvatar } from "../components/actor-avatar"
import { PAIRINGS } from "../onboarding/onboarding-logic"
import { onboardingStore } from "../onboarding/onboarding-store"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { parseRepo } from "./project-new-logic"

type Next = { to: "board" } | { to: "agents"; pairing?: string }

export function ProjectNewPage() {
  const navigate = useNavigate()
  const { createProject } = useWorkspace()
  const [pending, setPending] = useState<Next["to"] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; repo?: string }>({})

  async function create(form: HTMLFormElement, next: Next) {
    const f = new FormData(form)
    const name = String(f.get("name") ?? "").trim()
    const purpose = String(f.get("purpose") ?? "").trim()
    const repoInput = String(f.get("repo") ?? "").trim()
    const repo = repoInput ? parseRepo(repoInput) : null
    const errs = {
      name: name ? undefined : "Give the project a name.",
      repo: repoInput && !repo ? "Use owner/repo, for example dalmasonto/matchday." : undefined,
    }
    setFieldErrors(errs)
    if (errs.name || errs.repo) return

    setPending(next.to)
    setError(null)
    try {
      const { id } = await createProject({ name, description_markdown: purpose || undefined })
      // Both are follow-ups on a project that now exists: a failure here must not
      // read as "the project wasn't created", so they never throw past this point.
      if (purpose) {
        await setProjectAgentInstructions(Number(id), purpose).catch(() => {
          toast.warning("Project created, but agents won't see its purpose yet", {
            description: "Saving it as project instructions failed. Add it in Settings → Agent instructions.",
          })
        })
      }
      let repoNote: string | null = null
      if (repo) {
        await addGithubProjectRepo(Number(id), repo).catch((e: unknown) => {
          repoNote = e instanceof Error ? e.message : "GitHub didn't accept it."
        })
      }
      if (next.to === "agents") {
        onboardingStore.setProject(id)
        navigate(`/v3/onboarding/agents${next.pairing ? `?pairing=${encodeURIComponent(next.pairing)}` : ""}`)
      } else {
        navigate("/v3/board")
      }
      if (repoNote) {
        toast.warning("Project created, but the repo wasn't linked", { description: `${repoNote} You can link it later in Repositories.` })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the project.")
    } finally {
      setPending(null)
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    void create(e.currentTarget, submitter?.value === "agents" ? { to: "agents" } : { to: "board" })
  }

  const busy = pending !== null

  return (
    <V3Shell title="New project">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form id="new-project" className="min-w-0" onSubmit={onSubmit} noValidate aria-labelledby="np-title">
          <h2 id="np-title" className="text-xl font-semibold tracking-tight">
            Create a project
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">A project holds one board, its rooms and the agents that work on it.</p>

          {error ? (
            <Alert variant="destructive" className="mt-6 rounded-xl">
              <TriangleAlertIcon />
              <AlertDescription className="text-foreground">{error}</AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup className="mt-6 gap-6">
            <Field data-invalid={fieldErrors.name ? true : undefined}>
              <FieldLabel htmlFor="np-name">Project name</FieldLabel>
              <Input id="np-name" name="name" autoComplete="off" autoFocus placeholder="Matchday league site" className="h-10 rounded-lg" aria-invalid={!!fieldErrors.name} />
              {fieldErrors.name ? <FieldError>{fieldErrors.name}</FieldError> : <FieldDescription>Agents see this name in whoami. You can rename it later.</FieldDescription>}
            </Field>

            <Field>
              <FieldLabel htmlFor="np-purpose">
                What is it for? <span className="font-normal text-muted-foreground">Optional</span>
              </FieldLabel>
              <Textarea id="np-purpose" name="purpose" rows={3} placeholder="Five-a-side league site: fixtures, tables and team pages." className="rounded-lg" />
              <FieldDescription>Becomes the project instructions every agent reads first.</FieldDescription>
            </Field>

            <Field data-invalid={fieldErrors.repo ? true : undefined}>
              <FieldLabel htmlFor="np-repo">
                Link a repo <span className="font-normal text-muted-foreground">Optional</span>
              </FieldLabel>
              <InputGroup className="h-10 rounded-lg">
                <InputGroupAddon>
                  <GithubMark className="size-4" />
                </InputGroupAddon>
                <InputGroupInput id="np-repo" name="repo" autoComplete="off" spellCheck={false} placeholder="owner/repo, e.g. dalmasonto/matchday" aria-invalid={!!fieldErrors.repo} />
              </InputGroup>
              {fieldErrors.repo ? <FieldError>{fieldErrors.repo}</FieldError> : <FieldDescription>Needs GitHub connected. Add more repos later in Repositories.</FieldDescription>}
            </Field>

            <div className="flex items-start gap-3 rounded-lg border border-border p-3">
              <LockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="text-sm">
                <span className="font-medium">Only people you invite can see it.</span>{" "}
                <span className="text-muted-foreground">Agents join with a key you create.</span>
              </p>
            </div>
          </FieldGroup>

          <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center">
            <Button type="button" variant="ghost" onClick={() => navigate(-1)} disabled={busy} className="sm:mr-auto">
              Cancel
            </Button>
            <Button type="submit" name="next" value="agents" variant="outline" disabled={busy}>
              {pending === "agents" ? <Spinner /> : null}
              Create, then add agents
            </Button>
            <Button type="submit" name="next" value="board" disabled={busy}>
              {pending === "board" ? <Spinner /> : null}
              {pending === "board" ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>

        <aside className="min-w-0">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">Start with two agents</h3>
            <p className="mt-1 text-sm text-muted-foreground">Projects come alive when agents from different models talk. Pick a pair and we create the project, then set up both keys.</p>
            <ul className="mt-3 space-y-2 text-sm">
              {PAIRINGS.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const form = document.getElementById("new-project") as HTMLFormElement | null
                      if (form) void create(form, { to: "agents", pairing: p.id })
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border p-2.5 text-left transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                  >
                    <span className="flex -space-x-1.5">
                      {p.agents.map((a) => (
                        <ActorAvatar key={a.profile} model={a.model} name={a.displayName} size="sm" />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{p.title}</span>
                      <span className="block text-xs text-muted-foreground">{p.detail}</span>
                    </span>
                    <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </V3Shell>
  )
}
