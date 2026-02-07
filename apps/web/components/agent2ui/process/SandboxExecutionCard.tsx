'use client'

import { useState, useRef, useEffect } from 'react'
import clsx from 'clsx'
import {
  Terminal,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Cpu,
  HardDrive,
} from 'lucide-react'
import type {
  SandboxStatusData,
  SandboxLogData,
  SandboxOutputData,
  SandboxStatus,
} from '@/types'
import { SandboxLogView } from './SandboxLogView'
import { SandboxOutputView } from './SandboxOutputView'

/**
 * SandboxExecutionCard - 沙箱执行卡片聚合组件
 *
 * 聚合展示单次沙箱执行的完整信息
 * 包括状态、日志、输出等
 */

export interface SandboxExecutionCardProps {
  sandboxId: string
  status: SandboxStatusData
  logs?: SandboxLogData[]
  outputs?: SandboxOutputData[]
  className?: string
}

type TabType = 'logs' | 'output'

const statusConfig: Record<
  SandboxStatus,
  { icon: React.ReactNode; textClass: string; bgClass: string; label: string }
> = {
  starting: {
    icon: <Loader2 className="w-4 h-4 animate-spin" />,
    textClass: 'text-primary-500',
    bgClass: 'border-primary-500/50 bg-primary-500/5',
    label: '启动中',
  },
  running: {
    icon: <Loader2 className="w-4 h-4 animate-spin" />,
    textClass: 'text-primary-500',
    bgClass: 'border-primary-500/50 bg-primary-500/5',
    label: '执行中',
  },
  success: {
    icon: <CheckCircle className="w-4 h-4" />,
    textClass: 'text-success-500',
    bgClass: 'border-success-500/50 bg-success-500/5',
    label: '成功',
  },
  error: {
    icon: <XCircle className="w-4 h-4" />,
    textClass: 'text-error-500',
    bgClass: 'border-error-500/50 bg-error-500/5',
    label: '失败',
  },
  timeout: {
    icon: <Clock className="w-4 h-4" />,
    textClass: 'text-warning-500',
    bgClass: 'border-warning-500/50 bg-warning-500/5',
    label: '超时',
  },
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function SandboxExecutionCard({
  sandboxId,
  status,
  logs = [],
  outputs = [],
  className,
}: SandboxExecutionCardProps) {
  const [expanded, setExpanded] = useState(true)
  const [activeTab, setActiveTab] = useState<TabType>('output')
  const logsEndRef = useRef<HTMLDivElement>(null)

  const config = statusConfig[status.status]
  const isRunning = status.status === 'starting' || status.status === 'running'

  // 自动滚动到最新日志
  useEffect(() => {
    if (isRunning && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs.length, isRunning])

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden',
        'transition-colors duration-fast',
        config.bgClass,
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
            <Terminal className="w-4 h-4 text-text-secondary" />
          </div>
          <div className="flex flex-col">
            <span className="font-medium text-text-primary text-sm">
              沙箱执行
            </span>
            <span className="text-xs text-text-tertiary font-mono">
              {sandboxId.slice(0, 8)}...
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* 资源使用 */}
          {status.resourceUsage && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-text-tertiary">
              {status.resourceUsage.cpuPercent !== undefined && (
                <span className="flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {status.resourceUsage.cpuPercent.toFixed(1)}%
                </span>
              )}
              {status.resourceUsage.memoryMb !== undefined && (
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3 h-3" />
                  {status.resourceUsage.memoryMb.toFixed(1)}MB
                </span>
              )}
            </div>
          )}

          {/* 状态 */}
          <div className={clsx('flex items-center gap-1.5 text-sm', config.textClass)}>
            {config.icon}
            <span>{config.label}</span>
            {status.durationMs !== undefined && (
              <span className="text-text-tertiary">
                · {formatDuration(status.durationMs)}
              </span>
            )}
          </div>

          {/* 展开/折叠 */}
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
          {/* Tab 切换 */}
          <div className="flex border-b border-border-subtle">
            <button
              className={clsx(
                'flex items-center gap-1.5 px-4 py-2 text-sm',
                'transition-colors duration-fast',
                activeTab === 'output'
                  ? 'text-primary-500 border-b-2 border-primary-500'
                  : 'text-text-secondary hover:text-text-primary'
              )}
              onClick={() => setActiveTab('output')}
            >
              <Terminal className="w-4 h-4" />
              <span>输出</span>
              {outputs.length > 0 && (
                <span className="text-xs bg-bg-elevated px-1.5 py-0.5 rounded">
                  {outputs.length}
                </span>
              )}
            </button>
            <button
              className={clsx(
                'flex items-center gap-1.5 px-4 py-2 text-sm',
                'transition-colors duration-fast',
                activeTab === 'logs'
                  ? 'text-primary-500 border-b-2 border-primary-500'
                  : 'text-text-secondary hover:text-text-primary'
              )}
              onClick={() => setActiveTab('logs')}
            >
              <FileText className="w-4 h-4" />
              <span>日志</span>
              {logs.length > 0 && (
                <span className="text-xs bg-bg-elevated px-1.5 py-0.5 rounded">
                  {logs.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab 内容 */}
          <div className="max-h-80 overflow-y-auto">
            {activeTab === 'output' && (
              <div className="p-4 space-y-3">
                {outputs.length === 0 ? (
                  <div className="text-sm text-text-tertiary text-center py-4">
                    {isRunning ? '等待输出...' : '无输出'}
                  </div>
                ) : (
                  outputs.map((output, index) => (
                    <SandboxOutputView key={index} data={output} />
                  ))
                )}
              </div>
            )}

            {activeTab === 'logs' && (
              <div className="p-2 space-y-1">
                {logs.length === 0 ? (
                  <div className="text-sm text-text-tertiary text-center py-4">
                    {isRunning ? '等待日志...' : '无日志'}
                  </div>
                ) : (
                  <>
                    {logs.map((log, index) => (
                      <SandboxLogView key={index} data={log} />
                    ))}
                    <div ref={logsEndRef} />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 执行中的进度条 */}
      {isRunning && (
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

SandboxExecutionCard.displayName = 'SandboxExecutionCard'
