'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertOctagon, RefreshCw } from 'lucide-react'
import { createTranslator, defaultLocale, detectLocale, type Locale } from '@/lib/i18n'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * 全局错误边界 (根级别)
 *
 * 捕获整个应用的未处理错误
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const [locale, setLocale] = useState<Locale>(defaultLocale)
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    // 记录错误到日志服务
    console.error('[Global Error]', error)
  }, [error])

  useEffect(() => {
    setLocale(detectLocale())
  }, [])

  return (
    <html lang={locale}>
      <body className="bg-bg-base text-text-primary">
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-6 max-w-md text-center px-4">
            {/* 错误图标 */}
            <div className="w-20 h-20 rounded-full bg-error-500/10 flex items-center justify-center">
              <AlertOctagon size={40} className="text-error-500" />
            </div>

            {/* 错误信息 */}
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-text-primary">{t('globalError.title')}</h1>
              <p className="text-text-secondary">
                {t('globalError.message')}
              </p>
              {process.env.NODE_ENV === 'development' && error.message && (
                <p className="text-sm text-error-400 mt-4 p-3 bg-error-500/10 rounded-md font-mono">
                  {error.message}
                </p>
              )}
              {error.digest && (
                <p className="text-xs text-text-tertiary">{t('globalError.errorId')}: {error.digest}</p>
              )}
            </div>

            {/* 重试按钮 */}
            <button
              onClick={reset}
              className="flex items-center gap-2 px-6 py-3 bg-primary-500 text-white rounded-md hover:bg-primary-600 transition-colors"
            >
              <RefreshCw size={18} />
              {t('globalError.reload')}
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
