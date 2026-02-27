'use client'

import clsx from 'clsx'
import type { ProgressData } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

/**
 * ProgressView - 进度条组件
 *
 * 展示任务执行进度
 */

export interface ProgressViewProps {
  data: ProgressData
  className?: string
}

export function ProgressView({ data, className }: ProgressViewProps) {
  const { t } = useLocale()
  // 使用类型定义的字段名: current, total, percentage, label
  const percentage = data.percentage ?? Math.min(100, Math.max(0, (data.current / data.total) * 100))
  const isIndeterminate = data.total <= 0

  return (
    <div className={clsx('space-y-2', className)}>
      {/* 标签和百分比 */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary">
          {data.label || t('agent2ui.progress.processing')}
        </span>
        {!isIndeterminate && (
          <span className="text-text-primary font-mono">
            {percentage.toFixed(0)}%
          </span>
        )}
      </div>

      {/* 进度条容器 */}
      <div
        className={clsx(
          'h-2 rounded-full overflow-hidden',
          'bg-bg-elevated'
        )}
      >
        {isIndeterminate ? (
          // 不确定进度的动画
          <div
            className={clsx(
              'h-full w-1/3 rounded-full',
              'bg-gradient-to-r from-transparent via-primary-500 to-transparent',
              'animate-shimmer'
            )}
            style={{
              animation: 'shimmer 1.5s ease-in-out infinite',
            }}
          />
        ) : (
          // 确定进度
          <div
            className={clsx(
              'h-full rounded-full',
              'bg-primary-500',
              'transition-all duration-normal ease-out'
            )}
            style={{ width: `${percentage}%` }}
          />
        )}
      </div>

      {/* 详细进度 */}
      {!isIndeterminate && data.total > 0 && (
        <div className="text-xs text-text-tertiary text-right">
          {data.current} / {data.total}
        </div>
      )}
    </div>
  )
}

ProgressView.displayName = 'ProgressView'
