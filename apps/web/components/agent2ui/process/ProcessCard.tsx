'use client'

import { useState, useEffect, useMemo } from 'react'
import clsx from 'clsx'
import {
  Brain,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Wrench,
  ClipboardList,
  Check,
  XCircle,
  Loader2,
  Play,
} from 'lucide-react'
import type {
  Agent2UIMessage,
  Agent2UIType,
  ThinkingData,
  PlanData,
  PlanStepData,
  ToolCallData,
  ToolResultData,
  McpCallData,
  McpResultData,
} from '@/types'

export interface ProcessCardProps {
  isActive: boolean
  thinking: ThinkingData | null
  isThinking: boolean
  plan: PlanData | null
  toolCalls: ToolCallData[]
  messages?: Agent2UIMessage[]
  className?: string
}

type CardStatus = 'active' | 'completed' | 'failed'

/** 需要在时序日志中展示的消息类型 */
const TIMELINE_TYPES = new Set<Agent2UIType>([
  'thinking',
  'plan',
  'plan_step',
  'tool_call',
  'tool_result',
  'mcp_call',
  'mcp_result',
])

/**
 * 去重时序消息：
 * - Runtime 模式：有 plan_step + tool_result/mcp_result，跳过 tool_call/mcp_call 避免重复
 * - Direct 模式：没有 plan_step/tool_result/mcp_result，保留 tool_call/mcp_call
 * - 连续多条 thinking 合并为一条
 * - 同一 stepId 的 plan_step 只保留最新状态
 */
function deduplicateTimeline(messages: Agent2UIMessage[]): Agent2UIMessage[] {
  const result: Agent2UIMessage[] = []
  let lastThinking: Agent2UIMessage | null = null
  let mergedThinkingContent = ''

  // 检测是否为 runtime 模式（有 plan_step 或 tool_result/mcp_result 事件）
  const hasRuntimeEvents = messages.some(
    (m) => m.type === 'plan_step' || m.type === 'tool_result' || m.type === 'mcp_result'
  )

  // 第一遍：收集每个 stepId 的最新 plan_step 状态
  const latestPlanStepData = new Map<string, PlanStepData>()
  for (const msg of messages) {
    if (msg.type === 'plan_step') {
      const data = msg.data as PlanStepData
      latestPlanStepData.set(data.stepId, data)
    }
  }
  // 记录已输出的 stepId，避免重复
  const emittedStepIds = new Set<string>()

  for (const msg of messages) {
    // 合并连续 thinking
    if (msg.type === 'thinking') {
      const data = msg.data as ThinkingData
      if (lastThinking) {
        mergedThinkingContent += '\n' + (data.content || '')
      } else {
        lastThinking = msg
        mergedThinkingContent = data.content || ''
      }
      continue
    }

    // 遇到非 thinking，先 flush 之前的 thinking
    if (lastThinking) {
      result.push({
        ...lastThinking,
        data: { ...(lastThinking.data as ThinkingData), content: mergedThinkingContent },
      })
      lastThinking = null
      mergedThinkingContent = ''
    }

    // Runtime 模式下跳过 tool_call/mcp_call（plan_step + tool_result/mcp_result 已覆盖）
    // Direct 模式下保留它们（是唯一的工具调用可见性来源）
    if (hasRuntimeEvents) {
      if (msg.type === 'tool_call') continue
      if (msg.type === 'mcp_call') continue
    }

    // plan_step 按 stepId 去重，保留首次出现的时间戳但用最新状态
    if (msg.type === 'plan_step') {
      const data = msg.data as PlanStepData
      if (emittedStepIds.has(data.stepId)) continue
      emittedStepIds.add(data.stepId)
      // 保留原始消息的时间戳，替换为最新的 data
      result.push({
        ...msg,
        data: latestPlanStepData.get(data.stepId)!,
      })
      continue
    }

    result.push(msg)
  }

  // flush 尾部 thinking
  if (lastThinking) {
    result.push({
      ...lastThinking,
      data: { ...(lastThinking.data as ThinkingData), content: mergedThinkingContent },
    })
  }

  return result
}

/** 格式化 ISO 时间戳为 HH:mm:ss */
function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp)
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/** 截断文本到指定长度 */
function truncate(text: string, max: number): string {
  const single = text.replace(/\n/g, ' ').trim()
  if (single.length <= max) return single
  return single.slice(0, max) + '…'
}

// ---------------------------------------------------------------------------
// TimelineEntry — 每条时序日志的行内组件
// ---------------------------------------------------------------------------

