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
      'prose prose-sm max-w-none dark:prose-invert',
      // Headings
      'prose-headings:font-bold prose-headings:tracking-tight prose-headings:uppercase',
      // Links
      'prose-a:text-secondary prose-a:no-underline hover:prose-a:underline',
      // Code
      'prose-code:text-secondary prose-code:bg-accent prose-code:px-1.5 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none',
      // Pre / code blocks
      'prose-pre:bg-accent prose-pre:border prose-pre:border-border',
      // Blockquotes
      'prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground',
      // Strong
      'prose-strong:text-foreground',
      // Lists — collapse <p> inside <li> so numbers align with content
      'prose-li:marker:text-muted-foreground',
      '[&_li>p]:my-0',
      // HR
      'prose-hr:border-border',
      // Tables
      'prose-th:text-left prose-th:text-xs prose-th:uppercase prose-th:tracking-widest prose-th:text-muted-foreground',
      'prose-td:text-sm',
      // Images
      'prose-img:rounded-none',
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
