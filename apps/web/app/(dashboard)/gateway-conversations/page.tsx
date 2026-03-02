'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { ArrowRight, Clock3, RefreshCw, Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'

interface GatewayConversationSummary {
  conversationId: string
  provider: string
  gatewayKey: string
  status: string
  updatedAt: string
}

interface RuntimeGatewayConversationsResponse {
  success: boolean
  data?: {
    conversations?: GatewayConversationSummary[]
  }
}

interface GatewayConversationRunSummary {
  runId: string
  runtimeSessionId: string
  snapshotVersion: number
  status: string
  resultSummary: string
  updatedAt: string
}

interface RuntimeGatewayConversationRunsResponse {
  success: boolean
  data?: {
    runs?: GatewayConversationRunSummary[]
  }
}

type GatewaySource = 'telegram' | 'feishu' | 'gateway'
type SourceFilter = 'all' | GatewaySource

interface GatewayRunDisplay {
  id: string
  runId?: string
  conversationId: string
  title: string
  status: string
  updatedAt: string
  href: string
}

interface GatewayConversationGroup {
  groupKey: string
  source: GatewaySource
  chatId: string
  conversationIds: string[]
  conversationCount: number
  runs: GatewayRunDisplay[]
  totalRuns: number
  latestAt: string
}

function parseGatewayChatId(gatewayKey: string): string {
  const parts = String(gatewayKey || '').split(':')
  if (parts.length < 3) return ''
  return parts.slice(2).join(':')
}

function mapProviderToSource(provider: string): GatewaySource {
  const normalized = String(provider || '').toLowerCase()
  if (normalized === 'telegram') return 'telegram'
  if (normalized === 'feishu') return 'feishu'
  return 'gateway'
}

function mapStatusVariant(status: string): 'outline' | 'success' | 'warning' | 'error' {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'done' || normalized === 'completed') return 'success'
  if (normalized === 'running' || normalized === 'queued' || normalized === 'awaiting_approval') return 'warning'
  if (normalized === 'failed' || normalized === 'error') return 'error'
  return 'outline'
}

