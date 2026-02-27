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

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / (1000 * 60))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export default function DashboardPage() {
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
        throw new Error('无法加载仪表盘核心数据，请检查 API 服务状态')
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
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const cards = useMemo(
    () => [
      {
        id: 'agents',
        label: 'Agent',
        value: stats.agentsTotal,
        icon: <Bot size={18} />,
        hint: '可用智能体',
      },
      {
        id: 'sessions',
        label: '会话',
        value: stats.sessionsTotal,
        icon: <MessageSquare size={18} />,
        hint: `进行中 ${stats.sessionsActive}`,
      },
      {
        id: 'mcp',
        label: 'MCP',
        value: stats.mcpTotal,
        icon: <Puzzle size={18} />,
        hint: '外部工具连接',
      },
      {
        id: 'skills',
        label: 'Skills',
        value: stats.skillsTotal,
        icon: <Sparkles size={18} />,
        hint: '技能定义',
      },
      {
        id: 'events',
        label: '事件',
        value: stats.eventsTotal,
        icon: <Activity size={18} />,
        hint: `待审批 ${stats.approvalsPending ?? 0}`,
      },
    ],
    [stats]
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
                    能干活、能提醒、能协作、能自己变强的数字员工。
                  </p>
                </div>
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} />}
                  onClick={load}
                  disabled={isLoading}
                >
                  刷新
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
                <h2 className="text-lg font-semibold text-text-primary">最近会话</h2>
                <Link href="/chat" className="text-sm text-primary-400 hover:text-primary-300">
                  查看全部
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
                          {session.title || '未命名会话'}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                          <Clock3 size={12} />
                          {formatRelativeTime(session.createdAt)}
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
                    暂无会话，去创建第一个对话任务。
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">快捷入口</h2>
              <div className="mt-4 space-y-2">
                <QuickLink href={NEW_CHAT_PATH} title="新建会话" desc="创建会话并立即提问" />
                <QuickLink href="/agents" title="管理 Agents" desc="创建、编辑、启停 Agent" />
                <QuickLink href="/events" title="事件中心" desc="查看触发事件并执行回放" />
                <QuickLink href="/rules" title="规则管理" desc="配置提醒、建议与自动执行策略" />
                <QuickLink href="/approvals" title="审批中心" desc="处理高风险动作审批请求" />
                <QuickLink href="/tools" title="Tools 能力" desc="查看运行时工具与数据库工具" />
                <QuickLink href="/config" title="配置管理" desc="模型、工具、Webhook 配置" />
                <QuickLink href="/mcp" title="MCP 集成" desc="连接外部工具与资源" />
              </div>
              <div className="mt-5 rounded-lg border border-border-subtle bg-bg-elevated/70 p-3 text-xs text-text-secondary">
                <div className="flex items-center gap-2">
                  <Activity size={14} className="text-success-500" />
                  当前界面已切换为新版导航信息架构。
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-border-default">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">最近事件</h2>
              <Link href="/events" className="text-sm text-primary-400 hover:text-primary-300">
                进入事件中心
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
                        {event.riskHint || 'unknown'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {formatRelativeTime(event.createdAt)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                  暂无事件数据
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
