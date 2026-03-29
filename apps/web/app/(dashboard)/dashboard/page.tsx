'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import {
  MessageSquare,
  Wrench,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Activity,
  Clock3,
  Workflow,
  Globe,
  Github,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { PageHelpStrip } from '@/components/ui/PageHelpStrip'
import { AgentBotAvatar } from '@/components/ui/AgentBotAvatar'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiClient } from '@/lib/api'
import type { Session } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface PageMeta {
  total?: number
}

interface ListResponse<T> {
  success: boolean
  data: T[]
  meta?: PageMeta
}

interface GatewayConversationSummary {
  conversationId: string
  provider: string
  gatewayKey: string
  status: string
  updatedAt: string
  latestRun?: GatewayConversationRunSummary | null
}

interface RuntimeGatewayConversationsResponse {
  success: boolean
  data?: {
    available?: boolean
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

interface DashboardStats {
  agentsTotal: number
  sessionsTotal: number
  sessionsActive: number
  toolsTotal: number | null
  productionsTotal: number | null
  skillsTotal: number | null
  eventsTotal: number | null
  approvalsPending: number | null
  recentSessions: Session[]
  recentConversations: Array<{
    id: string
    title: string
    createdAt: string
    href?: string
    source: 'web' | 'telegram' | 'feishu' | 'channel'
  }>
  recentEvents: Array<{
    id: string
    eventType: string
    createdAt: string
    riskHint?: string
  }>
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

function parseGatewayChatId(gatewayKey: string): string {
  const parts = String(gatewayKey || '').split(':')
  if (parts.length < 3) return ''
  return parts.slice(2).join(':')
}

export default function DashboardPage() {
  const { locale, t } = useLocale()
  const [stats, setStats] = useState<DashboardStats>({
    agentsTotal: 0,
    sessionsTotal: 0,
    sessionsActive: 0,
    toolsTotal: null,
    productionsTotal: null,
    skillsTotal: null,
    eventsTotal: null,
    approvalsPending: null,
    recentSessions: [],
    recentConversations: [],
    recentEvents: [],
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)

      const [agentsRes, sessionsRes, toolsRes, productionsRes, skillsRes, eventsRes, approvalsRes, gatewayConversationsRes] = await Promise.allSettled([
        apiClient.get<ListResponse<unknown>>('/agents', { params: { page: 1, limit: 100 } }),
        apiClient.get<ListResponse<Session>>('/sessions', { params: { page: 1, limit: 10 } }),
        apiClient.get<ListResponse<unknown>>('/tools', { params: { page: 1, limit: 1 } }),
        apiClient.get<ListResponse<unknown>>('/productions', { params: { page: 1, limit: 1 } }),
        apiClient.get<ListResponse<unknown>>('/skill-definitions', { params: { page: 1, limit: 1 } }),
        apiClient.get<{ items?: unknown[] }>('/events', { params: { limit: 5 } }),
        apiClient.get<{ items?: Array<{ status?: string }> }>('/approvals', { params: { status: 'pending', limit: 50 } }),
        apiClient.get<RuntimeGatewayConversationsResponse>('/runtime/channels/conversations', { params: { limit: 10 } }),
      ])

      const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : null
      const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value : null
      const tools = toolsRes.status === 'fulfilled' ? toolsRes.value : null
      const productions = productionsRes.status === 'fulfilled' ? productionsRes.value : null
      const skills = skillsRes.status === 'fulfilled' ? skillsRes.value : null
      const events =
        eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value.items)
          ? eventsRes.value.items
          : []
      const pendingApprovals =
        approvalsRes.status === 'fulfilled' && Array.isArray(approvalsRes.value.items)
          ? approvalsRes.value.items
          : []
      const gatewayConversations =
        gatewayConversationsRes.status === 'fulfilled' && Array.isArray(gatewayConversationsRes.value.data?.conversations)
          ? gatewayConversationsRes.value.data!.conversations!
          : []

      if (!agents && !sessions) {
        throw new Error(t('dashboard.error.coreData'))
      }

      const recentSessions = sessions?.data ?? []
      const sessionsActive = recentSessions.filter((s) => s.status === 'active').length
      const webRecent = recentSessions.map((session) => ({
        id: `web:${session.id}`,
        title: session.title || t('chatLayout.untitled'),
        createdAt: session.createdAt,
        href: `/chat/${session.id}`,
        source: 'web' as const,
      }))
      const gatewayRecent = gatewayConversations.map((item) => {
        const provider = String(item.provider || '').toLowerCase()
        const source = (
          provider === 'telegram'
            ? 'telegram'
            : provider === 'feishu'
              ? 'feishu'
              : 'channel'
        ) as 'telegram' | 'feishu' | 'channel'
        const chatId = parseGatewayChatId(item.gatewayKey)
        const sourceLabel = t(`dashboard.recentSessions.sources.${source}`)
        const run = item.latestRun

        if (!run) {
          return {
            id: `gateway:${item.conversationId}`,
            title: chatId ? `${sourceLabel} · ${chatId}` : `${sourceLabel} · ${item.conversationId.slice(0, 8)}`,
            createdAt: item.updatedAt,
            source,
            href: `/channel-conversations/${encodeURIComponent(item.conversationId)}?provider=${source}&chatId=${encodeURIComponent(chatId || '')}`,
          }
        }

        const runHint = run.resultSummary?.trim()
        const title = runHint
          ? runHint
          : `${sourceLabel} · ${chatId || item.conversationId.slice(0, 8)}`
        return {
          id: `gateway-run:${run.runId}`,
          title,
          createdAt: run.updatedAt,
          source,
          href: `/channel-conversations/${encodeURIComponent(item.conversationId)}?provider=${source}&chatId=${encodeURIComponent(chatId || '')}&runId=${encodeURIComponent(run.runId)}`,
        }
      })
      const mergedRecent = [...webRecent, ...gatewayRecent]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      const maxRecentRows = 6
      const minGatewayRows = 3
      const baseRecent = mergedRecent.slice(0, maxRecentRows)
      const baseGatewayCount = baseRecent.filter((item) => item.source !== 'web').length
      const extraGatewayNeeded = Math.max(0, Math.min(minGatewayRows, gatewayRecent.length) - baseGatewayCount)
      const extraGatewayItems =
        extraGatewayNeeded > 0
          ? mergedRecent
            .filter((item) => item.source !== 'web' && !baseRecent.some((base) => base.id === item.id))
            .slice(0, extraGatewayNeeded)
          : []
      const recentConversations = (
        extraGatewayItems.length > 0
          ? [...baseRecent.slice(0, Math.max(0, maxRecentRows - extraGatewayItems.length)), ...extraGatewayItems]
          : baseRecent
      ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      setStats({
        agentsTotal: agents?.meta?.total ?? agents?.data?.length ?? 0,
        sessionsTotal: sessions?.meta?.total ?? recentSessions.length,
        sessionsActive,
        toolsTotal: tools ? (tools.meta?.total ?? tools.data?.length ?? 0) : null,
        productionsTotal: productions ? (productions.meta?.total ?? productions.data?.length ?? 0) : null,
        skillsTotal: skills ? (skills.meta?.total ?? skills.data?.length ?? 0) : null,
        recentSessions,
        recentConversations,
        eventsTotal: events.length,
        approvalsPending: pendingApprovals.length,
        recentEvents: events
          .slice(0, 5)
          .map((item) => (item as { id?: string; eventType?: string; event_type?: string; createdAt?: string; created_at?: string; riskHint?: string; risk_hint?: string }))
          .filter((item) => !!item.id)
          .map((item) => ({
            id: item.id!,
            eventType: item.eventType || item.event_type || 'unknown',
            createdAt: item.createdAt || item.created_at || new Date().toISOString(),
            riskHint: item.riskHint || item.risk_hint,
          })),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dashboard.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const cards = useMemo(
    () => [
      {
        id: 'agents',
        label: t('dashboard.cards.agents.label'),
        value: stats.agentsTotal,
        icon: (
          <AgentBotAvatar
            agentId="dashboard-agents"
            agentName="Agents"
            size={24}
            iconScale={0.92}
            monochrome
            className="text-current"
          />
        ),
        hint: t('dashboard.cards.agents.hint'),
      },
      {
        id: 'sessions',
        label: t('dashboard.cards.sessions.label'),
        value: stats.sessionsTotal,
        icon: <MessageSquare size={18} />,
        hint: t('dashboard.cards.sessions.hint', { count: stats.sessionsActive }),
      },
      {
        id: 'tools',
        label: t('dashboard.cards.tools.label'),
        value: stats.toolsTotal,
        icon: <Wrench size={18} />,
        hint: t('dashboard.cards.tools.hint'),
      },
      {
        id: 'productions',
        label: t('dashboard.cards.productions.label'),
        value: stats.productionsTotal,
        icon: <Workflow size={18} />,
        hint: t('dashboard.cards.productions.hint'),
      },
      {
        id: 'skills',
        label: t('dashboard.cards.skills.label'),
        value: stats.skillsTotal,
        icon: <Sparkles size={18} />,
        hint: t('dashboard.cards.skills.hint'),
      },
      {
        id: 'events',
        label: t('dashboard.cards.events.label'),
        value: stats.eventsTotal,
        icon: <Activity size={18} />,
        hint: t('dashboard.cards.events.hint', { count: stats.approvalsPending ?? 0 }),
      },
    ],
    [stats, t]
  )

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="overflow-hidden border-border-default">
          <CardContent className="relative p-0">
            <div
              className="absolute inset-0 bg-no-repeat"
              style={{
                backgroundImage:
                  "url('/dashboard-title-bg.svg'), var(--dashboard-title-gradient)",
                backgroundPosition: 'center center, center center',
                backgroundSize: 'auto 100%, cover',
              }}
            />
            <div className="relative p-6 md:p-8">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <h1 className="text-2xl md:text-3xl font-semibold text-text-primary">
                    {t('dashboard.title')}
                  </h1>
                  <p className="text-text-secondary max-w-2xl">
                    {t('dashboard.subtitle')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href="https://semibot.ai"
                    target="_blank"
                    rel="noreferrer"
                    className={clsx(
                      'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border-default px-4 text-base font-medium text-text-primary transition-all duration-fast ease-out',
                      'hover:bg-interactive-hover hover:border-border-strong active:bg-interactive-active'
                    )}
                  >
                    <Globe size={16} />
                    {t('dashboard.actions.website')}
                  </a>
                  <a
                    href="https://github.com/GoatGit/semibot"
                    target="_blank"
                    rel="noreferrer"
                    className={clsx(
                      'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border-default px-4 text-base font-medium text-text-primary transition-all duration-fast ease-out',
                      'hover:bg-interactive-hover hover:border-border-strong active:bg-interactive-active'
                    )}
                  >
                    <Github size={16} />
                    {t('dashboard.actions.github')}
                  </a>
                  <Button
                    variant="secondary"
                    leftIcon={<RefreshCw size={16} />}
                    onClick={load}
                    disabled={isLoading}
                    title={t('help.actions.refreshDashboard')}
                  >
                    {t('common.refresh')}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <PageHelpStrip text={t('help.nav.helpCenter')} ctaLabel={t('nav.helpCenter')} />

        {error && (
          <InlineErrorAlert message={error} />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {cards.map((card) => (
            <Card key={card.id} className="border-border-default">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-text-secondary">{card.label}</p>
                  <div className="text-primary-400">{card.icon}</div>
                </div>
                <div className="mt-3 text-2xl font-semibold text-text-primary">
                  {card.value ?? '--'}
                </div>
                <p className="mt-1 text-xs text-text-tertiary">{card.hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-border-default">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.recentSessions.title')}</h2>
              <Link href="/channel-conversations" className="text-sm text-primary-400 hover:text-primary-300">
                {t('dashboard.recentSessions.viewAll')}
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {isLoading ? (
                [1, 2, 3].map((row) => (
                  <div
                    key={row}
                    className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton height={14} className="w-2/3" />
                      <Skeleton height={10} className="w-1/3" />
                    </div>
                    <Skeleton width={14} height={14} rounded="sm" />
                  </div>
                ))
              ) : stats.recentConversations.length > 0 ? (
                stats.recentConversations.map((item) => (
                  item.href ? (
                    <Link
                      key={item.id}
                      href={item.href}
                      className={clsx(
                        'group flex items-center justify-between rounded-lg border px-3 py-3',
                        'border-border-subtle bg-bg-surface hover:border-border-strong'
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.title}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                          <Clock3 size={12} />
                          {formatRelativeTime(item.createdAt, locale)}
                          <Badge variant="outline">{t(`dashboard.recentSessions.sources.${item.source}`)}</Badge>
                        </div>
                      </div>
                      <ArrowRight
                        size={14}
                        className="text-text-tertiary transition-transform group-hover:translate-x-0.5"
                      />
                    </Link>
                  ) : (
                    <div
                      key={item.id}
                      className={clsx(
                        'flex items-center justify-between rounded-lg border px-3 py-3',
                        'border-border-subtle bg-bg-surface'
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.title}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                          <Clock3 size={12} />
                          {formatRelativeTime(item.createdAt, locale)}
                          <Badge variant="outline">{t(`dashboard.recentSessions.sources.${item.source}`)}</Badge>
                        </div>
                      </div>
                    </div>
                  )
                ))
              ) : (
                <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                  {t('dashboard.recentSessions.empty')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
