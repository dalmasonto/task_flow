/// Docs index and article, from docs/v3-design/pages/docs.html and
/// docs-article.html, rendering the real guides (see docs-content.ts).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileQuestionIcon, InfoIcon, PlugIcon, SearchIcon, SquareTerminalIcon, TriangleAlertIcon, WindIcon, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

import { ActorAvatar, type ModelId } from "../components/actor-avatar"
import { DOC_SECTIONS, docHeadings, headingId, loadDocs, resolveDocLink, searchDocs, type Doc } from "./docs-content"
import { PublicPage } from "./public-chrome"

const AGENT_TILES: { slug: string; label: string; model?: ModelId; icon?: LucideIcon }[] = [
  { slug: "agents/claude", label: "Claude Code", model: "claude" },
  { slug: "agents/codex", label: "Codex", model: "codex" },
  { slug: "agents/cursor", label: "Cursor", model: "cursor" },
  { slug: "agents/copilot", label: "GitHub Copilot", model: "copilot" },
  { slug: "agents/windsurf", label: "Windsurf", icon: WindIcon },
  { slug: "agents/cline", label: "Cline", icon: PlugIcon },
  { slug: "agents/continue", label: "Continue", icon: PlugIcon },
  { slug: "agents", label: "Every agent", icon: SquareTerminalIcon },
]

const QUICK_START: [string, ReactNode][] = [
  [
    "Install the MCP",
    <pre key="i" className="mt-3 overflow-x-auto rounded-md bg-terminal p-3 font-mono text-xs text-terminal-foreground">
      {"npm i -g @dalmasonto/taskflow-mcp\ntaskflow init"}
    </pre>,
  ],
  ["Link an agent", <p key="l" className="mt-2 text-sm text-muted-foreground">On the Agents page, give it a name and a profile. Its key is shown once.</p>],
  ["Save .taskflow.json", <p key="s" className="mt-2 text-sm text-muted-foreground">At the repo root, kept out of git. One file holds every profile.</p>],
  [
    "Start it in tmux",
    <p key="t" className="mt-2 text-sm text-muted-foreground">
      Then ask it to call <code className="font-mono text-xs text-foreground">whoami</code>. Its terminal streams live.
    </p>,
  ],
]

const href = (d: Pick<Doc, "slug">) => `/v3/docs${d.slug ? `/${d.slug}` : ""}`

