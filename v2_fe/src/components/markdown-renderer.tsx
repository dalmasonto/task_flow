import { useContext, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { splitTaskRefs } from "@/lib/task-refs"
import { TaskChipContext, GithubRepoContext } from "@/lib/markdown-contexts"

/// Remark plugin: rewrite `TASK#<n>` inside text nodes into link nodes with a
/// `#task-<n>` fragment url (which the URL sanitizer allows), so the `a`
/// component below can render them as chips. Skips text inside existing links
/// (no nested links) and never touches `inlineCode` / `code` — those are their
/// own node types, so a TASK#n written in backticks stays literal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkTaskChips() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any): void => {
    if (!node || !Array.isArray(node.children) || node.type === "link") return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next: any[] = []
    for (const child of node.children) {
      if (child.type === "text") {
        const segments = splitTaskRefs(child.value as string)
        if (segments.length === 1 && segments[0].type === "text") {
          next.push(child)
          continue
        }
        for (const segment of segments) {
          if (segment.type === "text") {
            next.push({ type: "text", value: segment.value })
          } else {
            next.push({
              type: "link",
              url:
                segment.type === "github"
                  ? `#gh-issue-${segment.issue}`
                  : `#task-${segment.id}`,
              children: [{ type: "text", value: segment.raw }],
            })
          }
        }
      } else {
        visit(child)
        next.push(child)
      }
    }
    node.children = next
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => visit(tree)
}

/// One `TASK#<n>` chip. Clickable when an opener is in context; inert otherwise.
function TaskChip({ taskId, children }: { taskId: number; children?: ReactNode }) {
  const onOpenTask = useContext(TaskChipContext)
  const chipClass =
    "inline-flex items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 align-baseline text-[0.82em] font-medium text-primary ring-1 ring-primary/25"
  if (!onOpenTask) return <span className={chipClass}>{children}</span>
  return (
    <button
      type="button"
      onClick={() => onOpenTask(taskId)}
      className={cn(chipClass, "cursor-pointer transition hover:bg-primary/20")}
      title={`Open task #${taskId}`}
    >
      {children}
    </button>
  )
}

/// One `#gh<n>` chip. Deliberately styled unlike the task chip — telling the two
/// apart at a glance is the entire point of #54. Links out when the project has a
/// repo; otherwise inert with a reason, never a dead click.
function GithubIssueChip({ issue, children }: { issue: number; children?: ReactNode }) {
  const repo = useContext(GithubRepoContext)
  const chipClass =
    "inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 align-baseline text-[0.82em] font-medium text-muted-foreground ring-1 ring-border"
  if (!repo) {
    return (
      <span className={chipClass} title="Link a GitHub repo in project settings to open issues">
        {children}
      </span>
    )
  }
  return (
    <a
      href={`https://github.com/${repo}/issues/${issue}`}
      target="_blank"
      rel="noreferrer"
      className={cn(chipClass, "cursor-pointer transition hover:bg-muted/70 hover:text-foreground")}
      title={`Open ${repo} issue #${issue} on GitHub`}
    >
      {children}
    </a>
  )
}

type MarkdownRendererProps = {
  content: string
  compact?: boolean
  tone?: "default" | "inverse"
  className?: string
}

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="break-words text-lg font-semibold leading-7">{children}</h1>,
  h2: ({ children }) => <h2 className="break-words text-base font-semibold leading-6">{children}</h2>,
  h3: ({ children }) => <h3 className="break-words text-sm font-semibold leading-5">{children}</h3>,
  p: ({ children }) => <p className="break-words leading-6 text-muted-foreground">{children}</p>,
  ul: ({ children }) => <ul className="ml-4 list-disc space-y-1 text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="break-words pl-1 leading-6">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="rounded-lg border bg-muted/45 px-3 py-2 text-sm text-muted-foreground [&_p]:text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => {
    const taskMatch = /^#task-(\d+)$/.exec(href ?? "")
    if (taskMatch) return <TaskChip taskId={Number(taskMatch[1])}>{children}</TaskChip>
    const issueMatch = /^#gh-issue-(\d+)$/.exec(href ?? "")
    if (issueMatch) return <GithubIssueChip issue={Number(issueMatch[1])}>{children}</GithubIssueChip>
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-words font-medium text-primary underline-offset-4 hover:underline"
      >
        {children}
      </a>
    )
  },
  code: ({ children, className }) => (
    <code className={cn("rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground", className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="scrollbar-y max-w-full overflow-x-auto rounded-lg border bg-muted/70 p-3 text-xs leading-5 text-foreground [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="scrollbar-y max-w-full overflow-x-auto rounded-lg border">
      <table className="w-full min-w-96 border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b bg-muted/60 px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b px-2 py-1.5 text-muted-foreground">{children}</td>,
  input: (props) => (
    <input
      {...props}
      disabled
      className="mr-2 size-3.5 rounded border-border align-middle accent-primary"
    />
  ),
  img: ({ alt, src }) => (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center rounded-md border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      Image: {alt || src || "attachment"}
    </a>
  ),
  hr: () => <hr className="border-border" />,
}

export function MarkdownRenderer({ content, compact, tone = "default", className }: MarkdownRendererProps) {
  return (
    <div
      className={cn(
        "max-w-full space-y-3 overflow-hidden text-sm text-foreground [overflow-wrap:anywhere]",
        compact &&
          "space-y-1.5 text-xs [&_h1]:text-sm [&_h1]:leading-5 [&_h2]:text-sm [&_h2]:leading-5 [&_h3]:text-xs [&_li]:leading-5 [&_p]:leading-5 [&_pre]:text-[0.72rem] [&_table]:text-xs",
        tone === "inverse" &&
          [
            "text-primary-foreground",
            "[&_a]:text-primary-foreground [&_a]:decoration-primary-foreground/60",
            "[&_blockquote]:border-primary-foreground/20 [&_blockquote]:bg-primary-foreground/10 [&_blockquote]:text-primary-foreground/85",
            "[&_blockquote_p]:text-primary-foreground/85",
            "[&_code]:bg-primary-foreground/15 [&_code]:text-primary-foreground",
            "[&_li]:text-primary-foreground/90 [&_ol]:text-primary-foreground/90 [&_p]:text-primary-foreground/90 [&_ul]:text-primary-foreground/90",
            "[&_pre]:border-primary-foreground/15 [&_pre]:bg-primary-foreground/10 [&_td]:text-primary-foreground/85 [&_th]:text-primary-foreground/85",
          ],
        className
      )}
    >
      <Markdown remarkPlugins={[remarkGfm, remarkTaskChips]} components={markdownComponents} skipHtml>
        {content}
      </Markdown>
    </div>
  )
}
