'use client'

import { useEffect } from 'react'
import { useLocale } from './LocaleProvider'

export function DynamicMetadata() {
  const { t } = useLocale()

  useEffect(() => {
    const title = t('metadata.title')
    if (title && typeof document !== 'undefined') {
      document.title = title
    }
  }, [t])

  return null
}
