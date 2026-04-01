'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import clsx from 'clsx'
import {
  ArrowUpRight,
  Check,
  Copy,
  Cpu,
  RefreshCw,
  Search,
  Siren,
  TimerReset,
  Waves,
} from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { EmptyStateActions } from '@/components/ui/EmptyStateActions'
import { PageHelpStrip } from '@/components/ui/PageHelpStrip'
import { PageHeader } from '@/components/ui/PageHeader'
import { useRuntimeMonitor } from '@/hooks/useRuntimeMonitor'
import type { EventRecord, RuntimeAttemptView } from '@/types'
import { copyToClipboard } from '@/lib/utils'
import { useLayoutStore } from '@/stores/layoutStore'
import { apiClient } from '@/lib/api'
import { getEventAttemptId, getEventSessionId, readPayloadString, tailId } from '@/lib/runtime-attempt-ui'
import { buildAttemptDetailContent, buildAttemptDetailTitle } from '@/lib/runtime-attempt-detail'

function formatTime(dateString: string | null | undefined, locale: string): string {
  if (!dateString) return '--'
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale)
}

function getPayloadValue(payload: EventRecord['payload'], key: string): unknown {
  if (!payload || typeof payload !== 'object') return undefined
  if (!key.includes('.')) return payload[key]
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[part]
  }, payload)
}

