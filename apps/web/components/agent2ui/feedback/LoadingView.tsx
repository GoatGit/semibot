'use client'

import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'

/**
 * LoadingView - 加载状态组件
 *
 * 支持 Skeleton 骨架屏和 Spinner 两种模式
 */

export interface LoadingViewProps {
  className?: string
  variant?: 'skeleton' | 'spinner'
  /** Skeleton 模式下的行数 */
  lines?: number
  /** Spinner 模式下的提示文字 */
  message?: string
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg'
}

export function LoadingView({
  className,
  variant = 'skeleton',
  lines = 3,
  message,
  size = 'md',
}: LoadingViewProps) {
  const { t } = useLocale()
  const resolvedMessage = message ?? t('common.loading')
  if (variant === 'spinner') {
    const spinnerSizes = {
      sm: 'w-4 h-4',
      md: 'w-6 h-6',
      lg: 'w-8 h-8',
    }

    const textSizes = {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
    }

    return (
      <div
        className={clsx(
          'flex flex-col items-center justify-center gap-3 py-8',
          className
        )}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2
          className={clsx(spinnerSizes[size], 'text-primary-500 animate-spin')}
        />
        {resolvedMessage && (
          <span className={clsx(textSizes[size], 'text-text-secondary')}>
            {resolvedMessage}
          </span>
        )}
        <span className="sr-only">{resolvedMessage}</span>
      </div>
    )
  }

  // Skeleton 模式
  const lineWidths = ['w-full', 'w-11/12', 'w-4/5', 'w-3/4', 'w-2/3']

  return (
    <div
      className={clsx('space-y-3', className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* 标题骨架 */}
      <div
        className={clsx(
          'h-5 w-1/3 rounded',
          'bg-bg-elevated animate-pulse'
        )}
      />

      {/* 内容骨架 */}
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className={clsx(
            'h-4 rounded',
            'bg-bg-elevated',
            lineWidths[index % lineWidths.length]
          )}
          style={{
            animation: `pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`,
            animationDelay: `${index * 100}ms`,
          }}
        />
      ))}

      <span className="sr-only">{t('agent2ui.loading.contentLoading')}</span>
    </div>
  )
}

LoadingView.displayName = 'LoadingView'

/**
 * SkeletonCard - 卡片骨架屏
 */
export interface SkeletonCardProps {
  className?: string
  hasImage?: boolean
}

export function SkeletonCard({ className, hasImage = false }: SkeletonCardProps) {
  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle',
        'bg-bg-surface p-4',
        'animate-pulse',
        className
      )}
    >
      {hasImage && (
        <div className="h-32 bg-bg-elevated rounded-lg mb-4" />
      )}
      <div className="space-y-3">
        <div className="h-5 w-3/4 bg-bg-elevated rounded" />
        <div className="h-4 w-full bg-bg-elevated rounded" />
        <div className="h-4 w-5/6 bg-bg-elevated rounded" />
      </div>
    </div>
  )
}

SkeletonCard.displayName = 'SkeletonCard'

/**
 * SkeletonTable - 表格骨架屏
 */
export interface SkeletonTableProps {
  className?: string
  rows?: number
  columns?: number
}

export function SkeletonTable({
  className,
  rows = 5,
  columns = 4,
}: SkeletonTableProps) {
  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle overflow-hidden',
        className
      )}
    >
      {/* 表头 */}
      <div className="flex bg-bg-elevated border-b border-border-subtle">
        {Array.from({ length: columns }).map((_, index) => (
          <div
            key={index}
            className="flex-1 px-4 py-3"
          >
            <div
              className="h-4 bg-neutral-700 rounded animate-pulse"
              style={{ animationDelay: `${index * 50}ms` }}
            />
          </div>
        ))}
      </div>

      {/* 表格行 */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className={clsx(
            'flex border-b border-border-subtle last:border-b-0'
          )}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <div
              key={colIndex}
              className="flex-1 px-4 py-3"
            >
              <div
                className="h-4 bg-bg-elevated rounded animate-pulse"
                style={{
                  animationDelay: `${(rowIndex * columns + colIndex) * 30}ms`,
                  width: `${60 + Math.random() * 40}%`,
                }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

SkeletonTable.displayName = 'SkeletonTable'
