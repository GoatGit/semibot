'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { Wrench, Check, XCircle, Loader2, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import type { ToolCallData } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

/**
 * ToolCallView - 工具调用卡片组件
 *
 * 根据 DESIGN_SYSTEM.md 中工具调用卡片设计
 * 展示工具调用状态、参数和结果
 */

export interface ToolCallViewProps {
  data: ToolCallData
  className?: string
  onRetry?: () => void
  variant?: 'default' | 'compact'
}

export function ToolCallView({ data, className, onRetry, variant = 'default' }: ToolCallViewProps) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(false)

  const getStatusIcon = () => {
    switch (data.status) {
      case 'calling':
        return <Loader2 className="w-4 h-4 text-primary-500 animate-spin" />
      case 'success':
        return <Check className="w-4 h-4 text-success-500" />
      case 'error':
        return <XCircle className="w-4 h-4 text-error-500" />
    }
  }

  const getStatusLabel = () => {
    switch (data.status) {
      case 'calling':
        return t('agent2ui.toolCall.running')
      case 'success':
        return data.duration ? t('agent2ui.toolCall.successWithDuration', { seconds: (data.duration / 1000).toFixed(1) }) : t('agent2ui.toolCall.success')
      case 'error':
        return data.duration ? t('agent2ui.toolCall.errorWithDuration', { seconds: (data.duration / 1000).toFixed(1) }) : t('agent2ui.toolCall.error')
    }
  }

  const getStatusColor = () => {
    switch (data.status) {
      case 'calling':
        return 'text-primary-500'
      case 'success':
        return 'text-success-500'
      case 'error':
        return 'text-error-500'
    }
  }

  const formatArguments = (args: Record<string, unknown>): string => {
    try {
      return JSON.stringify(args, null, 2)
    } catch {
      return String(args)
    }
  }

  const formatResult = (result: unknown): string => {
    if (result === undefined || result === null) return ''
    try {
      if (typeof result === 'string') return result
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }

  if (variant === 'compact') {
    return (
      <div className={clsx('relative', className)}>
        <div
          className={clsx(
            'flex items-center gap-3 px-3 py-2 rounded-md',
            'cursor-pointer hover:bg-interactive-hover transition-colors duration-fast'
          )}
          onClick={() => setExpanded(!expanded)}
        >
          <Wrench className="w-4 h-4 text-text-tertiary flex-shrink-0" />
          <span className="font-mono text-sm text-text-primary">{data.toolName}</span>
          <div className={clsx('flex items-center gap-1.5 text-sm ml-auto', getStatusColor())}>
            {getStatusIcon()}
            <span>{getStatusLabel()}</span>
          </div>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
          )}
        </div>
        {expanded && (
          <div className="border border-border-subtle rounded-md bg-bg-surface mt-1 overflow-hidden">
            {Object.keys(data.arguments).length > 0 && (
              <div className="px-3 py-2 border-b border-border-subtle">
                <div className="text-xs text-text-tertiary mb-1">{t('agent2ui.toolCall.arguments')}</div>
                <pre className="text-xs font-mono text-text-secondary bg-bg-elevated p-2 rounded overflow-x-auto">
                  {formatArguments(data.arguments)}
                </pre>
              </div>
            )}
            {data.result !== undefined && (
              <div className="px-3 py-2">
                <div className="text-xs text-text-tertiary mb-1">{t('agent2ui.toolCall.result')}</div>
                <pre
                  className={clsx(
                    'text-xs font-mono p-2 rounded overflow-x-auto max-h-36',
                    data.status === 'error'
                      ? 'text-error-400 bg-error-500/10'
                      : 'text-text-secondary bg-bg-elevated'
                  )}
                >
                  {formatResult(data.result)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden',
        'transition-colors duration-fast',
        data.status === 'calling' && 'border-primary-500/50 bg-primary-500/5',
        data.status === 'success' && 'border-border-subtle bg-bg-surface',
        data.status === 'error' && 'border-error-500/50 bg-error-500/5',
        className
      )}
    >
      {/* 头部 */}
      <div
        className={clsx(
          'flex items-center justify-between',
          'px-4 py-3',
          'cursor-pointer',
          'hover:bg-interactive-hover'
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded bg-bg-elevated">
            <Wrench className="w-4 h-4 text-text-secondary" />
          </div>
          <span className="font-medium text-text-primary font-mono text-sm">
            {data.toolName}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className={clsx('flex items-center gap-1.5 text-sm', getStatusColor())}>
            {getStatusIcon()}
            <span>{getStatusLabel()}</span>
          </div>

          {data.status === 'error' && onRetry && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRetry()
              }}
              className={clsx(
                'flex items-center gap-1 px-2 py-1',
                'text-xs text-text-secondary',
                'rounded hover:bg-interactive-hover',
                'transition-colors duration-fast'
              )}
            >
              <RotateCcw className="w-3 h-3" />
              <span>{t('common.retry')}</span>
            </button>
          )}

          {expanded ? (
            <ChevronUp className="w-4 h-4 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-4 h-4 text-text-tertiary" />
          )}
        </div>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-border-subtle">
          {/* 参数 */}
          {Object.keys(data.arguments).length > 0 && (
            <div className="px-4 py-3 border-b border-border-subtle">
              <div className="text-xs text-text-tertiary mb-2">{t('agent2ui.toolCall.arguments')}</div>
              <pre className="text-sm font-mono text-text-secondary bg-bg-elevated p-3 rounded overflow-x-auto">
                {formatArguments(data.arguments)}
              </pre>
            </div>
          )}

          {/* 结果 */}
          {data.result !== undefined && (
            <div className="px-4 py-3">
              <div className="text-xs text-text-tertiary mb-2">{t('agent2ui.toolCall.result')}</div>
              <pre
                className={clsx(
                  'text-sm font-mono p-3 rounded overflow-x-auto max-h-48',
                  data.status === 'error'
                    ? 'text-error-400 bg-error-500/10'
                    : 'text-text-secondary bg-bg-elevated'
                )}
              >
                {formatResult(data.result)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 执行中的进度条 */}
      {data.status === 'calling' && (
        <div className="h-0.5 bg-bg-elevated overflow-hidden">
          <div
            className="h-full bg-primary-500 animate-pulse"
            style={{ width: '60%' }}
          />
        </div>
      )}
    </div>
  )
}

ToolCallView.displayName = 'ToolCallView'
