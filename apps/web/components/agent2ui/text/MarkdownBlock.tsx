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
  onEvidenceClick?: (href: string, label: string) => void
}

function stripInjectedDocumentBlocks(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/\[DOCUMENT_CONTEXT_BEGIN\][\s\S]*?\[DOCUMENT_CONTEXT_END\]\s*/gi, '')
    .replace(/\[DOCUMENT_CHUNK_EXPANSION_BEGIN\][\s\S]*?\[DOCUMENT_CHUNK_EXPANSION_END\]\s*/gi, '')
    .trim()
}

function renderChunkEvidenceLinks(text: string): string {
  if (!text) return ''
  let rendered = stripInjectedDocumentBlocks(text)
  const citationOrder = new Map<string, number>()
  const getCitationNumber = (signature: string): number => {
    const existing = citationOrder.get(signature)
    if (existing) return existing
    const next = citationOrder.size + 1
    citationOrder.set(signature, next)
    return next
  }

  rendered = rendered.replace(/\[doc:([A-Za-z0-9_-]+)\s+chunk:(c\d{3,})\]/gi, (_match, docId, chunkId) => {
    const safeDocId = encodeURIComponent(String(docId).trim())
    const safeChunkId = encodeURIComponent(String(chunkId).trim().toLowerCase())
    const labelNumber = getCitationNumber(`doc:${String(docId).trim()}:chunk:${String(chunkId).trim().toLowerCase()}`)
    return `[[${labelNumber}]](/__semibot_evidence__?doc_id=${safeDocId}&chunk_id=${safeChunkId})`
  })
  rendered = rendered.replace(/\[chunk:([^\]]+)\]/gi, (_match, body) => {
    const chunkIds = String(body)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^c\d{3,}$/i.test(item))
    if (chunkIds.length === 0) return _match
    const labelNumber = getCitationNumber(`chunk:${chunkIds.join(',')}`)
    return `[[${labelNumber}]](/__semibot_evidence__?chunk_ids=${encodeURIComponent(chunkIds.join(','))})`
  })
  return rendered
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

const RESULT_META_PREFIX_RE = /^(摘要|总结|来源|链接|发布时间|作者|机构|要点)\s*[：:]/

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

function isResultMetaParagraph(text: string): boolean {
  return RESULT_META_PREFIX_RE.test(text.trim())
}

export function MarkdownBlock({ data, className, variant = 'chat', onEvidenceClick }: MarkdownBlockProps) {
  const isReport = variant === 'report'
  const renderedContent = renderChunkEvidenceLinks(data.content)
  return (
    <div
      className={clsx(
        'prose prose-invert prose-sm max-w-none overflow-x-hidden [overflow-wrap:anywhere]',
        '[&_p]:break-words [&_li]:break-words [&_td]:break-words [&_th]:break-words',
        isReport
          ? 'prose-headings:tracking-tight prose-p:text-[15px] prose-p:leading-7 prose-li:leading-7 prose-p:max-w-[72ch]'
          : 'prose-p:text-[15px] prose-p:leading-8 prose-li:text-[15px] prose-li:leading-8 prose-p:max-w-[66ch] prose-li:max-w-[66ch]',
        // 标题样式
        'prose-headings:text-text-primary prose-headings:font-semibold',
        'prose-h1:text-2xl prose-h1:mb-6 prose-h1:mt-2',
        'prose-h2:text-xl prose-h2:mb-4 prose-h2:mt-10',
        'prose-h3:text-lg prose-h3:mb-3 prose-h3:mt-7',
        // 段落样式
        'prose-p:text-text-primary prose-p:leading-relaxed prose-p:my-4',
        // 链接样式
        'prose-a:font-medium prose-a:text-primary-400 prose-a:no-underline hover:prose-a:text-primary-300 hover:prose-a:underline',
        // 列表样式
        'prose-ul:my-4 prose-ol:my-5 prose-ul:pl-5 prose-ol:pl-0',
        'prose-li:text-text-primary prose-li:my-1.5 marker:text-text-tertiary',
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
        !isReport &&
          [
            '[&_.chat-markdown-ol>li]:relative',
            '[&_.chat-markdown-ol>li]:my-4',
            '[&_.chat-markdown-ol>li]:list-none',
            '[&_.chat-markdown-ol>li]:rounded-2xl',
            '[&_.chat-markdown-ol>li]:border',
            '[&_.chat-markdown-ol>li]:border-border-subtle',
            '[&_.chat-markdown-ol>li]:bg-[rgba(255,255,255,0.02)]',
            '[&_.chat-markdown-ol>li]:px-4',
            '[&_.chat-markdown-ol>li]:py-3',
            '[&_.chat-markdown-ol>li]:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
            '[&_.chat-markdown-ol>li>p:first-of-type]:mt-0',
            '[&_.chat-markdown-ol>li>p:first-of-type]:mb-2',
            '[&_.chat-markdown-ol>li>p:first-of-type]:text-[15px]',
            '[&_.chat-markdown-ol>li>p:first-of-type]:font-semibold',
            '[&_.chat-markdown-ol>li>p:first-of-type]:text-text-primary',
            '[&_.chat-markdown-ol>li>p:not(:first-of-type)]:text-sm',
            '[&_.chat-markdown-ol>li>p:not(:first-of-type)]:leading-7',
            '[&_.chat-markdown-ol>li>p:not(:first-of-type)]:text-text-secondary',
          ],
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
                  'scroll-mt-24',
                  isReport
                    ? 'pb-1 text-[1.75rem] font-semibold leading-[1.2] tracking-tight text-text-primary'
                    : 'text-[1.85rem] font-semibold leading-[1.2] tracking-tight text-text-primary'
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
                  'scroll-mt-24 pt-5',
                  isReport
                    ? 'border-t border-border-subtle/70 px-0 pb-0 text-[1.12rem] font-semibold tracking-[0.01em] text-text-primary'
                    : 'border-t border-border-subtle/80 text-[1.05rem] tracking-[0.01em] text-text-primary/95',
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
          a: ({ href, children }) => {
            const label = flattenChildren(children)
            if (href?.startsWith('/__semibot_evidence__')) {
              return (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const normalizedHref = href.replace('/__semibot_evidence__', 'semibot-evidence://chunk')
                    onEvidenceClick?.(normalizedHref, label)
                  }}
                  className="inline appearance-none border-0 bg-transparent p-0 align-baseline text-[0.92em] text-primary-300 underline underline-offset-2 shadow-none outline-none transition-colors hover:text-primary-200 focus-visible:text-primary-200"
                >
                  {children}
                </button>
              )
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          },
          p: ({ children }) => {
            const text = flattenChildren(children)
            return (
              <p
                className={clsx(
                  !isReport && 'text-text-primary/92',
                  !isReport && isResultMetaParagraph(text) && 'text-sm leading-7 text-text-secondary'
                )}
              >
                {children}
              </p>
            )
          },
          ol: ({ children }) => (
            <ol
              className={clsx(
                'my-5',
                isReport ? 'pl-5' : 'chat-markdown-ol list-none space-y-1 pl-0'
              )}
            >
              {children}
            </ol>
          ),
          ul: ({ children }) => (
            <ul className={clsx('my-4 pl-5', !isReport && 'space-y-2')}>
              {children}
            </ul>
          ),
          li: ({ children }) => (
            <li className={clsx(!isReport && 'text-text-primary/95')}>
              {children}
            </li>
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
        {renderedContent}
      </ReactMarkdown>
    </div>
  )
}

MarkdownBlock.displayName = 'MarkdownBlock'
