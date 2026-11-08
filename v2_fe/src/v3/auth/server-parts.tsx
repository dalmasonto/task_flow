/// Pieces shared by the server picker (group 2) and server accounts (group 7):
/// a live reachability line per server and the add-a-server form.
import { useEffect, useState, type FormEvent } from "react"
import { CircleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { normalizeServer, probeServer, saveServer, type SavedServer, type ServerProbe } from "@/lib/server-choice"

/// One live check per server row. Rows are keyed by address, so a different
/// server is a different component and starts from "checking" on its own;
/// `attempt` re-runs the check ("Check again").
function useProbe(base: string, attempt: number) {
  const [result, setResult] = useState<{ key: string; probe: ServerProbe } | null>(null)
  const key = `${base}#${attempt}`
  useEffect(() => {
    const ctl = new AbortController()
    probeServer(base, ctl.signal).then((probe) => setResult({ key, probe }), () => undefined)
    return () => ctl.abort()
  }, [base, key])
  return result && result.key === key ? result.probe : "checking"
}

export function ProbeLine({ base, attempt = 0 }: { base: string; attempt?: number }) {
  const probe = useProbe(base, attempt)
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

export function AddServerForm({ onSaved, nameLabel = "Organisation" }: { onSaved: (s: SavedServer) => void; nameLabel?: string }) {
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
    // Keep the element: React releases the event's currentTarget once we await.
    const form = e.currentTarget
    const name = String(new FormData(form).get("name") ?? "")
    const base = await check()
    if (!base) return
    const saved = await saveServer({ name, url: base })
    if (saved) onSaved(saved)
    setUrl("")
    setChecked(null)
    form.reset()
  }

  return (
    <form onSubmit={submit} noValidate className="rounded-2xl border border-border bg-card p-5">
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="srv-name">{nameLabel}</FieldLabel>
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
