/// "Ask for a decision": a question, its key (suggested from the question),
/// options with an optional recommendation, who rules, and the tasks it blocks.
import { useState, type FormEvent } from "react"
import { PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { askDecision, type Decision } from "./decisions-api"
import { KEY_PATTERN, cleanOptions, keyFromQuestion } from "./decisions-logic"

type Row = { label: string; detail: string; recommended: boolean }
const blank = (): Row => ({ label: "", detail: "", recommended: false })
const ANYONE = "anyone"

export function AskDecisionDialog({
  open,
  onOpenChange,
  project,
  members,
  onAsked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: number
  members: { user: number; name: string }[]
  onAsked: (d: Decision) => void
}) {
  const [question, setQuestion] = useState("")
  const [key, setKey] = useState<string | null>(null)
  const [context, setContext] = useState("")
  const [rows, setRows] = useState<Row[]>([blank(), blank()])
  const [ruler, setRuler] = useState<string>(ANYONE)
  const [tasks, setTasks] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const shownKey = key ?? keyFromQuestion(question)

  const reset = () => {
    setQuestion("")
    setKey(null)
    setContext("")
    setRows([blank(), blank()])
    setRuler(ANYONE)
    setTasks("")
    setError(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const options = cleanOptions(rows)
    const taskIds = [...tasks.matchAll(/\d+/g)].map((m) => Number(m[0]))
    if (!question.trim()) return setError("Write the question.")
    if (!KEY_PATTERN.test(shownKey)) return setError("The key needs 3–60 lowercase letters, digits and dashes, starting with a letter.")
    if (options.length < 2) return setError("Give at least two options.")
    setPending(true)
    setError(null)
    try {
      const d = await askDecision(project, {
        key: shownKey,
        question: question.trim(),
        ...(context.trim() ? { context_markdown: context.trim() } : {}),
        options,
        ...(ruler !== ANYONE ? { ruler_user: Number(ruler) } : {}),
        ...(taskIds.length ? { task_ids: taskIds } : {}),
      })
      reset()
      onAsked(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't ask for the decision.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ask for a decision</DialogTitle>
          <DialogDescription>Tasks it blocks stay blocked until someone rules. Agents can check the ruling by its key.</DialogDescription>
        </DialogHeader>
        <form id="ask-decision" onSubmit={submit} className="space-y-4" noValidate>
          <Field>
            <FieldLabel htmlFor="dq">Question</FieldLabel>
            <Input id="dq" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder="Max delay per agent trigger?" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="dk">Key</FieldLabel>
            <Input id="dk" value={shownKey} onChange={(e) => setKey(e.target.value)} spellCheck={false} className="font-mono text-sm" placeholder="trigger-max-delay" />
            <FieldDescription>What agents ask about. Lowercase, digits and dashes.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="dc">
              Context <span className="font-normal text-muted-foreground">Optional</span>
            </FieldLabel>
            <Textarea id="dc" value={context} onChange={(e) => setContext(e.target.value)} rows={2} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Options</legend>
            {rows.map((r, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Input value={r.label} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
                  <Input value={r.detail} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))} placeholder="Trade-off, in one line (optional)" aria-label={`Option ${i + 1} detail`} className="h-8 text-xs" />
                </div>
                <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={r.recommended} onCheckedChange={(v) => setRows((cur) => cur.map((x, j) => ({ ...x, recommended: j === i ? v === true : false })))} />
                  Recommend
                </label>
                {rows.length > 2 ? (
                  <Button type="button" variant="ghost" size="icon-sm" className="mt-1" aria-label={`Remove option ${i + 1}`} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
                    <XIcon />
                  </Button>
                ) : null}
              </div>
            ))}
            {rows.length < 10 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setRows((cur) => [...cur, blank()])}>
                <PlusIcon />
                Add an option
              </Button>
            ) : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Who rules</FieldLabel>
              <Select items={{ [ANYONE]: "Any member", ...Object.fromEntries(members.map((m) => [String(m.user), m.name])) }} value={ruler} onValueChange={(v) => setRuler(String(v ?? ANYONE))}>
                <SelectTrigger aria-label="Who rules">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANYONE}>Any member</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user} value={String(m.user)}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="dt">
                Blocks tasks <span className="font-normal text-muted-foreground">Optional</span>
              </FieldLabel>
              <Input id="dt" value={tasks} onChange={(e) => setTasks(e.target.value)} placeholder="#720, #766" />
            </Field>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="ask-decision" disabled={pending}>
            {pending ? <Spinner /> : null}
            Ask
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
