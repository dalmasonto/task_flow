import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
  content: string
  className?: string
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('prose prose-invert prose-sm max-w-none', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ children, className: codeClassName, ...props }) => {
            const isInline = !codeClassName
            return isInline ? (
              <code className="bg-accent px-2 py-0.5 text-secondary text-sm" {...props}>{children}</code>
            ) : (
              <code className={codeClassName} {...props}>{children}</code>
            )
          },
          a: ({ children, ...props }) => (
            <a className="text-secondary hover:text-secondary/80 underline" {...props}>{children}</a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
