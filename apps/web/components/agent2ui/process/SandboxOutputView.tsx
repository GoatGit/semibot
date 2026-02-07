'use client'

import clsx from 'clsx'
import { Terminal, AlertCircle, CheckCircle, XCircle } from 'lucide-react'
import type { SandboxOutputData, SandboxOutputStream } from '@/types'

/**
 * SandboxOutputView - 沙箱输出展示组件
 *
 * 展示沙箱代码执行的 stdout/stderr 输出
 * 支持终端风格渲染
 */

export interface SandboxOutputViewProps {
  data: SandboxOutputData
  className?: string
}

const streamConfig: Record<
  SandboxOutputStream,
  { icon: React.ReactNode; textClass: string; label: string }
> = {
  stdout: {
    icon: <Terminal className="w-3.5 h-3.5" />,
    textClass: 'text-success-400',
    label: 'stdout',
  },
  stderr: {
    icon: <AlertCircle className="w-3.5 h-3.5" />,
    textClass: 'text-error-400',
    label: 'stderr',
  },
}

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return timestamp
  }
}

function getExitCodeDisplay(exitCode: number | undefined) {
  if (exitCode === undefined) return null

  const isSuccess = exitCode === 0
  return {
    icon: isSuccess ? (
      <CheckCircle className="w-3.5 h-3.5" />
    ) : (
      <XCircle className="w-3.5 h-3.5" />
    ),
    textClass: isSuccess ? 'text-success-500' : 'text-error-500',
    label: `exit ${exitCode}`,
  }
}

export function SandboxOutputView({ data, className }: SandboxOutputViewProps) {
  const config = streamConfig[data.stream]
  const exitCodeDisplay = getExitCodeDisplay(data.exitCode)

  return (
    <div
      className={clsx(
        'rounded-lg overflow-hidden',
        'bg-gray-900 border border-gray-700',
        className
      )}
    >
      {/* 终端头部 */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <span className={clsx('flex items-center gap-1 text-xs', config.textClass)}>
            {config.icon}
            <span>{config.label}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs">
            {formatTimestamp(data.timestamp)}
          </span>
          {exitCodeDisplay && (
            <span
              className={clsx(
                'flex items-center gap-1 text-xs font-medium',
                exitCodeDisplay.textClass
              )}
            >
              {exitCodeDisplay.icon}
              <span>{exitCodeDisplay.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* 输出内容 */}
      <div className="p-3 overflow-x-auto">
        <pre
          className={clsx(
            'font-mono text-sm whitespace-pre-wrap break-words',
            data.stream === 'stdout' ? 'text-gray-200' : 'text-error-400'
          )}
        >
          {data.content}
        </pre>
      </div>
    </div>
  )
}

SandboxOutputView.displayName = 'SandboxOutputView'
