/// #617: the project Toolbox page — shared memories and reusable scripts.
///
/// Two tabs over one list, an entry view with the code READ-ONLY and
/// highlighted, its `requires_env` / params / run stats, who vetted each
/// version, the version history with a diff and a rollback, and the human
/// actions: approve, deprecate, delete.
///
/// The page never runs anything (TaskFlow does not execute scripts) and never
/// edits code in place — a script is written by an agent through the MCP,
/// where the secret scan and the redaction live. What a human does here is
/// decide, read and roll back.

import * as React from "react"
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  HistoryIcon,
  Loader2Icon,
  PackageIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { highlightCode } from "@/lib/shiki-highlighter"
import { cn } from "@/lib/utils"
import {
  deleteToolboxEntry,
  fetchToolboxEntry,
  fetchToolboxIndex,
  fetchToolboxVersion,
  fetchToolboxVersions,
  restoreToolboxVersion,
  setToolboxStatus,
  toolboxBadge,
  type ToolboxEntry,
  type ToolboxIndexEntry,
  type ToolboxKind,
  type ToolboxVersion,
} from "@/lib/toolbox-api"
import { diffSummary, diffText, type DiffLine } from "@/lib/toolbox-diff"

export function ToolboxPage({ projectId }: { projectId: number | null }) {
  const [tab, setTab] = React.useState<ToolboxKind>("memory")
  const [query, setQuery] = React.useState("")
  const [tag, setTag] = React.useState<string | null>(null)
  const [entries, setEntries] = React.useState<ToolboxIndexEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [openName, setOpenName] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (projectId === null) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setEntries(await fetchToolboxIndex(projectId, { kind: tab, tag: tag ?? undefined, query: query.trim() || undefined }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the toolbox.")
    } finally {
      setLoading(false)
    }
  }, [projectId, tab, tag, query])

  // Refetch on tab/filter change. The debounce keeps typing from firing a
  // request per keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => void refresh(), 200)
    return () => clearTimeout(timer)
  }, [refresh])

  // Every tag in play, so the filter is discoverable rather than typed from
  // memory. Collected from the UNFILTERED listing for the active tab.
  const [allTags, setAllTags] = React.useState<string[]>([])
  React.useEffect(() => {
    if (projectId === null) return
    void fetchToolboxIndex(projectId, { kind: tab })
      .then((rows) => setAllTags([...new Set(rows.flatMap((row) => row.tags))].sort()))
      .catch(() => setAllTags([]))
  }, [projectId, tab])

  if (openName && projectId !== null) {
    return (
      <ToolboxEntryView
        projectId={projectId}
        name={openName}
        onBack={() => {
          setOpenName(null)
          void refresh()
        }}
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4 lg:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-4 text-primary" />
          <h1 className="text-lg font-semibold">Toolbox</h1>
          <span className="text-xs text-muted-foreground">
            what agents on this project have already learned and built
          </span>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ToolboxKind)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="memory">Memories</TabsTrigger>
            <TabsTrigger value="script">Scripts</TabsTrigger>
          </TabsList>
          <div className="relative min-w-56 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === "memory" ? "Search memories" : "Search scripts"}
              className="pl-8"
              aria-label="Search the toolbox"
            />
          </div>
        </div>
        {allTags.length ? (
          <div className="flex flex-wrap items-center gap-1">
            {allTags.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTag((current) => (current === value ? null : value))}
                aria-pressed={tag === value}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  tag === value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}

        <TabsContent value={tab} className="mt-2 min-h-0 flex-1">
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm font-medium text-muted-foreground">
                {tab === "memory" ? "No memories yet" : "No scripts yet"}
              </p>
              <p className="text-xs text-muted-foreground/70">
                Agents save {tab === "memory" ? "project facts and gotchas" : "scripts they built and verified"} here through
                the TaskFlow MCP, so the next agent starts ahead.
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              {entries.map((entry) => {
                const badge = toolboxBadge(entry)
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setOpenName(entry.name)}
                    className="grid gap-1 rounded-lg border bg-card p-3 text-left transition hover:border-primary/40 hover:bg-accent/40"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.kind === "script" ? (
                        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="text-sm font-medium">{entry.title}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{entry.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        v{entry.version}
                      </span>
                      {entry.status !== "approved" ? (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            entry.status === "draft"
                              ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {entry.status === "draft" ? "needs approval" : "deprecated"}
                        </span>
                      ) : null}
                      {badge ? (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            badge.tone === "bad"
                              ? "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
                              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
                          )}
                        >
                          {badge.label}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{entry.description}</p>
                    <p className="text-[11px] text-muted-foreground/80">
                      {entry.tags.length ? `${entry.tags.join(" · ")} — ` : ""}
                      by {entry.author_label}
                      {entry.kind === "script" && entry.last_run_at
                        ? ` · ${entry.run_ok_count} ok, ${entry.run_fail_count} failed`
                        : ""}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  )
}

function ToolboxEntryView({ projectId, name, onBack }: { projectId: number; name: string; onBack: () => void }) {
  const [entry, setEntry] = React.useState<ToolboxEntry | null>(null)
  const [versions, setVersions] = React.useState<ToolboxVersion[]>([])
  const [currentVersion, setCurrentVersion] = React.useState(0)
  const [diff, setDiff] = React.useState<{ from: number; to: number; lines: DiffLine[] } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Highlighting is keyed to the code it was produced from, so a stale render
  // for a previous entry can never be shown against the new one — and the
  // effect only ever writes state from a promise, never synchronously.
  const [highlight, setHighlight] = React.useState<{ code: string; html: string } | null>(null)

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const [full, history] = await Promise.all([fetchToolboxEntry(projectId, name), fetchToolboxVersions(projectId, name)])
      setEntry(full)
      setVersions(history.versions)
      setCurrentVersion(history.current_version)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the entry.")
    }
  }, [projectId, name])

  React.useEffect(() => {
    // `load` only writes state from its awaits, so nothing here runs
    // synchronously in the effect body.
    void Promise.resolve().then(load)
  }, [load])

  // Syntax highlighting is a nice-to-have: a failure leaves the plain <pre>.
  const code = entry?.code ?? null
  React.useEffect(() => {
    if (!code) return
    let cancelled = false
    void highlightCode(code, entry?.language ?? "bash")
      .then((html) => {
        if (!cancelled) setHighlight({ code, html })
      })
      // A highlighting failure leaves the plain <pre>, which is not an error
      // worth showing: the code is right there either way.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [code, entry?.language])
  const highlighted = highlight && highlight.code === code ? highlight.html : null

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
      setDiff(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action failed.")
    } finally {
      setBusy(false)
    }
  }

  const showDiff = async (from: number, to: number) => {
    setError(null)
    try {
      const [before, after] = await Promise.all([
        fetchToolboxVersion(projectId, name, from),
        fetchToolboxVersion(projectId, name, to),
      ])
      setDiff({ from, to, lines: diffText(before.code ?? before.body_markdown, after.code ?? after.body_markdown) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the diff.")
    }
  }

  if (!entry) {
    return (
      <section className="flex h-full items-center justify-center p-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 sm:p-4 lg:p-5">
      <header className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Toolbox
        </Button>
        <h1 className="text-lg font-semibold">{entry.title}</h1>
        <span className="font-mono text-xs text-muted-foreground">{entry.name}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">v{entry.version}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            entry.status === "approved"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : entry.status === "draft"
                ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                : "bg-muted text-muted-foreground",
          )}
        >
          {entry.status}
        </span>
      </header>

      <p className="text-sm text-muted-foreground">{entry.description}</p>
      {entry.deprecated_reason ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Deprecated: {entry.deprecated_reason}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {entry.status === "draft" ? (
          <Button size="sm" disabled={busy} onClick={() => void act(() => setToolboxStatus(projectId, name, "approved"))}>
            <CheckCircle2Icon className="size-4" />
            Approve
          </Button>
        ) : null}
        {entry.status !== "deprecated" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt("Why is this no longer to be used?")
              if (!reason?.trim()) return
              void act(() => setToolboxStatus(projectId, name, "deprecated", reason.trim()))
            }}
          >
            <CircleAlertIcon className="size-4" />
            Deprecate
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete "${entry.name}" and its version history? This cannot be undone.`)) return
            // Not through `act`: that reloads the entry afterwards, and the
            // entry is gone — the reload would 404 on the way back.
            void (async () => {
              setBusy(true)
              setError(null)
              try {
                await deleteToolboxEntry(projectId, name)
                onBack()
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not delete the entry.")
                setBusy(false)
              }
            })()
          }}
        >
          <Trash2Icon className="size-4" />
          Delete
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {entry.kind === "memory" ? (
        <article className="whitespace-pre-wrap rounded-lg border bg-card p-3 text-sm leading-6">
          {entry.body_markdown || "No text saved."}
        </article>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 text-xs sm:grid-cols-2">
            <div>
              <p className="font-medium">Run stats</p>
              <p className="text-muted-foreground">
                {entry.last_run_at
                  ? `last run ${entry.last_run_ok ? "worked" : "FAILED"} · ${entry.run_ok_count} ok, ${entry.run_fail_count} failed`
                  : "never run (agents report runs with toolbox_report_run)"}
              </p>
            </div>
            <div>
              <p className="font-medium">Environment (names only)</p>
              <p className="text-muted-foreground">
                {entry.requires_env.length ? entry.requires_env.join(", ") : "none declared"}
              </p>
            </div>
            {entry.params.length ? (
              <div className="sm:col-span-2">
                <p className="font-medium">Parameters</p>
                <ul className="text-muted-foreground">
                  {entry.params.map((param) => (
                    <li key={param.name}>
                      <span className="font-mono">{param.name}</span>
                      {param.required ? " (required)" : ""}
                      {param.description ? ` — ${param.description}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {entry.body_markdown ? (
            <article className="whitespace-pre-wrap rounded-lg border bg-card p-3 text-sm leading-6">{entry.body_markdown}</article>
          ) : null}
          <div className="min-h-0 rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
              <span className="font-mono">{entry.entrypoint ?? entry.name}</span>
              <span>read-only — agents write code through the MCP, where secrets are refused</span>
            </div>
            {highlighted ? (
              <div
                className="scrollbar-y max-h-96 overflow-auto p-3 text-xs [&_pre]:!bg-transparent"
                // Shiki output is generated locally from the code text.
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            ) : (
              <pre className="scrollbar-y max-h-96 overflow-auto p-3 text-xs leading-5">{code}</pre>
            )}
          </div>
        </>
      )}

      <section className="grid gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4 text-muted-foreground" />
          Versions
        </h2>
        <div className="grid gap-1">
          {/* The CURRENT version first — it has no snapshot row of its own
              (the entry row IS it), but the history reads wrong without it:
              you could not see what is live, nor diff "what this replaced"
              against it. Each history row's Diff pairs it with the row ABOVE
              it, which is the version that replaced it. */}
          {[
            {
              version: currentVersion,
              author_label: entry.author_label,
              note: null,
              vetted_by: null,
              created_at: entry.updated_at,
              current: true,
            },
            ...versions.map((version) => ({ ...version, current: false })),
          ].map((row, index, rows) => {
            const replacer = index === 0 ? null : rows[index - 1]
            return (
              <div key={row.version} className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs">
                <span className="font-mono">v{row.version}</span>
                {row.current ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">current</span>
                ) : null}
                <span className="text-muted-foreground">{row.author_label}</span>
                {row.note ? <span className="text-muted-foreground">— {row.note}</span> : null}
                {row.vetted_by ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    vetted by {row.vetted_by}
                  </span>
                ) : null}
                <span className="ml-auto flex items-center gap-1">
                  {replacer ? (
                    <Button variant="ghost" size="sm" onClick={() => void showDiff(row.version, replacer.version)}>
                      Diff
                    </Button>
                  ) : null}
                  {!row.current ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act(() => restoreToolboxVersion(projectId, name, row.version))}
                    >
                      Restore
                    </Button>
                  ) : null}
                </span>
              </div>
            )
          })}
          {versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No earlier versions — every update is kept here, and rolling back is a new version.
            </p>
          ) : null}
        </div>
      </section>

      {diff ? (
        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">
              v{diff.from} → v{diff.to}
              <span className="ml-2 text-xs text-muted-foreground">
                +{diffSummary(diff.lines).added} −{diffSummary(diff.lines).removed}
              </span>
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setDiff(null)}>
              Close diff
            </Button>
          </div>
          <pre className="scrollbar-y max-h-96 overflow-auto rounded-lg border bg-card p-3 text-xs leading-5">
            {diff.lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  line.kind === "add" && "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
                  line.kind === "remove" && "bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} {line.text}
              </div>
            ))}
          </pre>
        </section>
      ) : null}
    </section>
  )
}
