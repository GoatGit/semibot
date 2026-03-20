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

type CardStatus = 'active' | 'pending' | 'completed' | 'failed'

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

// ---------------------------------------------------------------------------
// TimelineEntry — 每条时序日志的行内组件
// ---------------------------------------------------------------------------

function TimelineEntry({ message }: { message: Agent2UIMessage }) {
  const { locale, t } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const time = formatTime(message.timestamp, locale)
  const rowClass = 'mx-3 my-2 rounded-xl border border-white/8 bg-white/[0.015] px-3 py-2.5'
  const timeClass = 'text-[11px] text-text-tertiary/80 font-mono shrink-0 mt-0.5 w-[64px]'
  const detailButtonClass = 'ml-auto text-[11px] text-primary-400/90 hover:text-primary-300 transition-colors shrink-0'

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
          <div className="flex items-start gap-2.5">
            <span className={timeClass}>{time}</span>
            <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-lg bg-primary-500/12 ring-1 ring-primary-500/20 shrink-0">
              <Brain className="w-3.5 h-3.5 text-primary-300" />
            </div>
            <div className="flex-1 min-w-0">
              {expanded ? (
                <div className="space-y-1">
                  {segments.map((seg, i) => (
                    <p key={i} className="text-[12px] leading-5 text-text-secondary">{seg}</p>
                  ))}
                </div>
              ) : (
                <span className="text-[12px] leading-5 text-text-secondary">{preview}</span>
              )}
              {needExpand && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="ml-1 text-[11px] text-primary-400 hover:text-primary-300 transition-colors"
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
          <div className="flex items-center gap-2.5">
            <span className={timeClass}>{time}</span>
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/12 ring-1 ring-amber-500/20 shrink-0">
              <ClipboardList className="w-3.5 h-3.5 text-amber-300" />
            </div>
            <span className="text-[12px] font-medium text-text-primary">
              {t('agent2ui.process.planSummary', { count: data.steps.length })}
            </span>
          </div>
          {stepTitles.length > 0 && (
            <div className="mt-2 ml-[74px] space-y-1">
              {stepTitles.map((title, idx) => (
                <div key={`${message.id}-plan-${idx}`} className="text-[12px] leading-5 text-text-secondary truncate">
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
        <div className={clsx(rowClass, 'flex items-center gap-2.5')}>
          <span className={timeClass}>{time}</span>
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/12 ring-1 ring-amber-500/20 shrink-0">
            <ClipboardList className="w-3.5 h-3.5 text-amber-300" />
          </div>
          <span className="text-[12px] font-medium text-text-primary flex-1 min-w-0 truncate">{data.title}</span>
          <div className="flex items-center gap-1 shrink-0">
            {statusIcon}
            {statusLabel && (
              <span className={clsx(
                'text-[11px]',
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
        <div className={clsx(rowClass, 'flex items-center gap-2.5')}>
          <span className={timeClass}>{time}</span>
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10 shrink-0">
            <Wrench className="w-3.5 h-3.5 text-text-secondary" />
          </div>
          <span className="text-[12px] font-mono text-text-primary">{data.toolName}</span>
          {data.status === 'calling' && (
            <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />
          )}
          {data.status === 'success' && (
            <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
              <Check className="w-3 h-3 text-success-500" />
              {data.duration != null && (
                <span className="text-[11px] text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
          {data.status === 'error' && (
            <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-error-500/10 px-2 py-0.5 ring-1 ring-error-500/20">
              <XCircle className="w-3 h-3 text-error-500" />
              <span className="text-[11px] text-error-500">{t('agent2ui.process.failed')}</span>
            </div>
          )}
        </div>
      )
    }

    case 'tool_result': {
      const data = message.data as ToolResultData
      const resultRecord = asRecord(data.result)
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
            <div className="flex items-center gap-2.5">
              <span className={timeClass}>{time}</span>
              <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-500/12 ring-1 ring-cyan-500/20 shrink-0">
                <Wrench className="w-3.5 h-3.5 text-cyan-300" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-text-primary">
                    {t('agent2ui.process.skillOrchestration.title')}
                  </span>
                  {isReplan && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 ring-1 ring-amber-500/20">
                      {t('agent2ui.process.skillOrchestration.replan')}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                  <span>{t('agent2ui.process.skillOrchestration.skill')}: {skillId}</span>
                  <span>{t('agent2ui.process.skillOrchestration.planMode.label')}: {planMode}</span>
                  <span>{t('agent2ui.process.skillOrchestration.stepCount')}: {stepCount}</span>
                  {selectedSkillKind && (
                    <span>{t('agent2ui.process.skillOrchestration.skillKind')}: {selectedSkillKind}</span>
                  )}
                </div>
              </div>
              {data.success ? (
                <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
                  <Check className="w-3 h-3 text-success-500" />
                  {data.duration != null && (
                    <span className="text-[11px] text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
                  )}
                </div>
              ) : (
                <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-error-500/10 px-2 py-0.5 ring-1 ring-error-500/20">
                  <XCircle className="w-3 h-3 text-error-500" />
                  <span className="text-[11px] text-error-500">{t('agent2ui.process.failed')}</span>
                </div>
              )}
              {hasDetails && (
                <button onClick={() => setExpanded(!expanded)} className={detailButtonClass}>
                  {expanded ? t('agent2ui.process.collapse') : t('agent2ui.process.details')}
                </button>
              )}
            </div>
            {stepTitles.length > 0 && (
              <div className="mt-2 ml-[74px] space-y-1">
                {stepTitles.slice(0, expanded ? stepTitles.length : 3).map((title, idx) => (
                  <div key={`${message.id}-skill-step-${idx}`} className="text-[12px] leading-5 text-text-secondary truncate">
                    {idx + 1}. {title}
                  </div>
                ))}
                {!expanded && stepTitles.length > 3 && (
                  <div className="text-[11px] text-text-tertiary">
                    {t('agent2ui.process.skillOrchestration.moreSteps', { count: stepTitles.length - 3 })}
                  </div>
                )}
              </div>
            )}
            {expanded && (roundGoal || observeOutcome || observeReason || lastRejectionReason) && (
              <div className="mt-2 ml-[74px] space-y-1 rounded-xl border border-white/8 bg-bg-elevated p-3 text-[11px] leading-5 text-text-secondary">
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
          <div className="flex items-center gap-2.5">
            <span className={timeClass}>{time}</span>
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10 shrink-0">
              <Wrench className="w-3.5 h-3.5 text-text-secondary" />
            </div>
            <span className="text-[12px] font-mono text-text-primary">{data.toolName}</span>
            {isPendingApproval ? (
              <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 ring-1 ring-amber-500/20">
                <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
                <span className="text-[11px] text-amber-400">{t('approvals.pending')}</span>
              </div>
            ) : data.success ? (
              <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
                <Check className="w-3 h-3 text-success-500" />
                {data.duration != null && (
                  <span className="text-[11px] text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            ) : (
              <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-error-500/10 px-2 py-0.5 ring-1 ring-error-500/20">
                <XCircle className="w-3 h-3 text-error-500" />
                <span className="text-[11px] text-error-500">{t('agent2ui.process.failed')}</span>
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
          {expanded && hasDetails && (
            <pre className={clsx(
              'mt-2 ml-[74px] text-[11px] leading-5 font-mono p-3 rounded-xl overflow-x-auto max-h-40 border',
              isPendingApproval
                ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                : data.success
                  ? 'text-text-secondary bg-bg-elevated border-white/8'
                  : 'text-error-400 bg-error-500/10 border-error-500/20',
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
        <div className={clsx(rowClass, 'flex items-center gap-2.5')}>
          <span className={timeClass}>{time}</span>
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-500/12 ring-1 ring-violet-500/20 shrink-0">
            <Wrench className="w-3.5 h-3.5 text-violet-300" />
          </div>
          <span className="text-[12px] font-mono text-text-primary">{data.toolName}</span>
          {data.status === 'calling' && (
            <Loader2 className="w-3 h-3 text-primary-500 animate-spin shrink-0" />
          )}
          {data.status === 'success' && (
            <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
              <Check className="w-3 h-3 text-success-500" />
              {data.duration != null && (
                <span className="text-[11px] text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
          {data.status === 'error' && (
            <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-error-500/10 px-2 py-0.5 ring-1 ring-error-500/20">
              <XCircle className="w-3 h-3 text-error-500" />
              <span className="text-[11px] text-error-500">{t('agent2ui.process.failed')}</span>
            </div>
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
          <div className="flex items-center gap-2.5">
            <span className={timeClass}>{time}</span>
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-500/12 ring-1 ring-violet-500/20 shrink-0">
              <Wrench className="w-3.5 h-3.5 text-violet-300" />
            </div>
            <span className="text-[12px] font-mono text-text-primary">{data.toolName}</span>
            {data.success ? (
              <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-success-500/10 px-2 py-0.5 ring-1 ring-success-500/20">
                <Check className="w-3 h-3 text-success-500" />
                {data.duration != null && (
                  <span className="text-[11px] text-success-500">{(data.duration / 1000).toFixed(1)}s</span>
                )}
              </div>
            ) : (
              <div className="ml-auto flex items-center gap-1 shrink-0 rounded-full bg-error-500/10 px-2 py-0.5 ring-1 ring-error-500/20">
                <XCircle className="w-3 h-3 text-error-500" />
                <span className="text-[11px] text-error-500">{t('agent2ui.process.failed')}</span>
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
          {expanded && hasDetails && (
            <pre className={clsx(
              'mt-2 ml-[74px] text-[11px] leading-5 font-mono p-3 rounded-xl overflow-x-auto max-h-40 border',
              data.success ? 'text-text-secondary bg-bg-elevated border-white/8' : 'text-error-400 bg-error-500/10 border-error-500/20',
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

  const pendingCount = toolCalls.filter((tc) => isPendingToolCall(tc)).length
  const failedCount = toolCalls.filter((tc) => tc.status === 'error' && !isPendingToolCall(tc)).length
  const hasFailure = failedCount > 0
  const hasPending = pendingCount > 0

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
    if (pendingCount > 0) {
      parts.push(`${t('approvals.pending')} ${pendingCount} 项`)
    }
    return parts.join(t('agent2ui.process.summarySeparator'))
  }, [failedCount, pendingCount, plan, t, toolCalls])

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
        'overflow-hidden rounded-[20px] border transition-colors duration-200 shadow-[0_18px_60px_rgba(0,0,0,0.18)]',
        status === 'active' && 'border-primary-500/20 bg-[linear-gradient(180deg,rgba(59,130,246,0.10),rgba(59,130,246,0.03))]',
        status === 'pending' && 'border-amber-500/20 bg-[linear-gradient(180deg,rgba(245,158,11,0.10),rgba(245,158,11,0.03))]',
        status === 'completed' && 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))]',
        status === 'failed' && 'border-error-500/20 bg-[linear-gradient(180deg,rgba(239,68,68,0.10),rgba(239,68,68,0.03))]',
        className
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          'flex items-center gap-3 px-5 py-4 cursor-pointer',
          'hover:bg-white/[0.03] transition-colors duration-fast'
        )}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {status === 'active' && (
          <>
            <div className="relative flex-shrink-0">
              <Brain className="w-5 h-5 text-primary-400" />
              <span className="absolute inset-0 rounded-full bg-primary-500/30 animate-ping" />
            </div>
            <span className="text-[15px] font-semibold text-text-primary">{t('agent2ui.process.status.thinking')}</span>
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
            <span className="text-[15px] font-semibold text-text-primary">{t('agent2ui.process.status.completed')}</span>
            {summary && (
              <span className="text-[14px] text-text-tertiary ml-2">{summary}</span>
            )}
          </>
        )}
        {status === 'pending' && (
          <>
            <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <span className="text-[15px] font-semibold text-text-primary">{t('approvals.pending')}</span>
            {summary && (
              <span className="text-[14px] text-text-tertiary ml-2">{summary}</span>
            )}
          </>
        )}
        {status === 'failed' && (
          <>
            <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
            <span className="text-[15px] font-semibold text-text-primary">{t('agent2ui.process.status.failed')}</span>
            {summary && (
              <span className="text-[14px] text-text-tertiary ml-2">{summary}</span>
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
            <div className="border-t border-white/8 bg-black/10 px-1 py-1.5">
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
            <div className="px-5 py-3 bg-black/15 border-t border-white/8">
              <span className="text-[12px] text-text-tertiary">{summary}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

ProcessCard.displayName = 'ProcessCard'
