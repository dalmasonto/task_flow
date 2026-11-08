/// Choose which TaskFlow server to sign in to (group 2), from
/// docs/v3-design/pages/server-picker.html. Real: the list is saved on this
/// device, each server is checked live (reachable + latency, or why not), and
/// picking one switches every API call to it (lib/server-choice.ts).
import { useState } from "react"
import { Link } from "react-router-dom"
import { PlusIcon, ShieldIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { API_BASE_URL, BUILD_API_BASE_URL, getStoredUser, hasStoredAuthSession } from "@/lib/auth-api"
import { keptSessions, switchServer } from "@/lib/server-switch"
import { useLiveQuery } from "dexie-react-hooks"
import { forgetServer, listSavedServers, serverLabel } from "@/lib/server-choice"
import { cn } from "@/lib/utils"

import { AuthHeading, AuthLayout } from "./auth-ui"
import { DEFAULT_DETAIL, DEFAULT_KEY, DEFAULT_NAME } from "./server-defaults"
import { AddServerForm, ProbeLine } from "./server-parts"

function ServerOption({
  value,
  name,
  detail,
  base,
  current,
  keptUser,
  onForget,
}: {
  value: string
  name: string
  detail: string
  base: string
  current: boolean
  /// Who you're signed in as on this server, from a kept session (non-current servers).
  keptUser?: string
  onForget?: () => void
}) {
  const signedInAs = current ? (hasStoredAuthSession() ? getStoredUser()?.username : undefined) : keptUser
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 has-[[data-checked]]:border-ring has-[[data-checked]]:ring-2 has-[[data-checked]]:ring-ring/20",
      )}
    >
      <RadioGroupItem value={value} className="mt-1" />
      <span className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          {value === DEFAULT_KEY ? <Badge variant="secondary">Default</Badge> : null}
          {current ? <Badge variant="outline">In use</Badge> : null}
        </span>
        <span className="block text-muted-foreground">{detail}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{base || window.location.origin}</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <ProbeLine base={base} />
          <span className="text-muted-foreground">{signedInAs ? `Signed in as ${signedInAs}` : "Not signed in"}</span>
        </span>
      </span>
      {onForget ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Forget ${name}`}
          onClick={(e) => {
            e.preventDefault()
            onForget()
          }}
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </label>
  )
}

export function ServerPickerPage() {
  const current = API_BASE_URL === BUILD_API_BASE_URL ? DEFAULT_KEY : API_BASE_URL
  // Live from IndexedDB: adding or forgetting a server re-renders the list.
  const savedRows = useLiveQuery(listSavedServers, [], undefined)
  const kept = useLiveQuery(keptSessions, [], {} as Record<string, { username: string }>)
  const saved = (savedRows ?? []).filter((s) => s.url !== BUILD_API_BASE_URL)
  const [choice, setChoice] = useState<string>(current)
  const [adding, setAdding] = useState<boolean | null>(null)
  // Open the add form by default only when nothing is saved yet (once the list has loaded).
  const showAdd = adding ?? (savedRows !== undefined && saved.length === 0)
  const chosenBase = choice === DEFAULT_KEY ? BUILD_API_BASE_URL : choice
  const chosenName = choice === DEFAULT_KEY ? DEFAULT_NAME : (saved.find((s) => s.url === choice)?.name ?? serverLabel(choice))

  async function switchToChosen() {
    if (choice !== current) {
      // Keeps this server's session and restores the target's, if you were
      // signed in there before (lib/server-switch.ts). Tokens never cross servers.
      const target = choice === DEFAULT_KEY ? BUILD_API_BASE_URL : choice
      window.location.assign(await switchServer(target, BUILD_API_BASE_URL))
      return
    }
    window.location.assign(hasStoredAuthSession() ? "/v3/board" : "/v3/login")
  }

  return (
    <AuthLayout>
      <AuthHeading
        title="Choose a server"
        subtitle="Each server is its own TaskFlow, with its own accounts and projects. Pick the one your organisation runs, or add its address."
      />
      <p className="mt-4 flex gap-2 rounded-xl bg-muted px-3 py-2.5 text-sm text-muted-foreground">
        <ShieldIcon className="mt-0.5 size-4 shrink-0" />
        Your data lives only on the server you sign in to. An account on one doesn't exist on another. This list is saved on this device only.
      </p>

      <RadioGroup value={choice} onValueChange={(v) => setChoice(String(v))} aria-label="Saved servers" className="mt-6 gap-3">
        <ServerOption
          value={DEFAULT_KEY}
          name={DEFAULT_NAME}
          detail={DEFAULT_DETAIL}
          base={BUILD_API_BASE_URL}
          current={current === DEFAULT_KEY}
          keptUser={kept[BUILD_API_BASE_URL]?.username}
        />
        {saved.map((s) => (
          <ServerOption
            key={s.url}
            value={s.url}
            name={s.name}
            detail="Self-hosted"
            base={s.url}
            current={current === s.url}
            keptUser={kept[s.url]?.username}
            onForget={
              current === s.url
                ? undefined
                : () => {
                    void forgetServer(s.url)
                    if (choice === s.url) setChoice(current)
                  }
            }
          />
        ))}
      </RadioGroup>

      <Collapsible open={showAdd} onOpenChange={setAdding} className="mt-4">
        {showAdd ? null : (
          <CollapsibleTrigger render={<Button variant="ghost" className="rounded-xl" />}>
            <PlusIcon />
            Add an organisation's server
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <AddServerForm
            onSaved={(s) => {
              setChoice(s.url)
              setAdding(false)
            }}
          />
        </CollapsibleContent>
      </Collapsible>

      <Button size="lg" className="mt-8 h-11 w-full rounded-xl" onClick={() => void switchToChosen()}>
        {choice === current ? `Continue to ${chosenName}` : `Switch to ${chosenName}`}
      </Button>
      {choice !== current ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {kept[choice === DEFAULT_KEY ? BUILD_API_BASE_URL : choice] ? "You're still signed in there." : "You'll sign in there next."} Your session on{" "}
          {serverLabel(API_BASE_URL)} is kept for when you come back.
        </p>
      ) : null}
      <p className="mt-6 text-sm text-muted-foreground">
        Running TaskFlow for your own organisation? Add your server's address, for example <code className="font-mono text-xs">http://localhost:8000</code>. Nothing needs
        rebuilding.{" "}
        <Link to="/v3/docs/self-hosting" className="font-medium text-link underline-offset-4 hover:underline">
          Self-hosting guide
        </Link>
      </p>
      <span className="sr-only" aria-live="polite">
        {chosenBase ? `Selected ${chosenName}` : ""}
      </span>
    </AuthLayout>
  )
}