function DocsSearch({ docs }: { docs: Doc[] }) {
  const [q, setQ] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const hits = useMemo(() => searchDocs(docs, q), [docs, q])
  // "/" focuses search, as the design's hint says, unless you're already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <div role="search" className="mt-8">
      <InputGroup className="h-12 rounded-xl bg-card">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={input}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search, for example: profiles, tmux, self-hosting"
          aria-label="Search the docs"
          className="text-base"
        />
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      </InputGroup>
      {q.trim() ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          {hits.length ? (
            <ul className="divide-y divide-border">
              {hits.slice(0, 8).map((d) => (
                <li key={d.slug}>
                  <Link to={href(d)} className="block px-4 py-3 hover:bg-accent/50">
                    <span className="text-sm font-medium">{d.title}</span>
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">{d.description || d.section}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">No guide mentions “{q.trim()}”.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function DocsIndexPage() {
  const docs = loadDocs()
  const known = new Set(docs.map((d) => d.slug))
  return (
    <PublicPage active="docs">
      <main id="main" className="mx-auto w-full max-w-6xl px-5 pb-24 pt-14">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight">Documentation</h1>
          <p className="mt-3 text-lg text-muted-foreground">Set up TaskFlow, connect your agents and run it on your own server.</p>
          <DocsSearch docs={docs} />
        </div>

        <section className="mt-16" aria-labelledby="quick">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="quick" className="text-2xl font-semibold tracking-tight">
              Quick start
            </h2>
            <Link to="/v3/docs/getting-started" className="text-sm text-muted-foreground hover:text-foreground">
              Full guide
            </Link>
          </div>
          <ol className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-4">
            {QUICK_START.map(([title, body], i) => (
              <li key={title} className="min-w-0 bg-card p-5">
                <span className="text-sm font-medium text-muted-foreground">{i + 1}</span>
                <h3 className="mt-2 font-medium text-card-foreground">{title}</h3>
                {body}
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16" aria-labelledby="agents">
          <h2 id="agents" className="text-2xl font-semibold tracking-tight">
            Set up your agent
          </h2>
          <p className="mt-2 text-muted-foreground">
            Exact config for each client. <code className="font-mono text-sm text-foreground">taskflow init</code> handles most of it for you.
          </p>
          <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {AGENT_TILES.filter((t) => known.has(t.slug)).map((t) => (
              <li key={t.slug}>
                <Link to={href(t)} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:bg-accent/50">
                  {t.model ? (
                    <ActorAvatar model={t.model} name={t.label} />
                  ) : (
                    <span className="grid size-8 place-items-center rounded-md border border-border bg-card">{t.icon ? <t.icon className="size-4 text-muted-foreground" /> : null}</span>
                  )}
                  <span className="text-sm font-medium">{t.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16 grid grid-cols-1 gap-10 border-t border-border pt-12 sm:grid-cols-2 lg:grid-cols-4" aria-label="Guides">
          {DOC_SECTIONS.map((section) => (
            <div key={section}>
              <h2 className="font-medium">{section}</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {docs
                  .filter((d) => d.section === section)
                  .map((d) => (
                    <li key={d.slug}>
                      <Link to={href(d)} className="text-muted-foreground hover:text-foreground">
                        {d.title}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
      </main>
    </PublicPage>
  )
}

function text(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(text).join("")
  if (children && typeof children === "object" && "props" in children) return text((children as { props: { children?: ReactNode } }).props.children)
  return ""
}

function articleComponents(doc: Doc): Components {
  return {
    h2: ({ children }) => (
      <h2 id={headingId(text(children))} className="scroll-mt-24 pt-4 text-2xl font-semibold tracking-tight">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={headingId(text(children))} className="scroll-mt-24 pt-2 text-lg font-semibold">
        {children}
      </h3>
    ),
    p: ({ children }) => <p>{children}</p>,
    ul: ({ children }) => <ul className="ml-5 list-disc space-y-1.5">{children}</ul>,
    ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1.5">{children}</ol>,
    a: ({ href: to, children }) => {
      const resolved = resolveDocLink(doc.slug, to ?? "", doc.isIndex)
      if (resolved.startsWith("/v3/"))
        return (
          <Link to={resolved} className="font-medium text-link underline-offset-4 hover:underline">
            {children}
          </Link>
        )
      return (
        <a href={resolved} target={resolved.startsWith("#") ? undefined : "_blank"} rel="noreferrer" className="font-medium text-link underline-offset-4 hover:underline">
          {children}
        </a>
      )
    },
    code: ({ className, children }) =>
      className ? <code className={className}>{children}</code> : <code className="rounded bg-muted px-1 font-mono text-sm">{children}</code>,
    pre: ({ children }) => <pre className="overflow-x-auto rounded-xl bg-terminal p-4 font-mono text-sm leading-6 text-terminal-foreground">{children}</pre>,
    blockquote: ({ children }) => {
      // Callouts arrive as a blockquote whose first line is **Note** / **Warning** / **Tip**.
      const warn = /^\s*Warning/.test(text(children))
      const Icon = warn ? TriangleAlertIcon : InfoIcon
      return (
        <div role="note" className={cn("flex gap-3 rounded-xl border p-4 text-sm [&_p:first-child]:font-medium", warn ? "border-blocked/40 bg-blocked/10" : "border-link/30 bg-link/5")}>
          <Icon className={cn("mt-0.5 size-4 shrink-0", warn ? "text-blocked" : "text-link")} />
          <div className="min-w-0 space-y-2">{children}</div>
        </div>
      )
    },
    table: ({ children }) => (
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b border-border bg-muted/50 px-3 py-2 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
  }
}

function DocsNav({ docs, current }: { docs: Doc[]; current: string }) {
  return (
    <nav aria-label="Docs" className="hidden min-w-0 lg:block">
      {DOC_SECTIONS.map((section) => (
        <div key={section} className="mb-6">
          <p className="text-xs font-medium text-muted-foreground">{section}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {docs
              .filter((d) => d.section === section)
              .map((d) => (
                <li key={d.slug}>
                  <Link
                    to={href(d)}
                    aria-current={d.slug === current ? "page" : undefined}
                    className={cn("block rounded-md px-2 py-1", d.slug === current ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {d.title}
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function DocArticlePage() {
  const slug = useParams()["*"]?.replace(/\/$/, "") ?? ""
  const docs = loadDocs()
  const i = docs.findIndex((d) => d.slug === slug)
  const doc = docs[i]
  const headings = useMemo(() => (doc ? docHeadings(doc.body) : []), [doc])
  useEffect(() => {
    // A link to /docs/x#heading lands on the heading once the article renders.
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [slug])

  if (!doc) {
    return (
      <PublicPage active="docs">
        <Empty className="mx-auto my-24 max-w-md rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestionIcon />
            </EmptyMedia>
            <EmptyTitle>There's no guide here</EmptyTitle>
            <EmptyDescription>It may have moved. Search the docs or start from the overview.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<Link to="/v3/docs" />}>
              All docs
            </Button>
          </EmptyContent>
        </Empty>
      </PublicPage>
    )
  }

  const prev = docs[i - 1]
  const next = docs[i + 1]
  return (
    <PublicPage active="docs">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-5 pb-24 pt-10 lg:grid-cols-[14rem_1fr_12rem]">
        <DocsNav docs={docs} current={doc.slug} />
        <main id="main" className="min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link to="/v3/docs" className="hover:text-foreground">
              Docs
            </Link>{" "}
            / {doc.section}
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">{doc.title}</h1>
          {doc.description ? <p className="mt-3 text-lg text-muted-foreground">{doc.description}</p> : null}
          <article className="mt-8 max-w-prose space-y-5 text-base leading-7">
            <Markdown remarkPlugins={[remarkGfm]} components={articleComponents(doc)}>
              {doc.body}
            </Markdown>
          </article>
          <div className="mt-12 flex max-w-prose items-center justify-between gap-4 border-t border-border pt-6 text-sm">
            {prev ? (
              <Link to={href(prev)} className="text-muted-foreground hover:text-foreground">
                Previous: {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link to={href(next)} className="font-medium text-link underline underline-offset-4">
                Next: {next.title}
              </Link>
            ) : null}
          </div>
        </main>
        {headings.length ? (
          <nav aria-label="On this page" className="hidden min-w-0 lg:block">
            <div className="sticky top-24">
              <p className="text-xs font-medium text-muted-foreground">On this page</p>
              <ul className="mt-2 space-y-1.5 text-sm">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className="text-muted-foreground hover:text-foreground">
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        ) : (
          <span className="hidden lg:block" />
        )}
      </div>
    </PublicPage>
  )
}
