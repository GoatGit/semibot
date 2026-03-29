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
import { useLocale } from '@/components/providers/LocaleProvider'
import type {
  Agent2UIMessage,
  Agent2UIType,
  ThinkingData,
  PlanData,
  PlanStepData,
  ToolCallData,
  ToolResultData,
  SkillCallData,
  SkillResultData,
  McpCallData,
  McpResultData,
} from '@/types'

export interface ProcessCardProps {
  isActive: boolean
  awaitingApproval?: boolean
  thinking: ThinkingData | null
  isThinking: boolean
  plan: PlanData | null
  toolCalls: ToolCallData[]
  messages?: Agent2UIMessage[]
  className?: string
}

type CardStatus = 'active' | 'pending' | 'completed' | 'failed'

/** 需要在时序日志中展示的消息类型 */
const TIMELINE_TYPES = new Set<Agent2UIType>([
  'thinking',
  'plan',
  'plan_step',
  'tool_call',
  'tool_result',
  'skill_call',
  'skill_result',
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
function formatTime(timestamp: string, locale: string): string {
  try {
    const d = new Date(timestamp)
    return d.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function readStringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return null
}

function readStringArrayField(record: Record<string, unknown> | null, key: string): string[] {
  if (!record) return []
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function readNumberField(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function isPendingTimelineMessage(message: Agent2UIMessage): boolean {
  if (message.type !== 'tool_result') return false
  const data = message.data as ToolResultData
  const resultRecord = asRecord(data.result)
  if (data.error === 'approval_pending') return true
  if (String(resultRecord?.status ?? '').trim().toLowerCase() === 'pending') return true
  if (data.toolName === 'observe_dr' && String(resultRecord?.outcome ?? '').trim().toLowerCase() === 'awaiting_approval') {
    return true
  }
  if (data.toolName === 'direct_reasoning' && String(resultRecord?.status ?? '').trim().toLowerCase() === 'awaiting_approval') {
    return true
  }
  return false
}

function formatPlanMode(planMode: string | null, t: (key: string) => string): string {
  switch (planMode) {
    case 'initial':
      return t('agent2ui.process.skillOrchestration.planMode.initial')
    case 'incremental_replan':
      return t('agent2ui.process.skillOrchestration.planMode.incrementalReplan')
    case 'full_replan':
      return t('agent2ui.process.skillOrchestration.planMode.fullReplan')
    default:
      return t('agent2ui.process.skillOrchestration.planMode.unknown')
  }
}

function formatExecutionMode(mode: string | null, t: (key: string) => string): string {
  switch (mode) {
    case 'direct_answer':
      return t('agent2ui.process.route.mode.directAnswer')
    case 'direct_reasoning':
      return t('agent2ui.process.route.mode.directReasoning')
    case 'plan_act':
      return t('agent2ui.process.route.mode.planAct')
    case 'delegate':
      return t('agent2ui.process.route.mode.delegate')
    default:
      return t('agent2ui.process.route.mode.unknown')
  }
}

function formatObserveDrOutcome(outcome: string | null, t: (key: string) => string): string {
  switch (outcome) {
    case 'respond_success':
      return t('agent2ui.process.observeDr.outcome.respondSuccess')
    case 'respond_partial':
      return t('agent2ui.process.observeDr.outcome.respondPartial')
    case 'upgrade_to_plan_act':
      return t('agent2ui.process.observeDr.outcome.upgradeToPlanAct')
    default:
      return t('agent2ui.process.observeDr.outcome.unknown')
  }
}

// ---------------------------------------------------------------------------
// TimelineEntry — 每条时序日志的行内组件
// ---------------------------------------------------------------------------

function TimelineEntry({ message }: { message: Agent2UIMessage }) {
  const { locale, t } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const time = formatTime(message.timestamp, locale)
  const rowClass = 'group border-t border-border-subtle py-3 px-4 hover:bg-interactive-hover transition-colors'
  const timeClass = 'text-xs text-text-tertiary font-mono shrink-0 w-20'
  const detailButtonClass = 'text-xs text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity shrink-0'

  switch (message.type) {
    case 'thinking': {
      const data = message.data as ThinkingData
      const content = data.content || ''
      // 合并后的 thinking 可能包含多段（用 \n 分隔）
      const segments = content.split('\n').filter((s) => s.trim())
      const isMerged = segments.length > 1
      const needExpand = isMerged || content.length > 80
      const preview = isMerged
        ? truncate(segments[0], 60) + ` ${t('agent2ui.process.thinkingMergedExtra', { count: segments.length - 1 })}`
        : truncate(content, 80)
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <Brain className="w-4 h-4" />
            </div>
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
                  className="ml-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.expand')}
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    case 'plan': {
      const data = message.data as PlanData
      const stepTitles = data.steps
        .map((s) => (s?.title || '').trim())
        .filter((s) => s.length > 0)
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <ClipboardList className="w-4 h-4" />
            </div>
            <span className="text-sm font-medium text-text-primary">
              {t('agent2ui.process.planSummary', { count: data.steps.length })}
            </span>
          </div>
          {stepTitles.length > 0 && (
            <div className="mt-2 pl-28 space-y-1">
              {stepTitles.map((title, idx) => (
                <div key={`${message.id}-plan-${idx}`} className="text-xs text-text-tertiary truncate">
                  {idx + 1}. {title}
                </div>
              ))}
            </div>
          )}
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
        ? t('agent2ui.plan.status.completed')
        : data.status === 'running'
          ? t('agent2ui.plan.status.running')
          : data.status === 'failed'
            ? t('agent2ui.plan.status.failed')
            : t('agent2ui.plan.status.pending')
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <ClipboardList className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary flex-1 min-w-0 truncate">{data.title}</span>
            <div className="flex items-center gap-2 shrink-0">
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
        </div>
      )
    }

    case 'tool_call': {
      const data = message.data as ToolCallData
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <Wrench className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">{data.toolName}</span>
            {data.status === 'calling' && (
              <Loader2 className="w-4 h-4 text-primary-500 animate-spin shrink-0" />
            )}
            {data.status === 'success' && (
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                  <Check className="w-3 h-3 text-success-500" />
                </div>
                {data.duration != null && (
                  <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            )}
            {data.status === 'error' && (
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                  <XCircle className="w-3 h-3 text-error-500" />
                </div>
                <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
              </div>
            )}
          </div>
        </div>
      )
    }

    case 'tool_result': {
      const data = message.data as ToolResultData
      const resultRecord = asRecord(data.result)
      if (data.toolName === 'route') {
        const mode = formatExecutionMode(readStringField(resultRecord, 'mode'), t)
        const reason = readStringField(resultRecord, 'reason')
        const goal = readStringField(resultRecord, 'goal')
        const hasDetails = Boolean(reason || goal)
        return (
          <div className={rowClass}>
            <div className="flex items-center gap-4">
              <span className={timeClass}>{time}</span>
              <div className="text-text-tertiary shrink-0">
                <ClipboardList className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.route.title')}</span>
                  <span className="rounded-full bg-primary-500/10 px-2 py-0.5 text-xs text-primary-500">
                    {mode}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                  <Check className="w-3 h-3 text-success-500" />
                </div>
                {hasDetails && (
                  <button onClick={() => setExpanded(!expanded)} className={detailButtonClass}>
                    {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                  </button>
                )}
              </div>
            </div>
            {expanded && hasDetails && (
              <div className="mt-2 pl-28 space-y-1">
                {reason && (
                  <div className="text-xs text-text-tertiary whitespace-pre-wrap break-words">
                    {t('agent2ui.process.route.reason')}: {reason}
                  </div>
                )}
                {goal && (
                  <div className="text-xs text-text-tertiary whitespace-pre-wrap break-words">
                    {t('agent2ui.process.route.goal')}: {goal}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      }
      if (data.toolName === 'direct_reasoning') {
        const status = readStringField(resultRecord, 'status') || (data.success ? 'completed' : 'failed')
        const answer = readStringField(resultRecord, 'answer')
        const upgradeReason = readStringField(resultRecord, 'upgradeReason')
        const toolUsageRecord = asRecord(resultRecord?.toolUsage)
        const resourceUsageRecord = asRecord(resultRecord?.resourceUsage)
        const toolCalls =
          readNumberField(toolUsageRecord, 'tool_calls', 'toolCalls') ??
          readNumberField(resourceUsageRecord, 'tool_calls', 'toolCalls')
        const statusLabel =
          status === 'failed'
            ? t('agent2ui.process.directReasoning.status.failed')
            : status === 'partial'
              ? t('agent2ui.process.directReasoning.status.partial')
              : status === 'upgrade_required'
                ? t('agent2ui.process.directReasoning.status.upgradeRequired')
                : t('agent2ui.process.directReasoning.status.completed')
        return (
          <div className={rowClass}>
            <div className="flex items-center gap-4">
              <span className={timeClass}>{time}</span>
              <div className="text-text-tertiary shrink-0">
                <Brain className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.directReasoning.title')}</span>
                  <span className={clsx(
                    'rounded-full px-2 py-0.5 text-xs',
                    status === 'failed' ? 'bg-error-500/10 text-error-500' : 'bg-success-500/10 text-success-500',
                  )}>
                    {statusLabel}
                  </span>
                  {toolCalls != null && (
                    <span className="text-xs text-text-tertiary">
                      {t('agent2ui.process.directReasoning.toolCalls')}: {toolCalls}
                    </span>
                  )}
                </div>
                {answer && <div className="mt-1 text-xs text-text-tertiary truncate">{answer}</div>}
                {upgradeReason && (
                  <div className="mt-1 text-xs text-warning-500 truncate">
                    {t('agent2ui.process.directReasoning.upgradeReason')}: {upgradeReason}
                  </div>
                )}
                {!answer && data.error && <div className="mt-1 text-xs text-error-500 truncate">{data.error}</div>}
              </div>
            </div>
          </div>
        )
      }
      if (data.toolName === 'observe_dr') {
        const outcome = formatObserveDrOutcome(readStringField(resultRecord, 'outcome'), t)
        const reason = readStringField(resultRecord, 'reason')
        const upgradeReason = readStringField(resultRecord, 'upgradeReason')
        return (
          <div className={rowClass}>
            <div className="flex items-center gap-4">
              <span className={timeClass}>{time}</span>
              <div className="text-text-tertiary shrink-0">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.observeDr.title')}</span>
                  <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">
                    {outcome}
                  </span>
                </div>
                {reason && (
                  <div className="mt-1 text-xs text-text-tertiary truncate">
                    {t('agent2ui.process.observeDr.reason')}: {reason}
                  </div>
                )}
                {upgradeReason && (
                  <div className="mt-1 text-xs text-warning-500 truncate">
                    {t('agent2ui.process.observeDr.upgradeReason')}: {upgradeReason}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      }
      if (data.toolName === 'skill_orchestration') {
        const skillId =
          readStringField(
            resultRecord,
            'skill_context_skill_id',
            'selected_skill',
            'planner_loaded_skill_id',
            'loaded_skill_id'
          ) ||
          t('agent2ui.process.skillOrchestration.noSkill')
        const loadedSkillId = readStringField(resultRecord, 'loaded_skill_id')
        const plannerLoadedSkillId = readStringField(resultRecord, 'planner_loaded_skill_id')
        const selectedSkillKind = readStringField(resultRecord, 'selected_skill_kind')
        const planMode = formatPlanMode(readStringField(resultRecord, 'plan_mode'), t)
        const roundGoal = readStringField(resultRecord, 'round_goal')
        const observeOutcome = readStringField(resultRecord, 'observe_outcome')
        const observeReason = readStringField(resultRecord, 'observe_reason')
        const lastRejectionReason = readStringField(resultRecord, 'planner_last_rejection_reason')
        const stepTitles = readStringArrayField(resultRecord, 'step_titles')
        const rawStepCount = resultRecord?.step_count
        const stepCount =
          typeof rawStepCount === 'number'
            ? rawStepCount
            : (typeof rawStepCount === 'string' && Number.isFinite(Number(rawStepCount)) ? Number(rawStepCount) : stepTitles.length)
        const isReplan = resultRecord?.is_replan === true
        const isPlaceholderSummary =
          skillId === t('agent2ui.process.skillOrchestration.noSkill') &&
          planMode === t('agent2ui.process.skillOrchestration.planMode.unknown') &&
          stepCount <= 0 &&
          !selectedSkillKind &&
          !loadedSkillId &&
          !plannerLoadedSkillId &&
          !roundGoal &&
          !observeOutcome &&
          !observeReason &&
          !lastRejectionReason &&
          stepTitles.length === 0 &&
          !isReplan
        if (isPlaceholderSummary) {
          return null
        }
        const hasDetails = Boolean(
          roundGoal ||
          observeOutcome ||
          observeReason ||
          lastRejectionReason ||
          loadedSkillId ||
          plannerLoadedSkillId ||
          stepTitles.length > 0
        )

        return (
          <div className={rowClass}>
            <div className="flex items-center gap-4">
              <span className={timeClass}>{time}</span>
              <div className="text-text-tertiary shrink-0">
                <Wrench className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {t('agent2ui.process.skillOrchestration.title')}
                  </span>
                  {isReplan && (
                    <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">
                      {t('agent2ui.process.skillOrchestration.replan')}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-tertiary">
                  <span>{t('agent2ui.process.skillOrchestration.skill')}: {skillId}</span>
                  <span>{t('agent2ui.process.skillOrchestration.planMode.label')}: {planMode}</span>
                  <span>{t('agent2ui.process.skillOrchestration.stepCount')}: {stepCount}</span>
                  {selectedSkillKind && (
                    <span>{t('agent2ui.process.skillOrchestration.skillKind')}: {selectedSkillKind}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {data.success ? (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                      <Check className="w-3 h-3 text-success-500" />
                    </div>
                    {data.duration != null && (
                      <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                      <XCircle className="w-3 h-3 text-error-500" />
                    </div>
                    <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
                  </div>
                )}
                {hasDetails && (
                  <button onClick={() => setExpanded(!expanded)} className={detailButtonClass}>
                    {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                  </button>
                )}
              </div>
            </div>
            {stepTitles.length > 0 && (
              <div className="mt-2 pl-28 space-y-1">
                {stepTitles.slice(0, expanded ? stepTitles.length : 3).map((title, idx) => (
                  <div key={`${message.id}-skill-step-${idx}`} className="text-xs text-text-tertiary truncate">
                    {idx + 1}. {title}
                  </div>
                ))}
                {!expanded && stepTitles.length > 3 && (
                  <div className="text-xs text-text-tertiary">
                    {t('agent2ui.process.skillOrchestration.moreSteps', { count: stepTitles.length - 3 })}
                  </div>
                )}
              </div>
            )}
            {expanded && (roundGoal || observeOutcome || observeReason || lastRejectionReason) && (
              <div className="mt-2 pl-28 space-y-1 text-xs text-text-secondary">
                {roundGoal && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.roundGoal')}:</span> {roundGoal}
                  </div>
                )}
                {loadedSkillId && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.loadedSkill')}:</span> {loadedSkillId}
                  </div>
                )}
                {plannerLoadedSkillId && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.plannerLoadedSkill')}:</span> {plannerLoadedSkillId}
                  </div>
                )}
                {observeOutcome && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.observeOutcome')}:</span> {observeOutcome}
                  </div>
                )}
                {observeReason && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.observeReason')}:</span> {observeReason}
                  </div>
                )}
                {lastRejectionReason && (
                  <div>
                    <span className="text-text-tertiary">{t('agent2ui.process.skillOrchestration.lastRejection')}:</span> {lastRejectionReason}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      }
      const isPendingApproval =
        data.error === 'approval_pending' ||
        (resultRecord !== null &&
          String(resultRecord.status ?? '') === 'pending')
      const hasDetails =
        data.result !== undefined && data.result !== null
          ? true
          : typeof data.error === 'string' && data.error.trim().length > 0
      const detailText = data.result !== undefined && data.result !== null
        ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2))
        : (data.error || '')
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <Wrench className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">{data.toolName}</span>
            <div className="flex items-center gap-3 shrink-0 ml-auto">
              {isPendingApproval ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-warning-500 animate-spin" />
                  <span className="text-xs text-warning-500">{t('approvals.pending')}</span>
                </div>
              ) : data.success ? (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                    <Check className="w-3 h-3 text-success-500" />
                  </div>
                  {data.duration != null && (
                    <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                    <XCircle className="w-3 h-3 text-error-500" />
                  </div>
                  <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
                </div>
              )}
              {hasDetails && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className={detailButtonClass}
                >
                  {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                </button>
              )}
            </div>
          </div>
          {expanded && hasDetails && (
            <pre className={clsx(
              'mt-2 pl-28 text-xs font-mono p-3 overflow-x-auto max-h-40',
              isPendingApproval
                ? 'text-warning-500'
                : data.success
                  ? 'text-text-secondary'
                  : 'text-error-500',
            )}>
              {detailText}
            </pre>
          )}
        </div>
      )
    }

    case 'mcp_call': {
      const data = message.data as McpCallData
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-info-500 shrink-0">
              <Wrench className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">{data.toolName}</span>
            {data.status === 'calling' && (
              <Loader2 className="w-4 h-4 text-primary-500 animate-spin shrink-0" />
            )}
            {data.status === 'success' && (
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                  <Check className="w-3 h-3 text-success-500" />
                </div>
                {data.duration != null && (
                  <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            )}
            {data.status === 'error' && (
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                  <XCircle className="w-3 h-3 text-error-500" />
                </div>
                <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
              </div>
            )}
          </div>
        </div>
      )
    }

    case 'skill_call': {
      const data = message.data as SkillCallData
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <ClipboardList className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">
              {t('agent2ui.process.delegate.title')}: {data.skillName || data.skillId}
            </span>
            {data.status === 'calling' && (
              <Loader2 className="w-4 h-4 text-primary-500 animate-spin shrink-0" />
            )}
          </div>
        </div>
      )
    }

    case 'skill_result': {
      const data = message.data as SkillResultData
      const hasDetails =
        data.result !== undefined && data.result !== null
          ? true
          : typeof data.error === 'string' && data.error.trim().length > 0
      const detailText = data.result !== undefined && data.result !== null
        ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2))
        : (data.error || '')
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-text-tertiary shrink-0">
              <ClipboardList className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">
              {t('agent2ui.process.delegate.title')}: {data.skillName || data.skillId}
            </span>
            <div className="flex items-center gap-3 shrink-0 ml-auto">
              {data.success ? (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                    <Check className="w-3 h-3 text-success-500" />
                  </div>
                  {data.duration != null && (
                    <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                    <XCircle className="w-3 h-3 text-error-500" />
                  </div>
                  <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
                </div>
              )}
              {hasDetails && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className={detailButtonClass}
                >
                  {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                </button>
              )}
            </div>
          </div>
          {expanded && hasDetails && (
            <pre className={clsx(
              'mt-2 pl-28 text-xs font-mono p-3 overflow-x-auto max-h-40',
              data.success ? 'text-text-secondary' : 'text-error-500',
            )}>
              {detailText}
            </pre>
          )}
        </div>
      )
    }

    case 'mcp_result': {
      const data = message.data as McpResultData
      const hasDetails =
        data.result !== undefined && data.result !== null
          ? true
          : typeof data.error === 'string' && data.error.trim().length > 0
      const detailText = data.result !== undefined && data.result !== null
        ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2))
        : (data.error || '')
      return (
        <div className={rowClass}>
          <div className="flex items-center gap-4">
            <span className={timeClass}>{time}</span>
            <div className="text-info-500 shrink-0">
              <Wrench className="w-4 h-4" />
            </div>
            <span className="text-sm font-mono text-text-primary">{data.toolName}</span>
            <div className="flex items-center gap-3 shrink-0 ml-auto">
              {data.success ? (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center">
                    <Check className="w-3 h-3 text-success-500" />
                  </div>
                  {data.duration != null && (
                    <span className="text-xs text-text-tertiary">{(data.duration / 1000).toFixed(1)}s</span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center">
                    <XCircle className="w-3 h-3 text-error-500" />
                  </div>
                  <span className="text-xs text-text-tertiary">{t('agent2ui.process.failed')}</span>
                </div>
              )}
              {hasDetails && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className={detailButtonClass}
                >
                  {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                </button>
              )}
            </div>
          </div>
          {expanded && hasDetails && (
            <pre className={clsx(
              'mt-2 pl-28 text-xs font-mono p-3 overflow-x-auto max-h-40',
              data.success ? 'text-text-secondary' : 'text-error-500',
            )}>
              {detailText}
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
  awaitingApproval = false,
  thinking,
  isThinking,
  plan,
  toolCalls,
  messages,
  className,
}: ProcessCardProps) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(true)

  const isPendingToolCall = (tc: ToolCallData) =>
    tc.status === 'error' &&
    typeof tc.result === 'object' &&
    tc.result !== null &&
    String((tc.result as Record<string, unknown>).status ?? '') === 'pending'

  // Auto-expand when active, auto-collapse when done
  useEffect(() => {
    setExpanded(isActive)
  }, [isActive])

  const timelineMessages = useMemo(() => {
    if (!messages || messages.length === 0) return []
    const filtered = messages.filter((m) => TIMELINE_TYPES.has(m.type))
    return deduplicateTimeline(filtered)
  }, [messages])

  const pendingMessageCount = timelineMessages.filter((msg) => isPendingTimelineMessage(msg)).length
  const pendingCount = Math.max(toolCalls.filter((tc) => isPendingToolCall(tc)).length, pendingMessageCount)
  const failedCount = toolCalls.filter((tc) => tc.status === 'error' && !isPendingToolCall(tc)).length
  const hasFailure = failedCount > 0
  const hasPending = awaitingApproval || pendingCount > 0

  const status: CardStatus = isActive
    ? 'active'
    : hasPending
      ? 'pending'
      : hasFailure
      ? 'failed'
      : 'completed'

  const summary = useMemo(() => {
    const parts: string[] = []
    if (plan && plan.steps.length > 0) {
      parts.push(t('agent2ui.process.stepSummary', { count: plan.steps.length }))
    }
    if (toolCalls.length > 0) {
      parts.push(t('agent2ui.process.toolCallSummary', { count: toolCalls.length }))
    }
    if (failedCount > 0) {
      parts.push(t('agent2ui.process.failedSummary', { count: failedCount }))
    }
    if (hasPending) {
      parts.push(`${t('approvals.pending')} ${pendingCount > 0 ? pendingCount : 1} 项`)
    }
    return parts.join(t('agent2ui.process.summarySeparator'))
  }, [failedCount, hasPending, pendingCount, plan, t, toolCalls])

  const hasContent = thinking || plan || toolCalls.length > 0 || isThinking || isActive || timelineMessages.length > 0

  if (!hasContent) return null

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-2xl border transition-colors duration-200 bg-bg-elevated',
        status === 'active' && 'border-primary-500/20',
        status === 'pending' && 'border-warning-500/20',
        status === 'completed' && 'border-border-default',
        status === 'failed' && 'border-error-500/20',
        className
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          'flex items-center gap-3 px-6 py-4 cursor-pointer border-b border-border-subtle',
          'hover:bg-interactive-hover transition-colors'
        )}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {status === 'active' && (
          <>
            <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center shrink-0">
              <Brain className="w-3 h-3 text-success-500" />
            </div>
            <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.status.thinking')}</span>
            <div className="flex items-center gap-1 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '200ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" style={{ animationDelay: '400ms' }} />
            </div>
          </>
        )}
        {status === 'completed' && (
          <>
            <div className="w-5 h-5 rounded-full bg-success-500/10 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-3 h-3 text-success-500" />
            </div>
            <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.status.completed')}</span>
            {summary && (
              <span className="text-xs text-text-tertiary ml-2">{summary}</span>
            )}
          </>
        )}
        {status === 'pending' && (
          <>
            <div className="w-5 h-5 rounded-full bg-warning-500/10 flex items-center justify-center shrink-0">
              <AlertCircle className="w-3 h-3 text-warning-500" />
            </div>
            <span className="text-sm font-medium text-text-primary">{t('approvals.pending')}</span>
            {summary && (
              <span className="text-xs text-text-tertiary ml-2">{summary}</span>
            )}
          </>
        )}
        {status === 'failed' && (
          <>
            <div className="w-5 h-5 rounded-full bg-error-500/10 flex items-center justify-center shrink-0">
              <AlertCircle className="w-3 h-3 text-error-500" />
            </div>
            <span className="text-sm font-medium text-text-primary">{t('agent2ui.process.status.failed')}</span>
            {summary && (
              <span className="text-xs text-text-tertiary ml-2">{summary}</span>
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
            <div className="divide-y divide-border-subtle">
              {timelineMessages.map((msg) => (
                <TimelineEntry key={msg.id} message={msg} />
              ))}
            </div>
          ) : (
            <>
              {/* Fallback: 没有 messages 时使用旧的分组展示 */}
              {thinking && (
                <div className="border-t border-white/8 bg-black/10 px-4 py-3">
                  <div className="rounded-xl border border-white/8 bg-white/[0.015] px-3 py-2.5 flex items-start gap-2.5">
                    <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-lg bg-primary-500/12 ring-1 ring-primary-500/20 shrink-0">
                      <Brain className="w-3.5 h-3.5 text-primary-300" />
                    </div>
                    <span className="text-[12px] leading-5 text-text-secondary">{thinking.content}</span>
                  </div>
                </div>
              )}
              {toolCalls.length > 0 && (
                <div className="border-t border-white/8 bg-black/10 px-1 py-1.5">
                  {toolCalls.map((tc, i) => (
                    <div key={`${tc.toolName}-${i}`} className="mx-3 my-2 rounded-xl border border-white/8 bg-white/[0.015] px-3 py-2.5 flex items-center gap-2.5">
                      <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10 shrink-0">
                        <Wrench className="w-3.5 h-3.5 text-text-secondary" />
                      </div>
                      <span className="text-[12px] font-mono text-text-primary">{tc.toolName}</span>
                      {tc.status === 'calling' && <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />}
                      {tc.status === 'success' && (
                        <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
                          <Check className="w-3 h-3 text-success-500" />
                          {tc.duration != null && <span className="text-[11px] text-success-500">{(tc.duration / 1000).toFixed(1)}s</span>}
                        </div>
                      )}
                      {tc.status === 'error' && <XCircle className="ml-auto w-3 h-3 text-error-500 shrink-0" />}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Footer summary */}
          {summary && (
            <div className="px-6 py-4 border-t border-border-subtle">
              <span className="text-xs text-text-tertiary">{summary}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

ProcessCard.displayName = 'ProcessCard'
