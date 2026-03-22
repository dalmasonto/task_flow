import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
  content: string
  className?: string
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
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
      // Lists
      'prose-li:marker:text-muted-foreground',
      // HR
      'prose-hr:border-border',
      // Tables
      'prose-th:text-left prose-th:text-xs prose-th:uppercase prose-th:tracking-widest prose-th:text-muted-foreground',
      'prose-td:text-sm',
      // Images
      'prose-img:rounded-none',
      className
    )}>
      <Markdown remarkPlugins={[remarkGfm]}>
        {content}
      </Markdown>
    </div>
  )
}
