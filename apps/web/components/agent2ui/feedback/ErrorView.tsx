'use client'

import clsx from 'clsx'
import { AlertTriangle, XCircle, RefreshCw } from 'lucide-react'
import type { ErrorData } from '@/types'

/**
 * ErrorView - 错误展示组件
 *
 * 展示错误信息，支持重试操作
 */

export interface ErrorViewProps {
  data: ErrorData
  className?: string
  onRetry?: () => void
}

export function ErrorView({ data, className, onRetry }: ErrorViewProps) {
  // 根据错误码判断严重程度
  const code = data.code ?? ''
  const isWarning = code.startsWith('WARN_') || code.includes('TIMEOUT')
  const Icon = isWarning ? AlertTriangle : XCircle

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden',
        isWarning
          ? 'border-warning-500/50 bg-warning-500/5'
          : 'border-error-500/50 bg-error-500/5',
        className
      )}
      role="alert"
      aria-live="assertive"
    >
      <div className="px-4 py-3">
        {/* 头部 */}
        <div className="flex items-start gap-3">
          <div
            className={clsx(
              'p-1.5 rounded-lg',
              isWarning ? 'bg-warning-500/10' : 'bg-error-500/10'
            )}
          >
            <Icon
              className={clsx(
                'w-5 h-5',
                isWarning ? 'text-warning-500' : 'text-error-500'
              )}
            />
          </div>

          <div className="flex-1 min-w-0">
            {/* 错误码 */}
            <div
              className={clsx(
                'text-xs font-mono mb-1',
                isWarning ? 'text-warning-400' : 'text-error-400'
              )}
            >
              {data.code}
            </div>

            {/* 错误消息 */}
            <p className="text-sm text-text-primary">
              {data.message}
            </p>

            {/* 详细信息 */}
            {data.details !== undefined && data.details !== null && (
              <pre
                className={clsx(
                  'mt-3 p-3 rounded text-xs font-mono',
                  'bg-bg-elevated text-text-secondary',
                  'overflow-x-auto max-h-32'
                )}
              >
                {typeof data.details === 'string'
                  ? data.details
                  : JSON.stringify(data.details, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* 重试按钮 */}
        {onRetry && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={onRetry}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5',
                'text-sm font-medium rounded',
                'transition-colors duration-fast',
                isWarning
                  ? 'text-warning-500 hover:bg-warning-500/10'
                  : 'text-error-500 hover:bg-error-500/10',
                'focus:outline-none focus-visible:ring-2',
                isWarning
                  ? 'focus-visible:ring-warning-500'
                  : 'focus-visible:ring-error-500'
              )}
            >
              <RefreshCw className="w-4 h-4" />
              <span>重试</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

ErrorView.displayName = 'ErrorView'
