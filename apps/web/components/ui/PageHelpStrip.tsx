'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Button } from './Button'

interface PageHelpStripProps {
  text: string
  href?: string
  ctaLabel: string
  className?: string
}

export function PageHelpStrip({
  text,
  href = '/help',
  ctaLabel,
  className,
}: PageHelpStripProps) {
  return (
    <div className={['rounded-xl border border-primary-500/20 bg-gradient-to-r from-primary-500/10 via-bg-surface to-bg-surface px-4 py-3', className].filter(Boolean).join(' ')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{text}</p>
        <Link href={href} className="inline-flex">
          <Button size="xs" variant="tertiary" leftIcon={<ExternalLink size={13} />}>
            {ctaLabel}
          </Button>
        </Link>
      </div>
    </div>
  )
}

