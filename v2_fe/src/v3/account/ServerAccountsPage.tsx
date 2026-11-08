/// Servers and accounts (design: server-accounts). Stay signed in on more
/// than one TaskFlow server and switch between them. Everything here is this
/// device's: the saved list and the kept sessions live in IndexedDB, and a
/// token is only ever sent to the server that issued it (lib/server-switch).
/// Switching reloads the app against the other server.
import { useState } from "react"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { API_BASE_URL, BUILD_API_BASE_URL, getStoredUser, hasStoredAuthSession } from "@/lib/auth-api"
import { forgetServer, listSavedServers, saveServer, serverLabel } from "@/lib/server-choice"
import { forgetKeptSession, keptSessions, switchServer } from "@/lib/server-switch"

import { DEFAULT_DETAIL, DEFAULT_NAME } from "../auth/server-defaults"
import { AddServerForm, ProbeLine } from "../auth/server-parts"
import { CopyBlock } from "../components/copy-block"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"

type Row = { url: string; name: string; detail: string; isDefault: boolean }

function ServerRow({ row, current, keptUser, projects, onLogoutCurrent }: { row: Row; current: boolean; keptUser?: string; projects?: number; onLogoutCurrent: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(row.name)
  const signedInAs = current ? (hasStoredAuthSession() ? getStoredUser()?.username : undefined) : keptUser

  const rename = async () => {
    const saved = await saveServer({ name: name.trim() || serverLabel(row.url), url: row.url })
    setRenaming(false)
    if (saved) toast.success("Renamed")
  }

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void rename()
              }}
            >
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="h-8 max-w-60" aria-label="Server name" />
              <Button type="submit" size="sm">
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {row.name}
              {current ? <Badge variant="secondary">You&apos;re here</Badge> : null}
            </p>
          )}
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{row.url || window.location.origin}</p>
          <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <ProbeLine base={row.url} attempt={attempt} />
            <span className="text-muted-foreground">
              {signedInAs ? `Signed in as ${signedInAs}` : "Not signed in"}
              {current && signedInAs && projects != null ? `, ${projects} ${projects === 1 ? "project" : "projects"}` : ""}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!current ? (
            <Button size="sm" onClick={() => void switchServer(row.url, BUILD_API_BASE_URL).then((to) => window.location.assign(to))}>
              Switch to {row.name}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setAttempt((a) => a + 1)}>
            Check again
          </Button>
          {!row.isDefault && !renaming ? (
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
              Rename
            </Button>
          ) : null}
          {signedInAs ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (current) onLogoutCurrent()
                else void forgetKeptSession(row.url).then(() => toast.success(`Signed out of ${row.name}`))
              }}
            >
              Sign out
            </Button>
          ) : null}
          {!row.isDefault && !current ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() =>
                void forgetKeptSession(row.url)
                  .then(() => forgetServer(row.url))
                  .then(() => toast.success(`Removed ${row.name}`))
              }
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export function ServerAccountsPage() {
  const { projects, logout } = useWorkspace()
  const savedRows = useLiveQuery(listSavedServers, [], undefined)
  const kept = useLiveQuery(keptSessions, [], {} as Record<string, { username: string }>)
  const [adding, setAdding] = useState(false)
  const rows: Row[] = [
    { url: BUILD_API_BASE_URL, name: DEFAULT_NAME, detail: DEFAULT_DETAIL, isDefault: true },
    ...(savedRows ?? []).filter((s) => s.url !== BUILD_API_BASE_URL).map((s) => ({ url: s.url, name: s.name, detail: "Self-hosted", isDefault: false })),
  ]
  const here = API_BASE_URL || window.location.origin

  return (
    <V3Shell
      title="Servers"
      actions={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add a server
        </Button>
      }
    >
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">Servers and accounts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stay signed in on more than one TaskFlow server and switch between them. Switching reloads the app against the other server. This list is saved on this device only.
          </p>
          <ul className="mt-5 space-y-3">
            {rows.map((r) => (
              <ServerRow key={r.url || "default"} row={r} current={r.url === API_BASE_URL} keptUser={kept[r.url]?.username} projects={projects.length} onLogoutCurrent={() => void logout()} />
            ))}
          </ul>
          <Collapsible open={adding} onOpenChange={setAdding} className="mt-4">
            {adding ? null : (
              <CollapsibleTrigger render={<Button variant="ghost" />}>
                <PlusIcon />
                Add a server
              </CollapsibleTrigger>
            )}
            <CollapsibleContent>
              <AddServerForm
                nameLabel="Name"
                onSaved={(s) => {
                  setAdding(false)
                  toast.success(`Saved ${s.name}`, { description: "Switch to it to sign in there." })
                }}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
        <aside className="min-w-0 space-y-4">
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">Point your agents at the same server</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Agents read the server from the repo&apos;s <code className="font-mono">.taskflow.json</code>, so they follow the server you set there, not this page.
            </p>
            <div className="mt-3">
              <CopyBlock label=".taskflow.json" text={`"server": "${here}"`} />
            </div>
          </section>
        </aside>
      </div>
    </V3Shell>
  )
}
