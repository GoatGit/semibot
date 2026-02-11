'use client'

import { useState, useEffect, useMemo } from 'react'
import clsx from 'clsx'
import { Brain, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { ThinkingView } from './ThinkingView'
import { PlanView } from './PlanView'
import { ToolCallView } from './ToolCallView'
import type { ThinkingData, PlanData, ToolCallData } from '@/types'

export interface ProcessCardProps {
  isActive: boolean
  thinking: ThinkingData | null
  isThinking: boolean
  plan: PlanData | null
  toolCalls: ToolCallData[]
  className?: string
}

type CardStatus = 'active' | 'completed' | 'failed'

export function ProcessCard({
  isActive,
  thinking,
  isThinking,
  plan,
  toolCalls,
  className,
}: ProcessCardProps) {
  const [expanded, setExpanded] = useState(true)

  // Auto-expand when active, auto-collapse when done
  useEffect(() => {
    setExpanded(isActive)
  }, [isActive])

  const hasFailure = toolCalls.some((tc) => tc.status === 'error')

  const status: CardStatus = isActive
    ? 'active'
    : hasFailure
      ? 'failed'
      : 'completed'

  const summary = useMemo(() => {
    const parts: string[] = []
    if (toolCalls.length > 0) {
      parts.push(`调用 ${toolCalls.length} 次工具`)
    }
    if (plan && plan.steps.length > 0) {
      parts.push(`执行 ${plan.steps.length} 个步骤`)
    }
    const failedCount = toolCalls.filter((tc) => tc.status === 'error').length
    if (failedCount > 0) {
      parts.push(`${failedCount} 个失败`)
    }
    return parts.join('，')
  }, [toolCalls, plan])

  const hasContent = thinking || plan || toolCalls.length > 0 || isThinking || isActive

  if (!hasContent) return null

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden transition-colors duration-200',
        status === 'active' && 'border-primary-500/30 bg-primary-500/5',
        status === 'completed' && 'border-border-subtle bg-bg-surface',
        status === 'failed' && 'border-error-500/30 bg-error-500/5',
        className
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          'flex items-center gap-3 px-4 py-3 cursor-pointer',
          'hover:bg-interactive-hover transition-colors duration-fast'
        )}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {status === 'active' && (
          <>
            <div className="relative flex-shrink-0">
              <Brain className="w-5 h-5 text-primary-500" />
              <span className="absolute inset-0 rounded-full bg-primary-500/30 animate-ping" />
            </div>
            <span className="text-sm font-medium text-text-primary">深度思考中</span>
            <div className="flex items-center gap-1 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '200ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '400ms' }} />
            </div>
          </>
        )}
        {status === 'completed' && (
          <>
            <CheckCircle2 className="w-5 h-5 text-success-500 flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary">已完成思考</span>
            {summary && (
              <span className="text-sm text-text-tertiary ml-1">{summary}</span>
            )}
          </>
        )}
        {status === 'failed' && (
          <>
            <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary">执行遇到问题</span>
            {summary && (
              <span className="text-sm text-text-tertiary ml-1">{summary}</span>
            )}
          </>
        )}

        <div className="ml-auto flex-shrink-0">
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-4 h-4 text-text-tertiary" />
          )}
        </div>
      </div>

      {/* Collapsible content with CSS grid transition */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          {/* Thinking section */}
          {thinking && (
            <div className="px-4 py-3 border-t border-border-subtle/50">
              <ThinkingView data={thinking} variant="inline" />
            </div>
          )}

          {/* Plan section */}
          {plan && (
            <div className="px-4 py-3 border-t border-border-subtle/50">
              <PlanView data={plan} variant="inline" mode="vertical" />
            </div>
          )}

          {/* Tool calls section */}
          {toolCalls.length > 0 && (
            <div className="px-2 py-2 border-t border-border-subtle/50">
              {toolCalls.map((tc, i) => (
                <ToolCallView
                  key={`${tc.toolName}-${i}`}
                  data={tc}
                  variant="compact"
                />
              ))}
            </div>
          )}

          {/* Footer summary */}
          {summary && (
            <div className="px-4 py-2 bg-bg-elevated/50 border-t border-border-subtle/50">
              <span className="text-xs text-text-tertiary">{summary}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

ProcessCard.displayName = 'ProcessCard'
