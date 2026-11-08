/// Choose which TaskFlow server to sign in to (group 2), from
/// docs/v3-design/pages/server-picker.html. Real: the list is saved on this
/// device, each server is checked live (reachable + latency, or why not), and
/// picking one switches every API call to it (lib/server-choice.ts).
import { useEffect, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { CircleAlertIcon, PlusIcon, ShieldIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { API_BASE_URL, BUILD_API_BASE_URL, clearStoredSession, getStoredUser, hasStoredAuthSession } from "@/lib/auth-api"
import { forgetServer, normalizeServer, probeServer, readSavedServers, saveServer, serverLabel, writeServerChoice, type SavedServer, type ServerProbe } from "@/lib/server-choice"
import { cn } from "@/lib/utils"

import { AuthHeading, AuthLayout } from "./auth-ui"

/// The build's own server, always first. "" means this site's origin.
const DEFAULT_KEY = "__default__"

/// Only the hosted build is "TaskFlow Cloud"; a self-hosted or local build's
/// default is simply this site's own server.
const DEFAULT_IS_CLOUD = /(^|\.)supercodehive\.com$/.test(new URL(BUILD_API_BASE_URL || window.location.origin).hostname)
const DEFAULT_NAME = DEFAULT_IS_CLOUD ? "TaskFlow Cloud" : "This site's server"
const DEFAULT_DETAIL = DEFAULT_IS_CLOUD ? "Hosted by Supercodehive" : `The server ${window.location.host} was built with`

function useProbe(base: string) {
  const [probe, setProbe] = useState<ServerProbe | "checking">("checking")
  useEffect(() => {
    const ctl = new AbortController()
    setProbe("checking")
    probeServer(base, ctl.signal).then(setProbe, () => undefined)
    return () => ctl.abort()
  }, [base])
  return probe
}

function ProbeLine({ base }: { base: string }) {
  const probe = useProbe(base)
  if (probe === "checking")
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3" />
        Checking…
      </span>
    )
  if (probe.ok)
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-running" />
        Reachable, {probe.ms} ms
      </span>
    )
  return (
    <span className="inline-flex items-start gap-1.5 text-destructive">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      {probe.reason}
    </span>
  )
}

function ServerOption({ value, name, detail, base, current, onForget }: { value: string; name: string; detail: string; base: string; current: boolean; onForget?: () => void }) {
  const user = current && hasStoredAuthSession() ? getStoredUser() : null
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
          {current ? <span className="text-muted-foreground">{user ? `Signed in as ${user.username}` : "Not signed in"}</span> : null}
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

function AddServerForm({ onSaved }: { onSaved: (s: SavedServer) => void }) {
  const [url, setUrl] = useState("")
  const [checked, setChecked] = useState<ServerProbe | "checking" | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)

  async function check(raw = url): Promise<string | null> {
    const base = normalizeServer(raw)
    if (!base) {
      setUrlError("Enter an address like https://tasks.example.com or localhost:8000.")
      return null
    }
    setUrlError(null)
    setChecked("checking")
    const probe = await probeServer(base)
    setChecked(probe)
    return probe.ok ? base : null
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get("name") ?? "")
    const base = await check()
    if (!base) return
    saveServer({ name, url: base })
    onSaved({ name: name.trim() || serverLabel(base), url: base })
    setUrl("")
    setChecked(null)
    e.currentTarget.reset()
  }

  return (
    <form onSubmit={submit} noValidate className="rounded-2xl border border-border bg-card p-5">
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="srv-name">Organisation</FieldLabel>
          <Input id="srv-name" name="name" autoComplete="off" placeholder="Acme Robotics" className="h-11 rounded-xl" />
          <FieldDescription>A label for this list. Only you see it.</FieldDescription>
        </Field>
        <Field data-invalid={urlError || (checked && checked !== "checking" && !checked.ok) ? true : undefined}>
          <FieldLabel htmlFor="srv-url">Server address</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="srv-url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://tasks.example.com"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setChecked(null)
              }}
              className="h-11 rounded-xl"
            />
            <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={checked === "checking"} onClick={() => void check()}>
              {checked === "checking" ? <Spinner /> : null}
              Check
            </Button>
          </div>
          {urlError ? (
            <FieldError>{urlError}</FieldError>
          ) : checked && checked !== "checking" ? (
            checked.ok ? (
              <FieldDescription className="text-running">Reachable in {checked.ms} ms. TaskFlow server found.</FieldDescription>
            ) : (
              <FieldError>{checked.reason}</FieldError>
            )
          ) : (
            <FieldDescription>Get this from the organisation's admin. You'll need an account on their server to sign in.</FieldDescription>
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" className="rounded-xl" disabled={checked === "checking"}>
            Save server
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

export function ServerPickerPage() {
  const current = API_BASE_URL === BUILD_API_BASE_URL ? DEFAULT_KEY : API_BASE_URL
  const [saved, setSaved] = useState<SavedServer[]>(() => readSavedServers().filter((s) => s.url !== BUILD_API_BASE_URL))
  const [choice, setChoice] = useState<string>(current)
  const [adding, setAdding] = useState(saved.length === 0)
  const chosenBase = choice === DEFAULT_KEY ? BUILD_API_BASE_URL : choice
  const chosenName = choice === DEFAULT_KEY ? DEFAULT_NAME : (saved.find((s) => s.url === choice)?.name ?? serverLabel(choice))

  function useServer() {
    if (choice !== current) {
      // A session belongs to one server: never send this one's token to another.
      writeServerChoice(choice === DEFAULT_KEY ? null : choice)
      clearStoredSession()
      window.location.assign("/v3/login")
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
        <ServerOption value={DEFAULT_KEY} name={DEFAULT_NAME} detail={DEFAULT_DETAIL} base={BUILD_API_BASE_URL} current={current === DEFAULT_KEY} />
        {saved.map((s) => (
          <ServerOption
            key={s.url}
            value={s.url}
            name={s.name}
            detail="Self-hosted"
            base={s.url}
            current={current === s.url}
            onForget={
              current === s.url
                ? undefined
                : () => {
                    forgetServer(s.url)
                    setSaved(readSavedServers())
                    if (choice === s.url) setChoice(current)
                  }
            }
          />
        ))}
      </RadioGroup>

      <Collapsible open={adding} onOpenChange={setAdding} className="mt-4">
        {adding ? null : (
          <CollapsibleTrigger render={<Button variant="ghost" className="rounded-xl" />}>
            <PlusIcon />
            Add an organisation's server
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <AddServerForm
            onSaved={(s) => {
              setSaved(readSavedServers().filter((x) => x.url !== BUILD_API_BASE_URL))
              setChoice(s.url)
              setAdding(false)
            }}
          />
        </CollapsibleContent>
      </Collapsible>

      <Button size="lg" className="mt-8 h-11 w-full rounded-xl" onClick={useServer}>
        {choice === current ? `Continue to ${chosenName}` : `Switch to ${chosenName}`}
      </Button>
      {choice !== current ? <p className="mt-2 text-center text-xs text-muted-foreground">Switching signs you out of {serverLabel(API_BASE_URL)}.</p> : null}
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
