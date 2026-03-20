'use client'

import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/agent2ui/text/CodeBlock'
import type { MarkdownData } from '@/types'

/**
 * MarkdownBlock - Markdown 渲染组件
 *
 * 使用 react-markdown 渲染 Markdown 内容，支持 GFM
 */

export interface MarkdownBlockProps {
  data: MarkdownData
  className?: string
  variant?: 'chat' | 'report'
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`~!@#$%^&*()+=[\]{}|\\:;"'<>,.?/]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function flattenChildren(children: React.ReactNode): string {
  return Array.isArray(children)
    ? children.map((item) => flattenChildren(item)).join('')
    : typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : children && typeof children === 'object' && 'props' in children
        ? flattenChildren((children as { props?: { children?: React.ReactNode } }).props?.children)
        : ''
}

export interface MarkdownHeadingItem {
  level: number
  text: string
  id: string
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeadingItem[] {
  return markdown
    .split('\n')
    .map((line) => line.match(/^(#{1,4})\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => {
      const text = match[2].trim()
      return {
        level: match[1].length,
        text,
        id: slugifyHeading(text),
      }
    })
}

export function MarkdownBlock({ data, className, variant = 'chat' }: MarkdownBlockProps) {
  const isReport = variant === 'report'
  return (
    <div
      className={clsx(
        'prose prose-invert prose-sm max-w-none',
        isReport
          ? 'prose-headings:tracking-tight prose-p:text-[15px] prose-p:leading-7 prose-li:leading-7 prose-p:max-w-[72ch]'
          : 'prose-p:text-sm prose-p:leading-7 prose-li:text-sm',
        // 标题样式
        'prose-headings:text-text-primary prose-headings:font-semibold',
        'prose-h1:text-2xl prose-h1:mb-6 prose-h1:mt-2',
        'prose-h2:text-xl prose-h2:mb-4 prose-h2:mt-10',
        'prose-h3:text-lg prose-h3:mb-3 prose-h3:mt-7',
        // 段落样式
        'prose-p:text-text-primary prose-p:leading-relaxed prose-p:my-4',
        // 链接样式
        'prose-a:text-primary-500 prose-a:no-underline hover:prose-a:underline',
        // 列表样式
        'prose-ul:my-4 prose-ol:my-4 prose-ul:pl-5 prose-ol:pl-5',
        'prose-li:text-text-primary prose-li:my-1.5',
        // 代码样式
        'prose-code:text-primary-300 prose-code:bg-[rgba(255,255,255,0.06)]',
        'prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded',
        'prose-code:before:content-none prose-code:after:content-none',
        // 引用样式
        'prose-blockquote:border-l-primary-500 prose-blockquote:bg-[rgba(255,255,255,0.035)]',
        'prose-blockquote:text-text-secondary prose-blockquote:not-italic',
        'prose-blockquote:py-3 prose-blockquote:px-5 prose-blockquote:rounded-r-xl prose-blockquote:border-l-4',
        // 表格样式
        'prose-table:my-4',
        'prose-th:text-text-primary prose-th:bg-[rgba(255,255,255,0.05)] prose-th:px-4 prose-th:py-2',
        'prose-td:text-text-primary prose-td:px-4 prose-td:py-2',
        'prose-td:border-border-subtle prose-th:border-border-subtle',
        // 分割线
        'prose-hr:border-border-default prose-hr:my-6',
        // 加粗和斜体
        'prose-strong:text-text-primary prose-strong:font-semibold',
        'prose-em:text-text-secondary',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => {
            const text = flattenChildren(children)
            return (
              <h1
                id={slugifyHeading(text)}
                className={clsx(
                  'scroll-mt-24 border-l-4 border-primary-500 pl-4',
                  isReport && 'pb-2 text-[2rem] leading-tight'
                )}
              >
                {children}
              </h1>
            )
          },
          h2: ({ children }) => {
            const text = flattenChildren(children)
            return (
              <h2
                id={slugifyHeading(text)}
                className={clsx(
                  'scroll-mt-24 border-t border-border-subtle pt-5',
                  isReport && 'rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.035)] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                )}
              >
                {children}
              </h2>
            )
          },
          h3: ({ children }) => {
            const text = flattenChildren(children)
            return (
              <h3
                id={slugifyHeading(text)}
                className={clsx(
                  'scroll-mt-24',
                  isReport && 'text-primary-300'
                )}
              >
                {children}
              </h3>
            )
          },
          h4: ({ children }) => {
            const text = flattenChildren(children)
            return (
              <h4
                id={slugifyHeading(text)}
                className={clsx(
                  'scroll-mt-24',
                  isReport && 'uppercase tracking-[0.08em] text-text-secondary'
                )}
              >
                {children}
              </h4>
            )
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className: codeClassName, children, ...props }) => {
            const language = /language-(\w+)/.exec(codeClassName || '')?.[1] || 'text'
            const code = String(children).replace(/\n$/, '')
            const isInline = !codeClassName
            if (isInline) {
              return (
                <code className={clsx('rounded bg-bg-elevated px-1.5 py-0.5 text-[0.9em] text-primary-400')} {...props}>
                  {children}
                </code>
              )
            }
            return <CodeBlock data={{ code, language }} className="my-4" />
          },
          table: ({ children }) => (
            <div className="my-5 overflow-x-auto rounded-xl border border-border-subtle">
              <table className="min-w-full border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="sticky top-0 z-[1] bg-bg-elevated px-4 py-2 text-left text-sm font-semibold text-text-primary">
              {children}
            </th>
          ),
        }}
      >
        {data.content}
      </ReactMarkdown>
    </div>
  )
}

MarkdownBlock.displayName = 'MarkdownBlock'
