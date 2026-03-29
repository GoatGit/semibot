'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart2, Calendar, Cpu, RefreshCw, Zap } from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { PageHeader } from '@/components/ui/PageHeader'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'
import { useAgents } from '@/hooks/useAgents'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface TokenTotals {
  call_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface TokenBreakdownItem {
  key: string
  call_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface TokenTrendItem {
  day: string
  total_tokens: number
  call_count: number
  segments?: Record<string, number>
}

interface TokenUsageData {
  totals: TokenTotals
  breakdown: TokenBreakdownItem[]
  trend: TokenTrendItem[]
}

type GroupBy = 'node' | 'model' | 'session' | 'agent'
type TimePreset = 'today' | 'yesterday' | 'last7d' | 'last30d' | 'custom'

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

const CHART_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
]

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function toLocalDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function startOfDay(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`
}

function endOfDay(dateStr: string): string {
  return `${dateStr}T23:59:59.999Z`
}

function presetToRange(preset: TimePreset): { since: string; until: string; granularity: 'hour' | 'day' } {
  const now = new Date()
  const todayStr = toLocalDate(now)
  switch (preset) {
    case 'today':
      return { since: startOfDay(todayStr), until: endOfDay(todayStr), granularity: 'hour' }
    case 'yesterday': {
      const y = new Date(now)
      y.setDate(y.getDate() - 1)
      return { since: startOfDay(toLocalDate(y)), until: endOfDay(toLocalDate(y)), granularity: 'hour' }
    }
    case 'last7d': {
      const d = new Date(now)
      d.setDate(d.getDate() - 6)
      return { since: startOfDay(toLocalDate(d)), until: endOfDay(todayStr), granularity: 'day' }
    }
    case 'last30d': {
      const d = new Date(now)
      d.setDate(d.getDate() - 29)
      return { since: startOfDay(toLocalDate(d)), until: endOfDay(todayStr), granularity: 'day' }
    }
    default:
      return { since: '', until: '', granularity: 'day' }
  }
}

/** 从 trend 数据中提取所有分组 key（按 total_tokens 降序取 top N） */
function extractSegmentKeys(trend: TokenTrendItem[], limit = 10): string[] {
  const totals = new Map<string, number>()
  for (const item of trend) {
    if (!item.segments) continue
    for (const [k, v] of Object.entries(item.segments)) {
      totals.set(k, (totals.get(k) ?? 0) + v)
    }
  }
  // 如果没有 segments 数据但 trend 有内容，用 "total" 作为 fallback key
  if (totals.size === 0 && trend.length > 0) {
    return ['total']
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k)
}

/** 将 trend 数据展平为 recharts 需要的 flat record 格式 */
function buildChartData(trend: TokenTrendItem[], keys: string[], isHourly: boolean): Record<string, unknown>[] {
  const isFallback = keys.length === 1 && keys[0] === 'total'
  return trend.map((item) => {
    const row: Record<string, unknown> = {
      label: isHourly ? item.day.slice(5) : item.day,
    }
    if (isFallback) {
      row['total'] = item.total_tokens
    } else {
      for (const k of keys) {
        row[k] = item.segments?.[k] ?? 0
      }
    }
    return row
  })
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export default function UsagePage() {
  const { t } = useLocale()
  const [data, setData] = useState<TokenUsageData | null>(null)
  const [groupBy, setGroupBy] = useState<GroupBy>('model')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [timePreset, setTimePreset] = useState<TimePreset>('last7d')
  const [customFrom, setCustomFrom] = useState(() => toLocalDate(new Date()))
  const [customTo, setCustomTo] = useState(() => toLocalDate(new Date()))

  const { agents } = useAgents()
  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const agent of agents) map[agent.id] = agent.name
    return map
  }, [agents])

  const resolveKey = useCallback(
    (key: string) => (groupBy === 'agent' ? agentNameMap[key] || key : key),
    [groupBy, agentNameMap],
  )

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      let since: string | undefined
      let until: string | undefined
      let granularity: 'hour' | 'day' = 'day'
      if (timePreset === 'custom') {
        since = startOfDay(customFrom)
        until = endOfDay(customTo)
        const diffMs = new Date(until).getTime() - new Date(since).getTime()
        granularity = diffMs <= 2 * 86_400_000 ? 'hour' : 'day'
      } else {
        const range = presetToRange(timePreset)
        since = range.since
        until = range.until
        granularity = range.granularity
      }
      const result = await apiClient.get<TokenUsageData>('/stats/token-usage', {
        params: { group_by: groupBy, since, until, granularity },
      })
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.retry'))
    } finally {
      setIsLoading(false)
    }
  }, [groupBy, timePreset, customFrom, customTo, t])

  useEffect(() => {
    if (timePreset !== 'custom') load()
  }, [load, timePreset])

  const totals = data?.totals ?? { call_count: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const breakdown = data?.breakdown ?? []
  const trend = useMemo(() => data?.trend ?? [], [data?.trend])

  const isHourly = timePreset === 'today' || timePreset === 'yesterday'
    || (timePreset === 'custom' && new Date(endOfDay(customTo)).getTime() - new Date(startOfDay(customFrom)).getTime() <= 2 * 86_400_000)

  // 从 trend segments 提取分组 key 列表 + 构建 recharts 数据
  const segmentKeys = useMemo(() => extractSegmentKeys(trend), [trend])
  const chartData = useMemo(() => buildChartData(trend, segmentKeys, isHourly), [trend, segmentKeys, isHourly])

  const overviewCards = [
    { label: t('usage.cards.totalTokens'), value: formatNumber(totals.total_tokens), icon: <Zap size={18} />, sub: `${formatNumber(totals.call_count)} ${t('usage.cards.calls')}` },
    { label: t('usage.cards.promptTokens'), value: formatNumber(totals.prompt_tokens), icon: <Cpu size={18} />, sub: `${totals.total_tokens > 0 ? Math.round((totals.prompt_tokens / totals.total_tokens) * 100) : 0}%` },
    { label: t('usage.cards.completionTokens'), value: formatNumber(totals.completion_tokens), icon: <BarChart2 size={18} />, sub: `${totals.total_tokens > 0 ? Math.round((totals.completion_tokens / totals.total_tokens) * 100) : 0}%` },
  ]

  const groupByOptions: { value: GroupBy; label: string }[] = [
    { value: 'node', label: t('usage.groupBy.node') },
    { value: 'model', label: t('usage.groupBy.model') },
    { value: 'agent', label: t('usage.groupBy.agent') },
    { value: 'session', label: t('usage.groupBy.session') },
  ]

  const timePresets: { value: TimePreset; label: string }[] = [
    { value: 'today', label: t('usage.timeRange.today') },
    { value: 'yesterday', label: t('usage.timeRange.yesterday') },
    { value: 'last7d', label: t('usage.timeRange.last7d') },
    { value: 'last30d', label: t('usage.timeRange.last30d') },
    { value: 'custom', label: t('usage.timeRange.custom') },
  ]

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
        {/* ── Header ── */}
        <PageHeader
          title={t('usage.title')}
          subtitle={t('usage.subtitle')}
          actions={
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={load} disabled={isLoading}>
              {t('common.refresh')}
            </Button>
          }
        />

        {/* ── 时间范围 + 分组选择器 ── */}
        <Card className="border-border-default">
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Calendar size={16} className="text-text-tertiary shrink-0" />
              {timePresets.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimePreset(opt.value)}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${
                    timePreset === opt.value
                      ? 'bg-primary-500 text-white'
                      : 'bg-bg-elevated text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              {timePreset === 'custom' && (
                <div className="flex items-center gap-2 ml-2">
                  <span className="text-xs text-text-tertiary">{t('usage.timeRange.from')}</span>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="h-7 px-2 text-xs rounded-md border border-border-default bg-bg-surface text-text-primary"
                  />
                  <span className="text-xs text-text-tertiary">{t('usage.timeRange.to')}</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="h-7 px-2 text-xs rounded-md border border-border-default bg-bg-surface text-text-primary"
                  />
                  <button
                    onClick={load}
                    disabled={isLoading}
                    className="px-3 py-1 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 transition-colors"
                  >
                    {t('usage.timeRange.apply')}
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <BarChart2 size={16} className="text-text-tertiary shrink-0" />
              {groupByOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setGroupBy(opt.value)}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${
                    groupBy === opt.value
                      ? 'bg-primary-500 text-white'
                      : 'bg-bg-elevated text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {error && <InlineErrorAlert message={error} />}

        {/* ── Overview Cards ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {overviewCards.map((card) => (
            <Card key={card.label} className="border-border-default">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-text-secondary">{card.label}</p>
                  <div className="text-primary-400">{card.icon}</div>
                </div>
                <div className="mt-3 text-2xl font-semibold text-text-primary">
                  {isLoading ? '--' : card.value}
                </div>
                <p className="mt-1 text-xs text-text-tertiary">{isLoading ? '' : card.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── 堆叠柱状图 ── */}
        {chartData.length > 0 && (
          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-base font-semibold text-text-primary mb-4">
                {isHourly ? t('usage.trend.titleHourly') : t('usage.trend.title')}
              </h2>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle, #333)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--color-text-tertiary, #888)' }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--color-text-tertiary, #888)' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={formatNumber}
                    width={52}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-bg-surface, #1a1a2e)',
                      border: '1px solid var(--color-border-default, #333)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: 'var(--color-text-primary, #fff)', fontWeight: 600 }}
                    itemStyle={{ color: 'var(--color-text-secondary, #ccc)' }}
                    formatter={(value: number | undefined) => formatNumber(value ?? 0)}
                    labelFormatter={(label) => String(label)}
                  />
                  <Legend
                    formatter={(value: string) => resolveKey(value)}
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  />
                  {segmentKeys.map((key, i) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      name={key}
                      stackId="tokens"
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
                      radius={i === segmentKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* ── 分组明细表格 ── */}
        <Card className="border-border-default">
          <CardContent className="p-5">
            <h2 className="text-base font-semibold text-text-primary mb-4">{t('usage.breakdown.title')}</h2>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded bg-bg-elevated" />
                ))}
              </div>
            ) : breakdown.length === 0 ? (
              <p className="text-sm text-text-secondary py-4 text-center">{t('common.noData')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle">
                      <th className="pb-2 text-left text-xs text-text-tertiary font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-sm"
                            style={{ backgroundColor: 'transparent' }}
                          />
                          {t('usage.breakdown.key')}
                        </span>
                      </th>
                      <th className="pb-2 text-right text-xs text-text-tertiary font-medium">{t('usage.breakdown.calls')}</th>
                      <th className="pb-2 text-right text-xs text-text-tertiary font-medium">{t('usage.breakdown.promptTokens')}</th>
                      <th className="pb-2 text-right text-xs text-text-tertiary font-medium">{t('usage.breakdown.completionTokens')}</th>
                      <th className="pb-2 text-right text-xs text-text-tertiary font-medium">{t('usage.breakdown.totalTokens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((item, idx) => (
                      <tr key={item.key} className="border-b border-border-subtle last:border-0">
                        <td className="py-2 text-text-primary font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                              style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }}
                            />
                            {resolveKey(item.key)}
                          </span>
                        </td>
                        <td className="py-2 text-right text-text-secondary">{item.call_count}</td>
                        <td className="py-2 text-right text-text-secondary">{formatNumber(item.prompt_tokens)}</td>
                        <td className="py-2 text-right text-text-secondary">{formatNumber(item.completion_tokens)}</td>
                        <td className="py-2 text-right text-text-primary font-medium">{formatNumber(item.total_tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
