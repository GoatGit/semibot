'use client'

import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MarkdownData } from '@/types'

/**
 * MarkdownBlock - Markdown 渲染组件
 *
 * 使用 react-markdown 渲染 Markdown 内容，支持 GFM
 */

export interface MarkdownBlockProps {
  data: MarkdownData
  className?: string
}

export function MarkdownBlock({ data, className }: MarkdownBlockProps) {
  return (
    <div
      className={clsx(
        'prose prose-invert prose-sm max-w-none',
        // 标题样式
        'prose-headings:text-text-primary prose-headings:font-semibold',
        'prose-h1:text-2xl prose-h1:mb-4 prose-h1:mt-6',
        'prose-h2:text-xl prose-h2:mb-3 prose-h2:mt-5',
        'prose-h3:text-lg prose-h3:mb-2 prose-h3:mt-4',
        // 段落样式
        'prose-p:text-text-primary prose-p:leading-relaxed prose-p:my-3',
        // 链接样式
        'prose-a:text-primary-500 prose-a:no-underline hover:prose-a:underline',
        // 列表样式
        'prose-ul:my-3 prose-ol:my-3',
        'prose-li:text-text-primary prose-li:my-1',
        // 代码样式
        'prose-code:text-primary-400 prose-code:bg-bg-elevated',
        'prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded',
        'prose-code:before:content-none prose-code:after:content-none',
        // 代码块样式
        'prose-pre:bg-bg-elevated prose-pre:border prose-pre:border-border-subtle',
        'prose-pre:rounded-lg prose-pre:my-4',
        // 引用样式
        'prose-blockquote:border-l-primary-500 prose-blockquote:bg-bg-elevated',
        'prose-blockquote:text-text-secondary prose-blockquote:not-italic',
        'prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r',
        // 表格样式
        'prose-table:my-4',
        'prose-th:text-text-primary prose-th:bg-bg-elevated prose-th:px-4 prose-th:py-2',
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {data.content}
      </ReactMarkdown>
    </div>
  )
}

MarkdownBlock.displayName = 'MarkdownBlock'
