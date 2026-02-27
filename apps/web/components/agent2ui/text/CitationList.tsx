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
}

export function CitationList({ content, className }: CitationListProps) {
  const { t } = useLocale()
  const [isExpanded, setIsExpanded] = useState(false)
  const citations = useMemo(() => extractCitations(content), [content])

  if (citations.length === 0) return null

  return (
    <div className={clsx('mt-3 pt-3 border-t border-border-subtle', className)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={clsx(
          'flex items-center gap-1.5 text-xs text-text-secondary',
          'hover:text-text-primary transition-colors duration-fast'
        )}
      >
        <Globe size={12} />
        <span>{t('agent2ui.citation.references', { count: citations.length })}</span>
        <ChevronDown
          size={12}
          className={clsx(
            'transition-transform duration-fast',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <ul className="mt-2 space-y-1.5 animate-fade-in-up">
          {citations.map((cite, i) => (
            <li key={i}>
              <a
                href={cite.url}
                target="_blank"
                rel="noopener noreferrer"
                className={clsx(
                  'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs',
                  'bg-bg-base/50 hover:bg-interactive-hover',
                  'text-text-secondary hover:text-primary-400',
                  'transition-colors duration-fast group'
                )}
              >
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
