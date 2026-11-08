/// Connected accounts (design: account-connections): GitHub, and the defaults
/// TaskFlow uses for you (the project to open after login, email).
///
/// GitHub: the server only says whether you're connected (no login name, and
/// no disconnect route yet: #TSK1134 follow-up), so the card offers Connect
/// or Reconnect. "Post as me" is per project on the server, so it's shown for
/// the active project when that project is linked to a repo.
import { useState } from "react"
import { CheckIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { fetchGithubMe, fetchGithubProjectStatus, fetchUserSettings, githubConnectUrl, setGithubPostAsMe, updateUserSettings } from "@/lib/taskflow-api"

import { GithubMark } from "../auth/auth-ui"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { AccountShell } from "./AccountShell"

const NONE = "none"

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
                <CheckIcon className="size-4 text-done" /> Connected
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not connected. Connect to publish tasks as issues and comment as yourself.</p>
            )}
          </div>
          {!me.loading && !me.error ? (
            <Button variant={connected ? "outline" : "default"} render={<a href={connectHref} />} nativeButton={false}>
              {connected ? "Reconnect" : "Connect GitHub"}
            </Button>
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
