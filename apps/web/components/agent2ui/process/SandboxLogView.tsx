'use client'

import clsx from 'clsx'
import { AlertCircle, AlertTriangle, Bug, Info } from 'lucide-react'
import type { SandboxLogData, SandboxLogLevel } from '@/types'

/**
 * SandboxLogView - 沙箱日志展示组件
 *
 * 展示沙箱执行过程中的实时日志
 * 支持不同日志级别的颜色区分
 */

export interface SandboxLogViewProps {
  data: SandboxLogData
  className?: string
}

const levelConfig: Record<
  SandboxLogLevel,
  { icon: React.ReactNode; textClass: string; bgClass: string; label: string }
> = {
  debug: {
    icon: <Bug className="w-3.5 h-3.5" />,
    textClass: 'text-text-tertiary',
    bgClass: 'bg-bg-elevated',
    label: 'DEBUG',
  },
  info: {
    icon: <Info className="w-3.5 h-3.5" />,
    textClass: 'text-primary-500',
    bgClass: 'bg-primary-500/5',
    label: 'INFO',
  },
  warn: {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    textClass: 'text-warning-500',
    bgClass: 'bg-warning-500/5',
    label: 'WARN',
  },
  error: {
    icon: <AlertCircle className="w-3.5 h-3.5" />,
    textClass: 'text-error-500',
    bgClass: 'bg-error-500/5',
    label: 'ERROR',
  },
}

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    })
  } catch {
    return timestamp
  }
}

export function SandboxLogView({ data, className }: SandboxLogViewProps) {
  const config = levelConfig[data.level]

  return (
    <div
      className={clsx(
        'flex items-start gap-2 px-3 py-2 rounded-md',
        'font-mono text-sm',
        config.bgClass,
        className
      )}
    >
      {/* 时间戳 */}
      <span className="text-text-tertiary text-xs shrink-0 pt-0.5">
        {formatTimestamp(data.timestamp)}
      </span>

      {/* 日志级别标签 */}
      <span
        className={clsx(
          'flex items-center gap-1 text-xs font-medium shrink-0 pt-0.5',
          config.textClass
        )}
      >
        {config.icon}
        <span className="hidden sm:inline">{config.label}</span>
      </span>

      {/* 来源 */}
      {data.source && (
        <span className="text-text-tertiary text-xs shrink-0 pt-0.5">
          [{data.source}]
        </span>
      )}

      {/* 消息内容 */}
      <span className={clsx('flex-1 break-words', config.textClass)}>
        {data.message}
      </span>
    </div>
  )
}

SandboxLogView.displayName = 'SandboxLogView'
