import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
  content: string
  className?: string
  /** Compact mode for activity log entries — tighter spacing, smaller text */
  compact?: boolean
}

export function MarkdownRenderer({ content, className, compact }: MarkdownRendererProps) {
  return (
    <div className={cn(
      'prose prose-sm max-w-none overflow-hidden',
      // Base colors — use theme variables so both light and dark mode work
      'text-foreground',
      'prose-headings:text-foreground',
      'prose-p:text-foreground prose-p:leading-relaxed',
      // Headings
      'prose-headings:font-bold prose-headings:tracking-tight prose-headings:uppercase',
      'prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-xs',
      // Links
      'prose-a:text-secondary prose-a:no-underline hover:prose-a:underline prose-a:break-all',
      // Code — inline
      'prose-code:text-secondary prose-code:bg-accent prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none',
      // Pre / code blocks — overflow scroll to prevent blowout
      'prose-pre:bg-accent prose-pre:border prose-pre:border-border prose-pre:text-foreground prose-pre:overflow-x-auto prose-pre:text-[0.8em]',
      // Blockquotes
      'prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground prose-blockquote:not-italic',
      // Strong / emphasis
      'prose-strong:text-foreground prose-em:text-muted-foreground',
      // Lists
      'prose-li:text-foreground prose-li:marker:text-muted-foreground',
      'prose-ul:list-disc prose-ol:list-decimal',
      '[&_li>p]:my-0',
      // HR
      'prose-hr:border-border',
      // Tables
      '[&_table]:w-full [&_table]:text-sm [&_table]:overflow-x-auto',
      'prose-th:text-left prose-th:text-xs prose-th:uppercase prose-th:tracking-widest prose-th:text-muted-foreground prose-th:border-b prose-th:border-border prose-th:pb-1',
      'prose-td:text-sm prose-td:text-foreground prose-td:border-b prose-td:border-border/50 prose-td:py-1',
      // Images
      'prose-img:rounded-none prose-img:max-w-full',
      // Compact mode — tighter spacing for activity log entries
      compact && [
        'text-xs',
        'prose-p:my-1 prose-p:leading-relaxed',
        'prose-headings:text-xs prose-headings:my-1',
        'prose-ul:my-1 prose-ol:my-1 prose-li:my-0',
        'prose-pre:my-1 prose-pre:text-[11px]',
        'prose-blockquote:my-1',
        'prose-hr:my-2',
        'prose-code:text-[11px]',
      ],
      className
    )}>
      <Markdown remarkPlugins={[remarkGfm]}>
        {content}
      </Markdown>
    </div>
  )
}
