'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import {
  Bot,
  MessageSquare,
  Puzzle,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Activity,
  Clock3,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'
import { NEW_CHAT_PATH } from '@/constants/config'
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

interface DashboardStats {
  agentsTotal: number
  sessionsTotal: number
  sessionsActive: number
  mcpTotal: number | null
  skillsTotal: number | null
  eventsTotal: number | null
  approvalsPending: number | null
  recentSessions: Session[]
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

export default function DashboardPage() {
  const { locale, t } = useLocale()
  const [stats, setStats] = useState<DashboardStats>({
    agentsTotal: 0,
    sessionsTotal: 0,
    sessionsActive: 0,
    mcpTotal: null,
    skillsTotal: null,
    eventsTotal: null,
    approvalsPending: null,
    recentSessions: [],
    recentEvents: [],
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)

      const [agentsRes, sessionsRes, mcpRes, skillsRes, eventsRes, approvalsRes] = await Promise.allSettled([
        apiClient.get<ListResponse<unknown>>('/agents', { params: { page: 1, limit: 100 } }),
        apiClient.get<ListResponse<Session>>('/sessions', { params: { page: 1, limit: 10 } }),
        apiClient.get<ListResponse<unknown>>('/mcp', { params: { page: 1, limit: 1 } }),
        apiClient.get<ListResponse<unknown>>('/skill-definitions', { params: { page: 1, limit: 1 } }),
        apiClient.get<{ items?: unknown[] }>('/events', { params: { limit: 5 } }),
        apiClient.get<{ items?: Array<{ status?: string }> }>('/approvals', { params: { status: 'pending', limit: 50 } }),
      ])

      const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : null
      const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value : null
      const mcp = mcpRes.status === 'fulfilled' ? mcpRes.value : null
      const skills = skillsRes.status === 'fulfilled' ? skillsRes.value : null
      const events =
        eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value.items)
          ? eventsRes.value.items
          : []
      const pendingApprovals =
        approvalsRes.status === 'fulfilled' && Array.isArray(approvalsRes.value.items)
          ? approvalsRes.value.items
          : []

      if (!agents && !sessions) {
        throw new Error(t('dashboard.error.coreData'))
      }

      const recentSessions = sessions?.data ?? []
      const sessionsActive = recentSessions.filter((s) => s.status === 'active').length

      setStats({
        agentsTotal: agents?.meta?.total ?? agents?.data?.length ?? 0,
        sessionsTotal: sessions?.meta?.total ?? recentSessions.length,
        sessionsActive,
        mcpTotal: mcp ? (mcp.meta?.total ?? mcp.data?.length ?? 0) : null,
        skillsTotal: skills ? (skills.meta?.total ?? skills.data?.length ?? 0) : null,
        recentSessions,
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
        icon: <Bot size={18} />,
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
        id: 'mcp',
        label: 'MCP',
        value: stats.mcpTotal,
        icon: <Puzzle size={18} />,
        hint: t('dashboard.cards.mcp.hint'),
      },
      {
        id: 'skills',
        label: 'Skills',
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
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(147,120,147,0.2),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(59,130,246,0.16),transparent_40%)]" />
            <div className="relative p-6 md:p-8">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <h1 className="text-2xl md:text-3xl font-semibold text-text-primary">
                    Semibot - A semi bot
                  </h1>
                  <p className="text-text-secondary max-w-2xl">
                    {t('dashboard.subtitle')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} />}
                  onClick={load}
                  disabled={isLoading}
                >
                  {t('common.refresh')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2 border-border-default">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.recentSessions.title')}</h2>
                <Link href="/chat" className="text-sm text-primary-400 hover:text-primary-300">
                  {t('dashboard.recentSessions.viewAll')}
                </Link>
              </div>
              <div className="mt-4 space-y-2">
                {isLoading ? (
                  [1, 2, 3].map((row) => (
                    <div
                      key={row}
                      className="h-14 animate-pulse rounded-lg border border-border-subtle bg-bg-elevated/60"
                    />
                  ))
                ) : stats.recentSessions.length > 0 ? (
                  stats.recentSessions.slice(0, 6).map((session) => (
                    <Link
                      key={session.id}
                      href={`/chat/${session.id}`}
                      className={clsx(
                        'group flex items-center justify-between rounded-lg border px-3 py-3',
                        'border-border-subtle bg-bg-surface hover:border-border-strong'
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {session.title || t('chatLayout.untitled')}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                          <Clock3 size={12} />
                          {formatRelativeTime(session.createdAt, locale)}
                        </div>
                      </div>
                      <ArrowRight
                        size={14}
                        className="text-text-tertiary transition-transform group-hover:translate-x-0.5"
                      />
                    </Link>
                  ))
                ) : (
                  <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                    {t('dashboard.recentSessions.empty')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.quickLinks.title')}</h2>
              <div className="mt-4 space-y-2">
                <QuickLink href={NEW_CHAT_PATH} title={t('dashboard.quickLinks.items.newChat.title')} desc={t('dashboard.quickLinks.items.newChat.desc')} />
                <QuickLink href="/agents" title={t('dashboard.quickLinks.items.agents.title')} desc={t('dashboard.quickLinks.items.agents.desc')} />
                <QuickLink href="/events" title={t('dashboard.quickLinks.items.events.title')} desc={t('dashboard.quickLinks.items.events.desc')} />
                <QuickLink href="/rules" title={t('dashboard.quickLinks.items.rules.title')} desc={t('dashboard.quickLinks.items.rules.desc')} />
                <QuickLink href="/approvals" title={t('dashboard.quickLinks.items.approvals.title')} desc={t('dashboard.quickLinks.items.approvals.desc')} />
                <QuickLink href="/tools" title={t('dashboard.quickLinks.items.tools.title')} desc={t('dashboard.quickLinks.items.tools.desc')} />
                <QuickLink href="/config" title={t('dashboard.quickLinks.items.config.title')} desc={t('dashboard.quickLinks.items.config.desc')} />
                <QuickLink href="/mcp" title={t('dashboard.quickLinks.items.mcp.title')} desc={t('dashboard.quickLinks.items.mcp.desc')} />
              </div>
              <div className="mt-5 rounded-lg border border-border-subtle bg-bg-elevated/70 p-3 text-xs text-text-secondary">
                <div className="flex items-center gap-2">
                  <Activity size={14} className="text-success-500" />
                  {t('dashboard.quickLinks.note')}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-border-default">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.recentEvents.title')}</h2>
              <Link href="/events" className="text-sm text-primary-400 hover:text-primary-300">
                {t('dashboard.recentEvents.open')}
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {stats.recentEvents.length > 0 ? (
                stats.recentEvents.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-text-primary truncate">{event.eventType}</p>
                      <Badge
                        variant={
                          event.riskHint === 'high'
                            ? 'error'
                            : event.riskHint === 'medium'
                              ? 'warning'
                              : event.riskHint === 'low'
                                ? 'success'
                                : 'outline'
                        }
                      >
                        {event.riskHint || t('events.unknown')}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {formatRelativeTime(event.createdAt, locale)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                  {t('dashboard.recentEvents.empty')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function QuickLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className={clsx(
        'group block rounded-lg border border-border-subtle px-3 py-3',
        'bg-bg-surface hover:border-border-strong'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <ArrowRight
          size={14}
          className="text-text-tertiary transition-transform group-hover:translate-x-0.5"
        />
      </div>
      <p className="mt-1 text-xs text-text-secondary">{desc}</p>
    </Link>
  )
}