function formatRelativeTime(dateString: string, locale: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / (1000 * 60))
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (mins < 1) return rtf.format(0, 'minute')
  if (mins < 60) return rtf.format(-mins, 'minute')
  const hours = Math.floor(mins / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return rtf.format(-days, 'day')
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export default function GatewayConversationListPage() {
  const { locale, t } = useLocale()
  const [groups, setGroups] = useState<GatewayConversationGroup[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)

      const conversationsRes = await apiClient.get<RuntimeGatewayConversationsResponse>(
        '/runtime/gateway/conversations',
        { params: { limit: 100 } }
      )
      const conversations = Array.isArray(conversationsRes.data?.conversations)
        ? conversationsRes.data!.conversations!
        : []
      const sortedConversations = [...conversations].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )

      const runsResponses = await Promise.allSettled(
        sortedConversations.map((item) => (
          apiClient.get<RuntimeGatewayConversationRunsResponse>(
            `/runtime/gateway/conversations/${encodeURIComponent(item.conversationId)}/runs`,
            { params: { limit: 20 } }
          )
        ))
      )

      const groupMap = new Map<
      string,
      {
        source: GatewaySource
        chatId: string
        conversationSet: Set<string>
        runs: GatewayRunDisplay[]
        latestTs: number
      }
      >()

      sortedConversations.forEach((conversation, index) => {
        const source = mapProviderToSource(conversation.provider)
        const chatId = parseGatewayChatId(conversation.gatewayKey)
        const groupKey = `${source}:${chatId || 'unknown'}`
        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, {
            source,
            chatId,
            conversationSet: new Set<string>(),
            runs: [],
            latestTs: 0,
          })
        }
        const group = groupMap.get(groupKey)!
        group.conversationSet.add(conversation.conversationId)

        const runsPayload =
          runsResponses[index]?.status === 'fulfilled' && Array.isArray(runsResponses[index].value.data?.runs)
            ? runsResponses[index].value.data!.runs!
            : []

        if (runsPayload.length === 0) {
          group.runs.push({
            id: `conversation:${conversation.conversationId}`,
            conversationId: conversation.conversationId,
            title: t('dashboard.gatewayList.runFallbackTitle'),
            status: conversation.status || 'unknown',
            updatedAt: conversation.updatedAt,
            href: `/gateway-conversations/${encodeURIComponent(conversation.conversationId)}?provider=${source}&chatId=${encodeURIComponent(chatId || '')}`,
          })
          group.latestTs = Math.max(group.latestTs, new Date(conversation.updatedAt).getTime() || 0)
          return
        }

        runsPayload.forEach((run) => {
          group.runs.push({
            id: `run:${run.runId}`,
            runId: run.runId,
            conversationId: conversation.conversationId,
            title: run.resultSummary?.trim() || t('dashboard.gatewayList.runFallbackTitle'),
            status: run.status || 'unknown',
            updatedAt: run.updatedAt,
            href: `/gateway-conversations/${encodeURIComponent(conversation.conversationId)}?provider=${source}&chatId=${encodeURIComponent(chatId || '')}&runId=${encodeURIComponent(run.runId)}`,
          })
          group.latestTs = Math.max(group.latestTs, new Date(run.updatedAt).getTime() || 0)
        })
      })

      const nextGroups: GatewayConversationGroup[] = Array.from(groupMap.entries())
        .map(([groupKey, group]) => {
          const sortedRuns = [...group.runs]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          return {
            groupKey,
            source: group.source,
            chatId: group.chatId,
            conversationIds: Array.from(group.conversationSet),
            conversationCount: group.conversationSet.size,
            runs: sortedRuns,
            totalRuns: sortedRuns.length,
            latestAt: group.latestTs > 0 ? new Date(group.latestTs).toISOString() : new Date().toISOString(),
          }
        })
        .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())

      setGroups(nextGroups)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dashboard.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const filteredGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return groups.filter((group) => {
      if (sourceFilter !== 'all' && group.source !== sourceFilter) return false
      if (!keyword) return true

      const groupFields = `${group.chatId} ${group.source} ${group.conversationIds.join(' ')}`.toLowerCase()
      if (groupFields.includes(keyword)) return true

      return group.runs.some((run) => (
        `${run.runId || ''} ${run.title} ${run.conversationId}`.toLowerCase().includes(keyword)
      ))
    })
  }, [groups, query, sourceFilter])

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold text-text-primary">{t('dashboard.gatewayList.title')}</h1>
                <p className="text-sm text-text-secondary">{t('dashboard.gatewayList.subtitle')}</p>
              </div>
              <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={() => void load()} disabled={isLoading}>
                {t('common.refresh')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500">
            {error}
          </div>
        )}

        <Card className="border-border-default">
          <CardContent className="p-4 space-y-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('dashboard.gatewayList.searchPlaceholder')}
              leftIcon={<Search size={16} />}
            />
            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'telegram', 'feishu', 'gateway'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSourceFilter(value)}
                  className={clsx(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    sourceFilter === value
                      ? 'border-primary-500/40 bg-primary-500/10 text-primary-500'
                      : 'border-border-default text-text-secondary hover:bg-interactive-hover'
                  )}
                >
                  {value === 'all'
                    ? t('dashboard.gatewayList.filterAll')
                    : t(`dashboard.recentSessions.sources.${value}`)}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {isLoading ? (
            [1, 2, 3].map((row) => (
              <div key={row} className="h-36 animate-pulse rounded-lg border border-border-subtle bg-bg-elevated/60" />
            ))
          ) : filteredGroups.length > 0 ? (
            filteredGroups.map((group) => {
              const sourceLabel = t(`dashboard.recentSessions.sources.${group.source}`)
              const visibleRuns = group.runs.slice(0, 6)
              const chatLabel = group.chatId || t('dashboard.gatewayList.unknownChat')

              return (
                <Card key={group.groupKey} className="border-border-default">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <h2 className="text-lg font-semibold text-text-primary">{sourceLabel} · {chatLabel}</h2>
                          <Badge variant="outline">{sourceLabel}</Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                          <span>{t('dashboard.gatewayList.conversations', { count: group.conversationCount })}</span>
                          <span>{t('dashboard.gatewayList.runs', { count: group.totalRuns })}</span>
                          <span>{t('dashboard.gatewayList.latest', { time: formatRelativeTime(group.latestAt, locale) })}</span>
                        </div>
                      </div>
                      {group.runs[0] && (
                        <Link
                          href={group.runs[0].href}
                          className="inline-flex items-center gap-1 rounded-md border border-border-default px-3 py-1.5 text-xs text-text-secondary hover:bg-interactive-hover"
                        >
                          {t('dashboard.gatewayList.openLatest')}
                          <ArrowRight size={13} />
                        </Link>
                      )}
                    </div>

                    <div className="space-y-2">
                      {visibleRuns.map((run) => (
                        <Link
                          key={run.id}
                          href={run.href}
                          className="group flex items-center justify-between rounded-lg border border-border-subtle bg-bg-surface px-3 py-3 hover:border-border-strong"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">{run.title}</p>
                            <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                              <Clock3 size={12} />
                              {formatRelativeTime(run.updatedAt, locale)}
                              {run.runId && <span>{run.runId}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={mapStatusVariant(run.status)}>{run.status}</Badge>
                            <ArrowRight
                              size={14}
                              className="text-text-tertiary transition-transform group-hover:translate-x-0.5"
                            />
                          </div>
                        </Link>
                      ))}
                    </div>

                    {group.totalRuns > visibleRuns.length && (
                      <p className="text-xs text-text-tertiary">
                        {t('dashboard.gatewayList.showingRuns', { shown: visibleRuns.length, total: group.totalRuns })}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })
          ) : (
            <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-8 text-sm text-text-secondary">
              {t('dashboard.gatewayList.empty')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
