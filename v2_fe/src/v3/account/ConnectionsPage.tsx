/// Connected accounts (design: account-connections): GitHub, and the defaults
/// TaskFlow uses for you (the project to open after login, email).
///
/// GitHub (#1135): who you're connected as and since when, and Disconnect,
/// which asks for your password and first warns which projects' issue sync
/// rides on your connection. An older server only says connected or not and
/// has no disconnect, so the card falls back to Connect / Reconnect. "Post as
/// me" is per project on the server, shown for the active project when it's
/// linked to a repo.
import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { CheckIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { disconnectGithub, fetchGithubMe, fetchGithubProjectStatus, fetchUserSettings, GithubPasswordRequired, githubConnectUrl, setGithubPostAsMe, updateUserSettings } from "@/lib/taskflow-api"

import { GithubMark } from "../auth/auth-ui"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { AccountShell } from "./AccountShell"
import { githubStatusLine, trackingWarning } from "./account-logic"

const NONE = "none"

function DisconnectDialog({ open, onOpenChange, projects, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; projects: { id: number; name: string }[]; onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<{ text: string; needsPassword: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const warning = trackingWarning(projects)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password || pending) return
    setPending(true)
    setError(null)
    try {
      const res = await disconnectGithub(password)
      toast.success(res.disconnected ? "GitHub disconnected" : "GitHub was already disconnected")
      setPassword("")
      onOpenChange(false)
      onDone()
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : "Couldn't disconnect GitHub.", needsPassword: err instanceof GithubPasswordRequired })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPassword("")
          setError(null)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>Disconnect GitHub?</DialogTitle>
            <DialogDescription>TaskFlow stops acting on GitHub for you, and its access token is revoked. You can connect again any time.</DialogDescription>
          </DialogHeader>
          {warning ? (
            <Alert className="rounded-xl border-blocked/40 bg-blocked/10">
              <TriangleAlertIcon />
              <AlertDescription className="text-foreground">{warning}</AlertDescription>
            </Alert>
          ) : null}
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="gh-pw">Your TaskFlow password</FieldLabel>
            <Input id="gh-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
            {error ? (
              <FieldError>
                {error.text}
                {error.needsPassword ? (
                  <>
                    {" "}
                    <Link to="/v3/forgot-password" className="underline underline-offset-2">
                      Set a password
                    </Link>
                  </>
                ) : null}
              </FieldError>
            ) : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!password || pending}>
              {pending ? <Spinner /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ConnectionsPage() {
  const { live, projects } = useWorkspace()
  const project = live?.project ?? null
  const me = useLoad("github-me", () => fetchGithubMe())
  const status = useLoad(project ? `gh-status|${project.id}` : null, () => fetchGithubProjectStatus(project!.id))
  const settings = useLoad("user-settings", () => fetchUserSettings())
  const [saving, setSaving] = useState<string | null>(null)

  const save = async (what: string, fn: () => Promise<unknown>, done: string, reload: () => void) => {
    setSaving(what)
    try {
      await fn()
      toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that.")
    } finally {
      setSaving(null)
      reload()
    }
  }

  const connectHref = githubConnectUrl("/v3/account/connections")
  const connected = me.data?.connected ?? false
  // The #1135 server sends connected_at (null or a time); an older one omits it and has no disconnect.
  const canDisconnect = connected && me.data != null && "connected_at" in me.data
  const now = useLivenessNow()
  const [disconnecting, setDisconnecting] = useState(false)

  return (
    <AccountShell>
      <div>
        <h2 className="font-medium">Connected accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">Services TaskFlow acts on for you.</p>
      </div>

      <section className="mt-5 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-lg bg-muted">
            <GithubMark className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">GitHub</p>
            {me.loading ? (
              <Skeleton className="mt-1 h-4 w-40" />
            ) : me.error ? (
              <p className="text-sm text-destructive">Couldn&apos;t check your GitHub connection.</p>
            ) : connected ? (
              <p className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <CheckIcon className="size-4 shrink-0 text-done" /> {githubStatusLine(me.data!, now)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{githubStatusLine({ connected: false }, now)}</p>
            )}
          </div>
          {!me.loading && !me.error ? (
            canDisconnect ? (
              <Button variant="outline" onClick={() => setDisconnecting(true)}>
                Disconnect
              </Button>
            ) : (
              <Button variant={connected ? "outline" : "default"} render={<a href={connectHref} />} nativeButton={false}>
                {connected ? "Reconnect" : "Connect GitHub"}
              </Button>
            )
          ) : null}
        </div>

        {connected && project && status.data?.project_linked ? (
          <div className="mt-5 flex items-start justify-between gap-4 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium">Post issue comments as me in {project.name}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">When an agent you own logs something for GitHub, it&apos;s posted under your name instead of the TaskFlow app.</p>
            </div>
            <Switch
              checked={status.data.post_as_me}
              disabled={saving !== null}
              onCheckedChange={(v) => void save("post-as-me", () => setGithubPostAsMe(project.id, v === true), v ? "Comments post as you" : "Comments post as the TaskFlow app", status.reload)}
              aria-label={`Post issue comments as me in ${project.name}`}
            />
          </div>
        ) : null}
        <DisconnectDialog
          open={disconnecting}
          onOpenChange={setDisconnecting}
          projects={me.data?.projects_tracking ?? []}
          onDone={() => {
            me.reload()
            status.reload()
          }}
        />
      </section>

      <div className="mt-8">
        <h2 className="font-medium">Defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">Where TaskFlow opens and what it emails.</p>
      </div>
      <section className="mt-5 divide-y divide-border rounded-xl border border-border bg-card">
        {settings.loading ? (
          <Skeleton className="m-5 h-16" />
        ) : settings.error ? (
          <p className="p-5 text-sm text-destructive">Couldn&apos;t load your settings.</p>
        ) : settings.data ? (
          <>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Open this project after logging in</p>
                <p className="mt-0.5 text-sm text-muted-foreground">Otherwise you land on the last one you used.</p>
              </div>
              <Select
                items={{ [NONE]: "Last used", ...Object.fromEntries(projects.map((p) => [p.id, p.name])) }}
                value={settings.data.default_project != null ? String(settings.data.default_project) : NONE}
                onValueChange={(v) => void save("default", () => updateUserSettings({ default_project: !v || v === NONE ? null : Number(v) }), "Saved", settings.reload)}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Default project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Last used</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="text-sm font-medium">Email me notifications</p>
                <p className="mt-0.5 text-sm text-muted-foreground">Only sent if this server has email set up.</p>
              </div>
              <Switch
                checked={settings.data.email_notifications}
                disabled={saving !== null}
                onCheckedChange={(v) => void save("email", () => updateUserSettings({ email_notifications: v === true }), "Saved", settings.reload)}
                aria-label="Email me notifications"
              />
            </div>
          </>
        ) : null}
      </section>
    </AccountShell>
  )
}
