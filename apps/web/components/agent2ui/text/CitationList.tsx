'use client'

import { useState, useMemo } from 'react'
import clsx from 'clsx'
import { ChevronDown, ExternalLink, Globe } from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'

export interface Citation {
  title: string
  url: string
  domain: string
}

/**
 * 从 markdown 文本中提取所有外部链接作为引用
 */
export function extractCitations(markdown: string): Citation[] {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  const seen = new Set<string>()
  const citations: Citation[] = []

  let match
  while ((match = linkRegex.exec(markdown)) !== null) {
    const [, title, url] = match
    if (seen.has(url)) continue
    seen.add(url)
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '')
      citations.push({ title, url, domain })
    } catch {
      // skip invalid URLs
    }
  }
  return citations
}

export interface CitationListProps {
  content: string
  className?: string
  variant?: 'chat' | 'report'
  initiallyExpanded?: boolean
}

export function CitationList({ content, className, variant = 'chat', initiallyExpanded = false }: CitationListProps) {
  const { t } = useLocale()
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded)
  const citations = useMemo(() => extractCitations(content), [content])

  if (citations.length === 0) return null

  return (
    <div className={clsx('mt-7 border-t border-[rgba(255,255,255,0.08)] pt-4', className)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={clsx(
          'flex w-full items-center justify-between gap-2 text-sm text-text-secondary',
          'hover:text-text-primary transition-colors duration-fast'
        )}
      >
        <span className="flex items-center gap-1.5">
          <Globe size={14} />
          <span className="font-medium">{t('agent2ui.citation.references', { count: citations.length })}</span>
        </span>
        <ChevronDown
          size={14}
          className={clsx(
            'transition-transform duration-fast',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <ul
          className={clsx(
            'mt-3 space-y-1.5 animate-fade-in-up',
            variant === 'report' && 'rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-4'
          )}
        >
          {citations.map((cite, i) => (
            <li key={i}>
              <a
                href={cite.url}
                target="_blank"
                rel="noopener noreferrer"
                className={clsx(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]',
                  'bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.055)]',
                  'text-text-secondary hover:text-primary-400',
                  'transition-colors duration-fast group'
                )}
              >
                {/* Remote favicon endpoint is dynamic and tiny; plain img is acceptable here. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${cite.domain}&sz=16`}
                  alt=""
                  width={14}
                  height={14}
                  className="rounded-sm flex-shrink-0"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
                <span className="truncate flex-1">{cite.title}</span>
                <span className="text-text-tertiary flex-shrink-0">{cite.domain}</span>
                <ExternalLink
                  size={10}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

CitationList.displayName = 'CitationList'
