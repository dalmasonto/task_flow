import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

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
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-words font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  ),
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
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {content}
      </Markdown>
    </div>
  )
}