function TimelineEntry({ message }: { message: Agent2UIMessage }) {
  const [expanded, setExpanded] = useState(false)
  const time = formatTime(message.timestamp)

  switch (message.type) {
    case 'thinking': {
      const data = message.data as ThinkingData
      const content = data.content || ''
      // 合并后的 thinking 可能包含多段（用 \n 分隔）
      const segments = content.split('\n').filter((s) => s.trim())
      const isMerged = segments.length > 1
      const needExpand = isMerged || content.length > 80
      const preview = isMerged
        ? truncate(segments[0], 60) + ` (+${segments.length - 1}条)`
        : truncate(content, 80)
      return (
        <div className="group py-1.5 px-3">
          <div className="flex items-start gap-2">
            <span className="text-xs text-text-tertiary font-mono shrink-0 mt-0.5 w-[52px]">{time}</span>
            <Brain className="w-3.5 h-3.5 text-primary-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              {expanded ? (
                <div className="space-y-1">
                  {segments.map((seg, i) => (
                    <p key={i} className="text-xs text-text-secondary">{seg}</p>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-text-secondary">{preview}</span>
              )}
              {needExpand && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="ml-1 text-xs text-primary-400 hover:underline"
                >
                  {expanded ? '收起' : '展开'}
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    case 'plan': {
      const data = message.data as PlanData
      return (
        <div className="flex items-center gap-2 py-1.5 px-3">
          <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
          <ClipboardList className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs text-text-primary">
            执行计划: {data.steps.length} 个步骤
          </span>
        </div>
      )
    }

    case 'plan_step': {
      const data = message.data as PlanStepData
      const statusIcon = data.status === 'completed'
        ? <Check className="w-3 h-3 text-success-500" />
        : data.status === 'running'
          ? <Loader2 className="w-3 h-3 text-primary-500 animate-spin" />
          : data.status === 'failed'
            ? <XCircle className="w-3 h-3 text-error-500" />
            : <Play className="w-3 h-3 text-text-tertiary" />
      const statusLabel = data.status === 'completed'
        ? '完成'
        : data.status === 'running'
          ? '进行中'
          : data.status === 'failed'
            ? '失败'
            : ''
      return (
        <div className="flex items-center gap-2 py-1.5 px-3">
          <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
          <ClipboardList className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs text-text-primary flex-1 min-w-0 truncate">{data.title}</span>
          <div className="flex items-center gap-1 shrink-0">
            {statusIcon}
            {statusLabel && (
              <span className={clsx(
                'text-xs',
                data.status === 'completed' && 'text-success-500',
                data.status === 'running' && 'text-primary-500',
                data.status === 'failed' && 'text-error-500',
              )}>
                {statusLabel}
              </span>
            )}
          </div>
        </div>
      )
    }

    case 'tool_call': {
      const data = message.data as ToolCallData
      return (
        <div className="flex items-center gap-2 py-1.5 px-3">
          <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
          <Wrench className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
          <span className="text-xs font-mono text-text-primary">{data.toolName}</span>
          {data.status === 'calling' && (
            <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />
          )}
          {data.status === 'success' && (
            <div className="flex items-center gap-1 shrink-0">
              <Check className="w-3 h-3 text-success-500" />
              {data.duration != null && (
                <span className="text-xs text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
          {data.status === 'error' && (
            <div className="flex items-center gap-1 shrink-0">
              <XCircle className="w-3 h-3 text-error-500" />
              <span className="text-xs text-error-500">失败</span>
            </div>
          )}
        </div>
      )
    }

    case 'tool_result': {
      const data = message.data as ToolResultData
      const hasResult = data.result !== undefined && data.result !== null
      return (
        <div className="py-1.5 px-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
            <Wrench className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
            <span className="text-xs font-mono text-text-primary">{data.toolName}</span>
            {data.success ? (
              <div className="flex items-center gap-1 shrink-0">
                <Check className="w-3 h-3 text-success-500" />
                {data.duration != null && (
                  <span className="text-xs text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1 shrink-0">
                <XCircle className="w-3 h-3 text-error-500" />
                <span className="text-xs text-error-500">失败</span>
              </div>
            )}
            {hasResult && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-auto text-xs text-primary-400 hover:underline shrink-0"
              >
                {expanded ? '收起' : '详情'}
              </button>
            )}
          </div>
          {expanded && hasResult && (
            <pre className={clsx(
              'mt-1 ml-[60px] text-xs font-mono p-2 rounded overflow-x-auto max-h-36',
              data.success ? 'text-text-secondary bg-bg-elevated' : 'text-error-400 bg-error-500/10',
            )}>
              {typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)}
            </pre>
          )}
        </div>
      )
    }

    case 'mcp_call': {
      const data = message.data as McpCallData
      return (
        <div className="flex items-center gap-2 py-1.5 px-3">
          <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
          <Wrench className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span className="text-xs font-mono text-text-primary">{data.toolName}</span>
          {data.status === 'calling' && (
            <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />
          )}
          {data.status === 'success' && (
            <div className="flex items-center gap-1 shrink-0">
              <Check className="w-3 h-3 text-success-500" />
              {data.duration != null && (
                <span className="text-xs text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
          {data.status === 'error' && (
            <div className="flex items-center gap-1 shrink-0">
              <XCircle className="w-3 h-3 text-error-500" />
              <span className="text-xs text-error-500">失败</span>
            </div>
          )}
        </div>
      )
    }

    case 'mcp_result': {
      const data = message.data as McpResultData
      const hasResult = data.result !== undefined && data.result !== null
      return (
        <div className="py-1.5 px-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary font-mono shrink-0 w-[52px]">{time}</span>
            <Wrench className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <span className="text-xs font-mono text-text-primary">{data.toolName}</span>
            {data.success ? (
              <div className="flex items-center gap-1 shrink-0">
                <Check className="w-3 h-3 text-success-500" />
                {data.duration != null && (
                  <span className="text-xs text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1 shrink-0">
                <XCircle className="w-3 h-3 text-error-500" />
                <span className="text-xs text-error-500">失败</span>
              </div>
            )}
            {hasResult && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-auto text-xs text-primary-400 hover:underline shrink-0"
              >
                {expanded ? '收起' : '详情'}
              </button>
            )}
          </div>
          {expanded && hasResult && (
            <pre className={clsx(
              'mt-1 ml-[60px] text-xs font-mono p-2 rounded overflow-x-auto max-h-36',
              data.success ? 'text-text-secondary bg-bg-elevated' : 'text-error-400 bg-error-500/10',
            )}>
              {typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)}
            </pre>
          )}
        </div>
      )
    }

    default:
      return null
  }
}

TimelineEntry.displayName = 'TimelineEntry'

// ---------------------------------------------------------------------------
// ProcessCard
// ---------------------------------------------------------------------------

export function ProcessCard({
  isActive,
  thinking,
  isThinking,
  plan,
  toolCalls,
  messages,
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

  // 过滤出时序日志中需要展示的消息，并去重
  const timelineMessages = useMemo(() => {
    if (!messages || messages.length === 0) return []
    const filtered = messages.filter((m) => TIMELINE_TYPES.has(m.type))
    return deduplicateTimeline(filtered)
  }, [messages])

  const hasContent = thinking || plan || toolCalls.length > 0 || isThinking || isActive || timelineMessages.length > 0

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
          {/* Timeline — 按时序展示所有过程消息 */}
          {timelineMessages.length > 0 ? (
            <div className="border-t border-border-subtle/50 divide-y divide-border-subtle/30">
              {timelineMessages.map((msg) => (
                <TimelineEntry key={msg.id} message={msg} />
              ))}
            </div>
          ) : (
            <>
              {/* Fallback: 没有 messages 时使用旧的分组展示 */}
              {thinking && (
                <div className="px-4 py-3 border-t border-border-subtle/50">
                  <div className="flex items-start gap-2">
                    <Brain className="w-3.5 h-3.5 text-primary-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-text-secondary">{thinking.content}</span>
                  </div>
                </div>
              )}
              {toolCalls.length > 0 && (
                <div className="border-t border-border-subtle/50 divide-y divide-border-subtle/30">
                  {toolCalls.map((tc, i) => (
                    <div key={`${tc.toolName}-${i}`} className="flex items-center gap-2 py-1.5 px-3">
                      <Wrench className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                      <span className="text-xs font-mono text-text-primary">{tc.toolName}</span>
                      {tc.status === 'calling' && <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />}
                      {tc.status === 'success' && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Check className="w-3 h-3 text-success-500" />
                          {tc.duration != null && <span className="text-xs text-success-500">{(tc.duration / 1000).toFixed(1)}s</span>}
                        </div>
                      )}
                      {tc.status === 'error' && <XCircle className="w-3 h-3 text-error-500 shrink-0" />}
                    </div>
                  ))}
                </div>
              )}
            </>
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