function readPayloadNumber(payload: EventRecord['payload'], ...keys: string[]): number {
  for (const key of keys) {
    const value = getPayloadValue(payload, key)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

function numberCompact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

function humanizeReason(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
}

function getEventToolName(event: EventRecord): string {
  return readPayloadString(event.payload, 'tool_name', 'tool')
}

function getEventCapabilityId(event: EventRecord): string {
  return readPayloadString(event.payload, 'capability_id', 'capabilityId')
}

function getEventExecutionLabel(event: EventRecord): string {
  return getEventCapabilityId(event) || getEventToolName(event)
}

function getEventReason(event: EventRecord): string {
  return (
    humanizeReason(readPayloadString(event.payload, 'reason', 'message', 'summary', 'kind', 'failure_kind', 'family'))
    || humanizeReason(getEventToolName(event))
    || humanizeReason(event.eventType)
  )
}

function getRouteModeLabel(mode: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (mode) {
    case 'direct_answer':
      return t('runtimeMonitor.modes.directAnswer')
    case 'direct_reasoning':
      return t('runtimeMonitor.modes.directReasoning')
    case 'plan_act':
      return t('runtimeMonitor.modes.planAct')
    case 'delegate':
      return t('runtimeMonitor.modes.delegate')
    default:
      return humanizeReason(mode) || '--'
  }
}

function isLoopAlert(event: EventRecord): boolean {
  if (event.eventType !== 'runtime.signal') return false
  const text = [
    readPayloadString(event.payload, 'kind'),
    readPayloadString(event.payload, 'reason'),
    readPayloadString(event.payload, 'message'),
  ].join(' ')
  return /loop|repeat|repeated/i.test(text)
}

function isDrUpgrade(event: EventRecord): boolean {
  return event.eventType === 'observe_dr.upgrade_to_plan_act'
}

function isHighCostUsage(event: EventRecord): boolean {
  if (event.eventType !== 'llm.usage') return false
  return readPayloadNumber(event.payload, 'total_tokens', 'totalTokens') >= 12000
}

function runtimeEventLabel(eventType: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (eventType) {
    case 'runtime.signal':
      return t('runtimeMonitor.labels.runtimeSignal')
    case 'runtime.failure':
      return t('runtimeMonitor.labels.runtimeFailure')
    case 'act.heartbeat':
      return t('runtimeMonitor.labels.heartbeat')
    case 'llm.usage':
      return t('runtimeMonitor.labels.tokenUsage')
    case 'route.mode_selected':
      return t('runtimeMonitor.labels.routeDecision')
    case 'dr.completed':
      return t('runtimeMonitor.labels.directReasoning')
    case 'dr.failed':
      return t('runtimeMonitor.labels.directReasoning')
    case 'observe_dr.upgrade_to_plan_act':
      return t('runtimeMonitor.labels.drUpgrade')
    default:
      return eventType
  }
}

function runtimeEventVariant(event: EventRecord): 'default' | 'success' | 'warning' | 'error' | 'outline' {
  if (event.eventType === 'runtime.failure') return 'error'
  if (event.eventType === 'dr.failed') return 'error'
  if (isDrUpgrade(event)) return 'warning'
  if (isLoopAlert(event)) return 'warning'
  if (event.eventType === 'act.heartbeat') return 'success'
  if (event.eventType === 'dr.completed' || event.eventType === 'route.mode_selected') return 'success'
  if (event.eventType === 'runtime.signal') return 'outline'
  return 'default'
}

function timelineVariant(event: EventRecord): 'default' | 'success' | 'warning' | 'error' {
  const variant = runtimeEventVariant(event)
  if (variant === 'outline') return 'default'
  return variant
}

type RuntimeRow = {
  id: string
  raw: EventRecord
  badge: string
  badgeVariant: 'default' | 'success' | 'warning' | 'error' | 'outline'
  title: string
  detail: string
  sessionId: string
  toolName: string
  capabilityId: string
  createdAt: string
}

type DiagnosticCategory = 'stale' | 'loop' | 'upgrade' | 'failure' | 'cost' | 'healthy'

type SessionDiagnostic = {
  sessionId: string
  attemptId: string
  status: DiagnosticCategory
  statusLabel: string
  actionLabel: string
  summary: string
  lastSeenAt: string
  idleFor: string
  failures: number
  loopAlerts: number
  drUpgrades: number
  totalTokens: number
  toolName: string
  capabilityId: string
}

type GroupFilter = 'all' | 'stale' | 'loop' | 'drUpgrades' | 'retryable' | 'timeouts' | 'toolFailures'

type InsightCard = {
  key: string
  label: string
  value: string | number
  hint: string
  tone: 'warning' | 'error' | 'default'
  icon: React.ReactNode
}

type IncidentGroup = {
  key: string
  label: string
  count: number
  hint: string
  variant: 'outline' | 'warning' | 'error'
}

function buildRuntimeRow(event: EventRecord, t: (key: string, params?: Record<string, string | number>) => string): RuntimeRow {
  const toolName = getEventToolName(event)
  const capabilityId = getEventCapabilityId(event)
  const sessionId = getEventSessionId(event)
  const attemptId = getEventAttemptId(event)
  const detailParts = [
    runtimeEventLabel(event.eventType, t),
    toolName ? `${t('runtimeMonitor.labels.toolName')}: ${toolName}` : '',
    capabilityId ? `Capability: ${capabilityId}` : '',
    sessionId ? `${t('runtimeMonitor.labels.sessionId')}: ${tailId(sessionId, 8)}` : '',
    attemptId ? `Attempt: ${tailId(attemptId, 8)}` : '',
  ].filter(Boolean)
  return {
    id: event.id,
    raw: event,
    badge: runtimeEventLabel(event.eventType, t),
    badgeVariant: runtimeEventVariant(event),
    title: getEventReason(event),
    detail: detailParts.join(' · '),
    sessionId,
    toolName,
    capabilityId,
    createdAt: event.createdAt,
  }
}

function buildRuntimePathTransitions(
  events: EventRecord[],
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): Array<{
  id: string
  title: string
  detail: string
  createdAt: string
  variant: 'default' | 'success' | 'warning' | 'error'
}> {
  return events
    .filter((event) =>
      event.eventType === 'route.mode_selected'
      || event.eventType === 'dr.completed'
      || event.eventType === 'dr.failed'
      || event.eventType === 'observe_dr.upgrade_to_plan_act'
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((event) => {
      if (event.eventType === 'route.mode_selected') {
        const mode = getRouteModeLabel(readPayloadString(event.payload, 'mode'), t)
        return {
          id: event.id,
          title: t('runtimeMonitor.labels.routeDecision'),
          detail: [mode, readPayloadString(event.payload, 'reason')].filter(Boolean).join(' · '),
          createdAt: formatTime(event.createdAt, locale),
          variant: 'success',
        }
      }
      if (event.eventType === 'observe_dr.upgrade_to_plan_act') {
        return {
          id: event.id,
          title: t('runtimeMonitor.labels.drUpgrade'),
          detail: readPayloadString(event.payload, 'reason') || t('runtimeMonitor.diagnostics.upgradeSummary', { count: 1 }),
          createdAt: formatTime(event.createdAt, locale),
          variant: 'warning',
        }
      }
      return {
        id: event.id,
        title: t('runtimeMonitor.labels.directReasoning'),
        detail: [
          humanizeReason(readPayloadString(event.payload, 'status')) || getEventReason(event),
          readPayloadString(event.payload, 'upgrade_reason'),
          readPayloadNumber(event.payload, 'resource_usage.tool_calls', 'tool_calls') > 0
            ? `${t('runtimeMonitor.labels.toolCalls')}: ${readPayloadNumber(event.payload, 'resource_usage.tool_calls', 'tool_calls')}`
            : '',
          readPayloadNumber(event.payload, 'resource_usage.tokens', 'tokens') > 0
            ? `${t('runtimeMonitor.labels.tokens')}: ${numberCompact(readPayloadNumber(event.payload, 'resource_usage.tokens', 'tokens'))}`
            : '',
        ].filter(Boolean).join(' · '),
        createdAt: formatTime(event.createdAt, locale),
        variant: timelineVariant(event),
      }
    })
}

function pickFocusEventIdForGroup(
  events: EventRecord[],
  group: GroupFilter | 'default',
): string | undefined {
  const ordered = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const match = ordered.find((event) => {
    if (group === 'drUpgrades') return isDrUpgrade(event)
    if (group === 'loop') return isLoopAlert(event)
    if (group === 'retryable') {
      return event.eventType === 'runtime.failure' && /retry|timeout|rate limit|overflow|temporary/i.test(getEventReason(event))
    }
    if (group === 'timeouts') return event.eventType === 'runtime.failure' && /timeout/i.test(getEventReason(event))
    if (group === 'toolFailures') return event.eventType === 'runtime.failure' && !!getEventExecutionLabel(event)
    if (group === 'stale') return event.eventType === 'act.heartbeat'
    return isDrUpgrade(event) || event.eventType === 'dr.failed' || event.eventType === 'runtime.failure' || isLoopAlert(event) || event.eventType === 'route.mode_selected'
  })
  return match?.id
}

function normalizeGenericEvents(raw: unknown): EventRecord[] {
  if (!raw || typeof raw !== 'object') return []
  const source = raw as Record<string, unknown>
  const items = Array.isArray(source.items) ? source.items : []
  const normalized: Array<EventRecord | null> = items.map((item): EventRecord | null => {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : typeof row.event_id === 'string' ? row.event_id : ''
    const eventType = typeof row.eventType === 'string' ? row.eventType : typeof row.event_type === 'string' ? row.event_type : ''
    const createdAt =
      typeof row.createdAt === 'string'
        ? row.createdAt
        : typeof row.created_at === 'string'
          ? row.created_at
          : typeof row.timestamp === 'string'
            ? row.timestamp
            : ''
    if (!id || !eventType || !createdAt) return null
    return {
      id,
      eventType,
      source: typeof row.source === 'string' ? row.source : 'runtime',
      subject: typeof row.subject === 'string' ? row.subject : undefined,
      payload: row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : undefined,
      riskHint:
        typeof row.riskHint === 'string'
          ? (row.riskHint as EventRecord['riskHint'])
          : typeof row.risk_hint === 'string'
            ? (row.risk_hint as EventRecord['riskHint'])
            : undefined,
      createdAt,
    }
  })
  return normalized.filter((item): item is EventRecord => item !== null)
}

function buildSessionDiagnostics(snapshot: ReturnType<typeof useRuntimeMonitor>['snapshot'], t: (key: string, params?: Record<string, string | number>) => string): SessionDiagnostic[] {
  const staleMap = new Map(snapshot.staleSessions.map((session) => [session.sessionId, session]))
  const bySession = new Map<string, EventRecord[]>()
  for (const event of snapshot.timeline) {
    const sessionId = getEventSessionId(event)
    if (!sessionId) continue
    const bucket = bySession.get(sessionId) ?? []
    bucket.push(event)
    bySession.set(sessionId, bucket)
  }

  return Array.from(bySession.entries())
    .map(([sessionId, events]) => {
      const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const lastEvent = sorted[0]
      const failures = sorted.filter((event) => event.eventType === 'runtime.failure').length
      const loopAlerts = sorted.filter(isLoopAlert).length
      const drUpgrades = sorted.filter(isDrUpgrade).length
      const totalTokens = sorted.reduce((sum, event) => sum + readPayloadNumber(event.payload, 'total_tokens', 'totalTokens'), 0)
      const stale = staleMap.get(sessionId)
      let status: DiagnosticCategory = 'healthy'
      if (stale) status = 'stale'
      else if (loopAlerts > 0) status = 'loop'
      else if (drUpgrades > 0) status = 'upgrade'
      else if (failures > 0) status = 'failure'
      else if (totalTokens >= 12000) status = 'cost'

      const statusLabel =
        status === 'stale'
          ? t('runtimeMonitor.statuses.stale')
          : status === 'loop'
            ? t('runtimeMonitor.statuses.looping')
            : status === 'upgrade'
              ? t('runtimeMonitor.statuses.upgraded')
            : status === 'failure'
              ? t('runtimeMonitor.statuses.failure')
              : status === 'cost'
                ? t('runtimeMonitor.statuses.expensive')
                : t('runtimeMonitor.statuses.healthy')

      const actionLabel =
        status === 'stale'
          ? t('runtimeMonitor.actions.inspectHeartbeat')
          : status === 'loop'
            ? t('runtimeMonitor.actions.inspectLoop')
            : status === 'upgrade'
              ? t('runtimeMonitor.actions.inspectUpgrade')
            : status === 'failure'
              ? t('runtimeMonitor.actions.inspectFailure')
              : status === 'cost'
                ? t('runtimeMonitor.actions.inspectCost')
                : t('runtimeMonitor.actions.monitorOnly')

      const toolName = getEventToolName(lastEvent)
      const capabilityId = getEventCapabilityId(lastEvent)
      const summary =
        status === 'stale'
          ? t('runtimeMonitor.diagnostics.staleSummary')
          : status === 'loop'
            ? t('runtimeMonitor.diagnostics.loopSummary', { count: loopAlerts })
            : status === 'upgrade'
              ? t('runtimeMonitor.diagnostics.upgradeSummary', { count: drUpgrades })
            : status === 'failure'
              ? t('runtimeMonitor.diagnostics.failureSummary', { count: failures })
              : status === 'cost'
                ? t('runtimeMonitor.diagnostics.costSummary', { count: numberCompact(totalTokens) })
                : t('runtimeMonitor.diagnostics.healthySummary')

      return {
        sessionId,
        attemptId: getEventAttemptId(lastEvent),
        status,
        statusLabel,
        actionLabel,
        summary,
        lastSeenAt: lastEvent.createdAt,
        idleFor: stale ? formatAgeSeconds(stale.ageSeconds) : t('runtimeMonitor.labels.justNow'),
        failures,
        loopAlerts,
        drUpgrades,
        totalTokens,
        toolName,
        capabilityId,
      }
    })
    .sort((a, b) => {
      const order: Record<DiagnosticCategory, number> = { stale: 0, loop: 1, upgrade: 2, failure: 3, cost: 4, healthy: 5 }
      return order[a.status] - order[b.status] || b.lastSeenAt.localeCompare(a.lastSeenAt)
    })
}

function buildIncidentGroups(snapshot: ReturnType<typeof useRuntimeMonitor>['snapshot'], t: (key: string, params?: Record<string, string | number>) => string): IncidentGroup[] {
  const timeoutFailures = snapshot.failures.filter((event) => /timeout/i.test(getEventReason(event))).length
  const toolFailures = snapshot.failures.filter((event) => !!getEventExecutionLabel(event)).length
  return [
    {
      key: 'stale',
      label: t('runtimeMonitor.groups.staleSessions'),
      count: snapshot.staleSessions.length,
      hint: t('runtimeMonitor.groups.staleSessionsHint'),
      variant: snapshot.staleSessions.length > 0 ? 'warning' : 'outline',
    },
    {
      key: 'loop',
      label: t('runtimeMonitor.groups.loopAlerts'),
      count: snapshot.summary.loopAlertCount,
      hint: t('runtimeMonitor.groups.loopAlertsHint'),
      variant: snapshot.summary.loopAlertCount > 0 ? 'warning' : 'outline',
    },
    {
      key: 'drUpgrades',
      label: t('runtimeMonitor.groups.drUpgrades'),
      count: snapshot.summary.drUpgradeCount,
      hint: t('runtimeMonitor.groups.drUpgradesHint'),
      variant: snapshot.summary.drUpgradeCount > 0 ? 'warning' : 'outline',
    },
    {
      key: 'retryable',
      label: t('runtimeMonitor.groups.retryableFailures'),
      count: snapshot.summary.retryableFailureCount,
      hint: t('runtimeMonitor.groups.retryableFailuresHint'),
      variant: snapshot.summary.retryableFailureCount > 0 ? 'error' : 'outline',
    },
    {
      key: 'timeouts',
      label: t('runtimeMonitor.groups.timeoutFailures'),
      count: timeoutFailures,
      hint: t('runtimeMonitor.groups.timeoutFailuresHint'),
      variant: timeoutFailures > 0 ? 'error' : 'outline',
    },
    {
      key: 'toolFailures',
      label: t('runtimeMonitor.groups.toolFailures'),
      count: toolFailures,
      hint: t('runtimeMonitor.groups.toolFailuresHint'),
      variant: toolFailures > 0 ? 'warning' : 'outline',
    },
  ]
}

function buildInsightCards(
  snapshot: ReturnType<typeof useRuntimeMonitor>['snapshot'],
  diagnostics: SessionDiagnostic[],
  t: (key: string, params?: Record<string, string | number>) => string,
): InsightCard[] {
  const staleCount = diagnostics.filter((item) => item.status === 'stale').length
  const loopCount = diagnostics.filter((item) => item.status === 'loop').length
  const upgradeCount = diagnostics.filter((item) => item.status === 'upgrade').length
  const costCount = diagnostics.filter((item) => item.status === 'cost').length
  const actionable = diagnostics.filter((item) => item.status !== 'healthy').length
  return [
    {
      key: 'actionable',
      label: t('runtimeMonitor.cards.actionable'),
      value: actionable,
      hint: t('runtimeMonitor.cards.actionableHint'),
      tone: actionable > 0 ? 'warning' : 'default',
      icon: <Siren size={18} />,
    },
    {
      key: 'stalled',
      label: t('runtimeMonitor.cards.stalled'),
      value: staleCount,
      hint: t('runtimeMonitor.cards.stalledHint'),
      tone: staleCount > 0 ? 'warning' : 'default',
      icon: <TimerReset size={18} />,
    },
    {
      key: 'loops',
      label: t('runtimeMonitor.cards.looping'),
      value: loopCount,
      hint: t('runtimeMonitor.cards.loopingHint'),
      tone: loopCount > 0 ? 'warning' : 'default',
      icon: <Waves size={18} />,
    },
    {
      key: 'cost',
      label: t('runtimeMonitor.cards.expensive'),
      value: costCount,
      hint: t('runtimeMonitor.cards.expensiveHint', { value: numberCompact(snapshot.summary.totalTokens24h) }),
      tone: costCount > 0 ? 'error' : 'default',
      icon: <Cpu size={18} />,
    },
    {
      key: 'dr',
      label: t('runtimeMonitor.cards.directReasoning'),
      value: snapshot.summary.drRunCount,
      hint: t('runtimeMonitor.cards.directReasoningHint', { value: upgradeCount }),
      tone: upgradeCount > 0 ? 'warning' : 'default',
      icon: <Check size={18} />,
    },
  ]
}

function detailBorder(status: DiagnosticCategory): string {
  switch (status) {
    case 'stale':
      return 'border-warning-500/40 bg-warning-500/6'
    case 'loop':
      return 'border-warning-500/30 bg-warning-500/5'
    case 'upgrade':
      return 'border-brand-500/30 bg-brand-500/5'
    case 'failure':
      return 'border-error-500/35 bg-error-500/5'
    case 'cost':
      return 'border-brand-500/30 bg-brand-500/5'
    default:
      return 'border-border-subtle bg-bg-base'
  }
}

function toneClasses(tone: InsightCard['tone']): string {
  switch (tone) {
    case 'warning':
      return 'border-warning-500/30 bg-warning-500/6'
    case 'error':
      return 'border-error-500/30 bg-error-500/5'
    default:
      return 'border-border-default'
  }
}

function cardFilterTarget(key: InsightCard['key']): GroupFilter | null {
  switch (key) {
    case 'stalled':
      return 'stale'
    case 'loops':
      return 'loop'
    case 'dr':
      return 'drUpgrades'
    default:
      return null
  }
}

function routeModeBadgeVariant(value: number): 'outline' | 'success' | 'warning' {
  if (value <= 0) return 'outline'
  return value >= 5 ? 'warning' : 'success'
}

export default function RuntimePage() {
  const { locale, t } = useLocale()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { snapshot, isLoading, error, loadRuntimeMonitor } = useRuntimeMonitor()
  const { openDetailContent } = useLayoutStore()
  const queryGroup = searchParams.get('group')
  const queryCapability = searchParams.get('capability')
  const isValidGroup = (value: string | null): value is GroupFilter =>
    value === 'all' || value === 'stale' || value === 'loop' || value === 'drUpgrades' || value === 'retryable' || value === 'timeouts' || value === 'toolFailures'
  const [sessionId, setSessionId] = useState('')
  const [capabilityQuery, setCapabilityQuery] = useState(queryCapability ?? '')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [eventsDrawerLoading, setEventsDrawerLoading] = useState(false)
  const [activeGroup, setActiveGroup] = useState<GroupFilter>(isValidGroup(queryGroup) ? queryGroup : 'all')

  useEffect(() => {
    const next = isValidGroup(queryGroup) ? queryGroup : 'all'
    setActiveGroup((current) => (current === next ? current : next))
  }, [queryGroup])

  useEffect(() => {
    const next = queryCapability ?? ''
    setCapabilityQuery((current) => (current === next ? current : next))
  }, [queryCapability])

  const updateActiveGroup = useCallback((next: GroupFilter) => {
    setActiveGroup(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('group')
    else params.set('group', next)
    if (capabilityQuery.trim()) params.set('capability', capabilityQuery.trim())
    else params.delete('capability')
    const query = params.toString()
    router.replace(query ? `/runtime?${query}` : '/runtime', { scroll: false })
  }, [capabilityQuery, router, searchParams])

  const updateCapabilityQuery = useCallback((next: string) => {
    setCapabilityQuery(next)
    const params = new URLSearchParams(searchParams.toString())
    if (activeGroup === 'all') params.delete('group')
    else params.set('group', activeGroup)
    if (next.trim()) params.set('capability', next.trim())
    else params.delete('capability')
    const query = params.toString()
    router.replace(query ? `/runtime?${query}` : '/runtime', { scroll: false })
  }, [activeGroup, router, searchParams])

  const refresh = useCallback(async () => {
    await loadRuntimeMonitor({
      limit: 200,
      sessionId: sessionId.trim() || undefined,
      capability: capabilityQuery.trim() || undefined,
    })
  }, [capabilityQuery, loadRuntimeMonitor, sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const diagnostics = useMemo(() => buildSessionDiagnostics(snapshot, t), [snapshot, t])
  const filteredDiagnostics = diagnostics
  const filteredTimeline = snapshot.timeline
  const filteredStaleSessions = snapshot.staleSessions
  const filteredSnapshot = snapshot
  const insightCards = useMemo(() => buildInsightCards(filteredSnapshot, filteredDiagnostics, t), [filteredSnapshot, filteredDiagnostics, t])
  const incidentGroups = useMemo(() => buildIncidentGroups(filteredSnapshot, t), [filteredSnapshot, t])
  const incidentRows = useMemo(() => {
    const base = filteredTimeline.filter((event) => event.eventType === 'runtime.failure' || isLoopAlert(event) || isHighCostUsage(event) || isDrUpgrade(event))
    const filtered = base.filter((event) => {
      if (activeGroup === 'all') return true
      if (activeGroup === 'stale') {
        const id = getEventSessionId(event)
        return !!id && filteredStaleSessions.some((session) => session.sessionId === id)
      }
      if (activeGroup === 'loop') return isLoopAlert(event)
      if (activeGroup === 'drUpgrades') return isDrUpgrade(event)
      if (activeGroup === 'retryable') return event.eventType === 'runtime.failure' && /retry|timeout|rate limit|overflow|temporary/i.test(getEventReason(event))
      if (activeGroup === 'timeouts') return event.eventType === 'runtime.failure' && /timeout/i.test(getEventReason(event))
      if (activeGroup === 'toolFailures') return event.eventType === 'runtime.failure' && !!getEventExecutionLabel(event)
      return true
    })
    return filtered.slice(0, 10).map((event) => buildRuntimeRow(event, t))
  }, [activeGroup, filteredStaleSessions, filteredTimeline, t])
  const actionableSessions = useMemo(() => {
    const base = filteredDiagnostics.filter((item) => item.status !== 'healthy')
    const filtered = base.filter((item) => {
      if (activeGroup === 'all') return true
      if (activeGroup === 'stale') return item.status === 'stale'
      if (activeGroup === 'loop') return item.status === 'loop'
      if (activeGroup === 'drUpgrades') return item.status === 'upgrade'
      if (activeGroup === 'retryable' || activeGroup === 'timeouts' || activeGroup === 'toolFailures') return item.status === 'failure'
      return true
    })
    return filtered.slice(0, 8)
  }, [activeGroup, filteredDiagnostics])

  const handleCopyEvent = useCallback(async (event: EventRecord) => {
    const ok = await copyToClipboard(JSON.stringify(event, null, 2))
    if (!ok) return
    setCopiedId(event.id)
    window.setTimeout(() => {
      setCopiedId((current) => (current === event.id ? null : current))
    }, 1500)
  }, [])

  const handleCopySession = useCallback(async (value: string) => {
    const ok = await copyToClipboard(value)
    if (!ok) return
    setCopiedId(`session:${value}`)
    window.setTimeout(() => {
      setCopiedId((current) => (current === `session:${value}` ? null : current))
    }, 1500)
  }, [])

  const handleCopyAttempt = useCallback(async (value: string) => {
    const ok = await copyToClipboard(value)
    if (!ok) return
    setCopiedId(`attempt:${value}`)
    window.setTimeout(() => {
      setCopiedId((current) => (current === `attempt:${value}` ? null : current))
    }, 1500)
  }, [])

  const openAttemptDetail = useCallback((attemptId: string) => {
    void (async () => {
      try {
        const response = await apiClient.get<{ success?: boolean; data?: RuntimeAttemptView }>(`/sessions/attempts/${encodeURIComponent(attemptId)}`)
        const view = response?.data
        if (!view) return
        openDetailContent(buildAttemptDetailContent(view, locale))
      } catch (error) {
        openDetailContent({
          kind: 'markdown',
          title: buildAttemptDetailTitle(attemptId),
          filename: `attempt-${attemptId}.md`,
          content: [
            `# Attempt ${attemptId}`,
            '',
            '加载 attempt 详情失败。',
            '',
            '```text',
            error instanceof Error ? error.message : String(error),
            '```',
          ].join('\n'),
        })
      }
    })()
  }, [locale, openDetailContent])

  const openSessionRuntimeDetail = useCallback((value: string, focusEventId?: string) => {
    void (async () => {
    const diagnostic = diagnostics.find((item) => item.sessionId === value)
    const relatedEvents = snapshot.timeline
      .filter((event) => getEventSessionId(event) === value)
    const latestAttemptId =
      relatedEvents
        .map((event) => getEventAttemptId(event))
        .find((candidate) => candidate) || ''
    let attemptView: RuntimeAttemptView | null = null
    if (latestAttemptId) {
      try {
        attemptView = await apiClient.get<RuntimeAttemptView>(`/sessions/attempts/${encodeURIComponent(latestAttemptId)}`)
      } catch {
        attemptView = null
      }
    }
    const keyTransitionIds = new Set(
      relatedEvents
        .filter((event) =>
          event.eventType === 'route.mode_selected'
          || event.eventType === 'dr.completed'
          || event.eventType === 'dr.failed'
          || event.eventType === 'observe_dr.upgrade_to_plan_act'
        )
        .map((event) => event.id),
    )
    const incidentEvents = Array.from(
      new Map(
        [...relatedEvents.slice(0, 20), ...relatedEvents.filter((event) => keyTransitionIds.has(event.id))].map((event) => [event.id, event]),
      ).values(),
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const related = incidentEvents
      .map((event) => {
        const toolName = getEventToolName(event)
        const capabilityId = getEventCapabilityId(event)
        return {
          id: event.id,
          type: event.eventType,
          title: getEventReason(event),
          detail: [
            toolName ? `${t('runtimeMonitor.labels.toolName')}: ${toolName}` : '',
            capabilityId ? `Capability: ${capabilityId}` : '',
            `${t('runtimeMonitor.labels.sessionId')}: ${tailId(value, 8)}`,
            latestAttemptId ? `Attempt: ${tailId(getEventAttemptId(event) || latestAttemptId, 8)}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          createdAt: formatTime(event.createdAt, locale),
          raw: event as unknown as Record<string, unknown>,
        }
      })

    const routeEvent = relatedEvents.find((event) => event.eventType === 'route.mode_selected')
    const drCompletedEvent = relatedEvents.find((event) => event.eventType === 'dr.completed')
    const drFailedEvent = relatedEvents.find((event) => event.eventType === 'dr.failed')
    const drEvent = drCompletedEvent || drFailedEvent
    const drUpgradeEvent = relatedEvents.find((event) => event.eventType === 'observe_dr.upgrade_to_plan_act')
    const latestFailureEvent = relatedEvents.find((event) => event.eventType === 'runtime.failure')
    const routeMode = readPayloadString(routeEvent?.payload, 'mode')
    const routeReason = readPayloadString(routeEvent?.payload, 'reason')
    const drStatus = readPayloadString(drEvent?.payload, 'status')
    const drReason =
      readPayloadString(drUpgradeEvent?.payload, 'reason')
      || readPayloadString(drEvent?.payload, 'upgrade_reason')
      || getEventReason(drEvent || routeEvent || { eventType: '', payload: {}, createdAt: '', id: '', source: 'runtime' })
    const pathTransitions = buildRuntimePathTransitions(relatedEvents, locale, t)
    const initialFocusedIncidentId =
      focusEventId
      || drUpgradeEvent?.id
      || drFailedEvent?.id
      || latestFailureEvent?.id
      || drCompletedEvent?.id
      || routeEvent?.id

    openDetailContent({
      kind: 'runtime-session',
      title: t('runtimeMonitor.sessionDrawer.title'),
      sessionId: value,
      attemptId: latestAttemptId || undefined,
      latestRevision: attemptView?.attempt.latestRevision,
      latestCheckpointRevision: attemptView?.latestCheckpoint?.revision,
      latestCheckpointStatus: attemptView?.latestCheckpoint?.status,
      pendingEventOutboxCount: attemptView?.eventOutbox.filter((item) => item.status !== 'delivered').length ?? 0,
      pendingCheckpointOutboxCount: attemptView?.checkpointOutbox.filter((item) => item.status !== 'delivered').length ?? 0,
      terminalReason: attemptView?.attempt.terminalReason,
      statusLabel: diagnostic?.statusLabel || t('runtimeMonitor.statuses.healthy'),
      actionLabel: diagnostic?.actionLabel || t('runtimeMonitor.actions.monitorOnly'),
      summary: diagnostic?.summary || t('runtimeMonitor.diagnostics.healthySummary'),
      lastSeenAt: diagnostic ? formatTime(diagnostic.lastSeenAt, locale) : '--',
      idleFor: diagnostic?.idleFor || '--',
      failures: diagnostic?.failures || 0,
      loopAlerts: diagnostic?.loopAlerts || 0,
      drUpgrades: diagnostic?.drUpgrades || 0,
      totalTokens: numberCompact(diagnostic?.totalTokens || 0),
      toolName: diagnostic?.toolName || '',
      capabilityId: diagnostic?.capabilityId || '',
      routeMode: routeMode ? getRouteModeLabel(routeMode, t) : '--',
      routeReason: routeReason || '--',
      routeAt: routeEvent ? formatTime(routeEvent.createdAt, locale) : '--',
      drStatus: drStatus ? humanizeReason(drStatus) : '--',
      drReason: drReason || '--',
      drAt: drEvent ? formatTime(drEvent.createdAt, locale) : '--',
      upgradeAt: drUpgradeEvent ? formatTime(drUpgradeEvent.createdAt, locale) : '--',
      upgradeReason: readPayloadString(drUpgradeEvent?.payload, 'reason') || '--',
      initialFocusedIncidentId,
      pathTransitions,
      incidents: related,
    })
    })()
  }, [diagnostics, locale, openDetailContent, snapshot.timeline, t])

  const openChatSession = useCallback((value: string) => {
    router.push(`/chat/${value}`)
  }, [router])

  const openEventsDrawer = useCallback(() => {
    openDetailContent({
      kind: 'markdown',
      title: t('runtimeMonitor.drawer.title'),
      filename: 'events-center.md',
      content: `# ${t('runtimeMonitor.drawer.title')}\n\n${t('runtimeMonitor.drawer.loading')}`,
    })
    setEventsDrawerLoading(true)
    void (async () => {
      try {
        const response = await apiClient.get<unknown>('/events', { params: { limit: 50 } })
        const events = normalizeGenericEvents(response)
        const blocks = events.map((event) => {
          const summary = humanizeReason(readPayloadString(event.payload, 'message', 'summary', 'reason', 'status')) || humanizeReason(event.eventType)
          const toolName = readPayloadString(event.payload, 'tool_name', 'tool')
          const capabilityId = readPayloadString(event.payload, 'capability_id', 'capabilityId')
          const session = readPayloadString(event.payload, 'session_id', 'sessionId')
          return [
            `## ${summary}`,
            `- ${t('runtimeMonitor.drawer.fields.type')}: \`${event.eventType}\``,
            `- ${t('runtimeMonitor.drawer.fields.time')}: ${formatTime(event.createdAt, locale)}`,
            event.source ? `- ${t('runtimeMonitor.drawer.fields.source')}: \`${event.source}\`` : '',
            event.subject ? `- ${t('runtimeMonitor.drawer.fields.subject')}: \`${tailId(event.subject, 8)}\`` : '',
            session ? `- ${t('runtimeMonitor.drawer.fields.session')}: \`${tailId(session, 8)}\`` : '',
            toolName ? `- ${t('runtimeMonitor.drawer.fields.tool')}: \`${toolName}\`` : '',
            capabilityId ? `- Capability: \`${capabilityId}\`` : '',
          ]
            .filter(Boolean)
            .join('\n')
        })

        openDetailContent({
          kind: 'markdown',
          title: t('runtimeMonitor.drawer.title'),
          filename: 'events-center.md',
          content: [`# ${t('runtimeMonitor.drawer.title')}`, '', t('runtimeMonitor.drawer.subtitle'), '', `- ${t('runtimeMonitor.drawer.summary.count', { count: events.length })}`, '', ...blocks].join('\n'),
        })
      } catch (drawerError) {
        openDetailContent({
          kind: 'markdown',
          title: t('runtimeMonitor.drawer.title'),
          filename: 'events-center.md',
          content: [`# ${t('runtimeMonitor.drawer.title')}`, '', t('runtimeMonitor.drawer.error'), '', '```text', drawerError instanceof Error ? drawerError.message : String(drawerError), '```'].join('\n'),
        })
      } finally {
        setEventsDrawerLoading(false)
      }
    })()
  }, [locale, openDetailContent, t])

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-6 py-8">
        <div className="mb-6 space-y-6">
          <PageHeader
            title={t('runtimeMonitor.title')}
            subtitle={t('runtimeMonitor.subtitle')}
            actions={
              <Button variant="secondary" leftIcon={<RefreshCw size={16} className={clsx(isLoading && 'animate-spin')} />} onClick={() => void refresh()} loading={isLoading} className="whitespace-nowrap">
                {t('common.refresh')}
              </Button>
            }
          />

          <Card className="border-border-default">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[280px]">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                  <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder={t('runtimeMonitor.searchPlaceholder')} className="pl-9" />
                </div>
                <div className="min-w-[240px] flex-1">
                  <Input
                    value={capabilityQuery}
                    onChange={(event) => updateCapabilityQuery(event.target.value)}
                    placeholder="Filter by capability ID"
                  />
                </div>
                <button
                  type="button"
                  onClick={openEventsDrawer}
                  className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border-default px-4 text-sm text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
                  disabled={eventsDrawerLoading}
                >
                  <ArrowUpRight size={16} />
                  {t('runtimeMonitor.openEventsCenter')}
                </button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <PageHelpStrip text={t('help.nav.runtimeMonitor')} ctaLabel={t('nav.helpCenter')} />

          {!snapshot.available && (error || snapshot.error) ? <InlineErrorAlert message={error || snapshot.error || t('runtimeMonitor.errors.load')} /> : null}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {insightCards.map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={() => {
                  const target = cardFilterTarget(card.key)
                  if (target) updateActiveGroup(target)
                }}
                className="w-full text-left"
              >
                <Card className={clsx(toneClasses(card.tone), cardFilterTarget(card.key) ? 'transition-colors hover:border-border-strong' : '')}>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{card.label}</div>
                        <div className="mt-3 text-3xl font-semibold text-text-primary">{card.value}</div>
                        <div className="mt-2 text-sm text-text-secondary">{card.hint}</div>
                      </div>
                      <div className="rounded-xl border border-border-subtle bg-bg-elevated p-2.5 text-text-secondary">{card.icon}</div>
                    </div>
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>

          <Card className="border-border-default">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <div className="text-sm font-medium text-text-primary">{t('runtimeMonitor.sections.routeModeMix')}</div>
              <Badge variant={routeModeBadgeVariant(snapshot.summary.routeModeCounts.direct_answer)}>
                {t('runtimeMonitor.modes.directAnswer')} {snapshot.summary.routeModeCounts.direct_answer}
              </Badge>
              <Badge variant={routeModeBadgeVariant(snapshot.summary.routeModeCounts.direct_reasoning)}>
                {t('runtimeMonitor.modes.directReasoning')} {snapshot.summary.routeModeCounts.direct_reasoning}
              </Badge>
              <Badge variant={routeModeBadgeVariant(snapshot.summary.routeModeCounts.plan_act)}>
                {t('runtimeMonitor.modes.planAct')} {snapshot.summary.routeModeCounts.plan_act}
              </Badge>
              <Badge variant={routeModeBadgeVariant(snapshot.summary.routeModeCounts.delegate)}>
                {t('runtimeMonitor.modes.delegate')} {snapshot.summary.routeModeCounts.delegate}
              </Badge>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1.15fr,0.85fr]">
            <Card className="border-border-default">
              <CardContent className="p-6">
                <div className="flex flex-col gap-3 border-b border-border-subtle pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">{t('runtimeMonitor.sections.needsAttention')}</h2>
                    <p className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sections.needsAttentionHint')}</p>
                  </div>
                  <Badge variant={actionableSessions.length > 0 ? 'warning' : 'success'}>{t('runtimeMonitor.labels.actionableCount', { count: actionableSessions.length })}</Badge>
                </div>
                {actionableSessions.length === 0 ? (
                  <div className="pt-4">
                    <EmptyStateActions
                      message={t('runtimeMonitor.empty.description')}
                      actions={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('common.refresh')}</Button>}
                    />
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {actionableSessions.map((item) => (
                      <div key={item.sessionId} className={clsx('rounded-xl border p-4', detailBorder(item.status))}>
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={item.status === 'failure' ? 'error' : item.status === 'healthy' ? 'success' : 'warning'}>{item.statusLabel}</Badge>
                              {item.toolName ? <Badge variant="outline">{item.toolName}</Badge> : null}
                              {item.capabilityId ? <Badge variant="outline">{item.capabilityId}</Badge> : null}
                            </div>
                            <div className="mt-3 text-base font-medium text-text-primary">{tailId(item.sessionId)}</div>
                            {item.attemptId ? (
                              <div className="mt-1 text-xs text-text-tertiary">Attempt {tailId(item.attemptId)}</div>
                            ) : null}
                            <div className="mt-1 text-sm text-text-secondary">{item.summary}</div>
                          </div>
                          <div className="rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-right">
                            <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{t('runtimeMonitor.labels.recommendedAction')}</div>
                            <div className="mt-1 text-sm font-medium text-text-primary">{item.actionLabel}</div>
                            <div className="mt-3 flex flex-wrap justify-end gap-2">
                              <IconActionButton
                                label={t('runtimeMonitor.actions.viewRuntime')}
                                onClick={() =>
                                  openSessionRuntimeDetail(
                                    item.sessionId,
                                    pickFocusEventIdForGroup(
                                      snapshot.timeline.filter((event) => getEventSessionId(event) === item.sessionId),
                                      activeGroup === 'all' ? 'default' : activeGroup,
                                    ),
                                  )
                                }
                                icon={<Search size={14} />}
                              />
                              <IconActionButton label={copiedId === `session:${item.sessionId}` ? t('common.copied') : t('runtimeMonitor.actions.copySession')} onClick={() => void handleCopySession(item.sessionId)} icon={copiedId === `session:${item.sessionId}` ? <Check size={14} /> : <Copy size={14} />} />
                              {item.attemptId ? <IconActionButton label={copiedId === `attempt:${item.attemptId}` ? t('common.copied') : '复制 Attempt'} onClick={() => void handleCopyAttempt(item.attemptId)} icon={copiedId === `attempt:${item.attemptId}` ? <Check size={14} /> : <Copy size={14} />} /> : null}
                              {item.attemptId ? <IconActionButton label="查看 Attempt" onClick={() => openAttemptDetail(item.attemptId)} icon={<Search size={14} />} /> : null}
                              <IconActionButton label={t('runtimeMonitor.actions.openSession')} onClick={() => openChatSession(item.sessionId)} icon={<ArrowUpRight size={14} />} primary />
                            </div>
                          </div>
                        </div>
                        <div className="mt-4 grid gap-3 text-sm text-text-secondary md:grid-cols-4">
                          <MetricLine label={t('runtimeMonitor.labels.lastHeartbeatAt')} value={formatTime(item.lastSeenAt, locale)} />
                          <MetricLine label={t('runtimeMonitor.labels.idleFor')} value={item.idleFor} />
                          <MetricLine label={t('runtimeMonitor.labels.failures')} value={String(item.failures)} />
                          <MetricLine label={t('runtimeMonitor.labels.tokens')} value={numberCompact(item.totalTokens)} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border-default">
              <CardContent className="p-6">
                <div className="border-b border-border-subtle pb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('runtimeMonitor.sections.incidentGroups')}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sections.incidentGroupsHint')}</p>
                </div>
                <div className="mt-4 space-y-3">
                  {incidentGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => updateActiveGroup(group.key as GroupFilter)}
                      className={clsx(
                        'w-full rounded-xl border bg-bg-base px-4 py-4 text-left transition-colors',
                        activeGroup === group.key ? 'border-border-strong bg-bg-elevated' : 'border-border-subtle hover:border-border-default',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-text-primary">{group.label}</div>
                          <div className="mt-1 text-sm text-text-secondary">{group.hint}</div>
                        </div>
                        <Badge variant={group.variant}>{group.count}</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr,0.85fr]">
            <Card className="border-border-default">
              <CardContent className="p-6">
                <div className="border-b border-border-subtle pb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('runtimeMonitor.sections.recentIncidents')}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sections.recentIncidentsHint')}</p>
                </div>
                {incidentRows.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-border-subtle bg-bg-base px-4 py-4 text-sm text-text-secondary">{t('runtimeMonitor.noSignals')}</div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {incidentRows.map((row) => (
                      <div key={row.id} className="rounded-xl border border-border-subtle bg-bg-base p-4 transition-colors hover:border-border-default">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={row.badgeVariant}>{row.badge}</Badge>
                              {row.toolName ? <Badge variant="outline">{row.toolName}</Badge> : null}
                              {row.capabilityId ? <Badge variant="outline">{row.capabilityId}</Badge> : null}
                            </div>
                            <div className="mt-3 text-base font-medium text-text-primary">{row.title}</div>
                            <div className="mt-1 text-sm text-text-secondary">{row.detail}</div>
                          </div>
                          <div className="flex items-center gap-2 self-start">
                            <button
                              type="button"
                              onClick={() => void handleCopyEvent(row.raw)}
                              className="inline-flex h-8 items-center justify-center rounded-md border border-border-subtle px-2 text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
                              title={copiedId === row.id ? t('common.copied') : t('runtimeMonitor.copyEvent')}
                            >
                              {copiedId === row.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            {row.sessionId ? (
                              <button
                                type="button"
                                onClick={() => openSessionRuntimeDetail(row.sessionId, row.id)}
                                className="inline-flex h-8 items-center justify-center rounded-md border border-border-subtle px-2 text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
                                title={t('runtimeMonitor.actions.viewRuntime')}
                              >
                                <Search size={14} />
                              </button>
                            ) : null}
                            {row.sessionId ? (
                              <button
                                type="button"
                                onClick={() => openChatSession(row.sessionId)}
                                className="inline-flex h-8 items-center justify-center rounded-md border border-border-subtle px-2 text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
                                title={t('runtimeMonitor.actions.openSession')}
                              >
                                <ArrowUpRight size={14} />
                              </button>
                            ) : null}
                            <div className="text-sm text-text-tertiary">{formatTime(row.createdAt, locale)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border-default">
              <CardContent className="p-6">
                <div className="border-b border-border-subtle pb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('runtimeMonitor.sections.healthySessions')}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sections.healthySessionsHint')}</p>
                </div>
                {filteredDiagnostics.filter((item) => item.status === 'healthy').length === 0 ? (
                  <div className="mt-4 rounded-xl border border-border-subtle bg-bg-base px-4 py-4 text-sm text-text-secondary">{t('runtimeMonitor.noStaleSessions')}</div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {filteredDiagnostics
                      .filter((item) => item.status === 'healthy')
                      .slice(0, 4)
                      .map((item) => (
                        <div key={item.sessionId} className="rounded-xl border border-border-subtle bg-bg-base p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-text-primary">{tailId(item.sessionId)}</div>
                              {item.attemptId ? <div className="mt-1 text-xs text-text-tertiary">Attempt {tailId(item.attemptId)}</div> : null}
                              <div className="mt-1 text-sm text-text-secondary">{item.summary}</div>
                            </div>
                            <Badge variant="success">{item.statusLabel}</Badge>
                          </div>
                          <div className="mt-3 grid gap-3 text-sm text-text-secondary md:grid-cols-2">
                            <MetricLine label={t('runtimeMonitor.labels.lastHeartbeatAt')} value={formatTime(item.lastSeenAt, locale)} />
                            <MetricLine label={t('runtimeMonitor.labels.tokens')} value={numberCompact(item.totalTokens)} />
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-2">
      <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{label}</div>
      <div className="mt-1 text-sm text-text-primary">{value}</div>
    </div>
  )
}

function IconActionButton({
  label,
  onClick,
  icon,
  primary = false,
}: {
  label: string
  onClick: () => void
  icon: React.ReactNode
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
        primary
          ? 'border-primary-500/50 bg-primary-500/12 text-primary-300 hover:bg-primary-500/20'
          : 'border-border-subtle bg-bg-base text-text-secondary hover:bg-interactive-hover hover:text-text-primary',
      )}
    >
      {icon}
    </button>
  )
}
