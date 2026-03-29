"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ClipboardCheck, Factory, Loader2, Play, Plus, UserCog, Workflow } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { PageHeader } from '@/components/ui/PageHeader'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { Agent, Production, ProductionPortfolioSummary } from '@/types'

interface ControlRoomResponse {
  success: boolean
  data: ProductionPortfolioSummary
}

const severityWeight = { critical: 0, warning: 1, info: 2 } as const

export default function ProductionsPage() {
  const router = useRouter()
  const { t } = useLocale()
  const [summary, setSummary] = useState<ProductionPortfolioSummary | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [agentId, setAgentId] = useState('')

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const [summaryRes, agentRes] = await Promise.all([
        apiClient.get<ControlRoomResponse>('/productions/control-room'),
        apiClient.get<{ success: boolean; data: Agent[] }>('/agents'),
      ])
      if (summaryRes.success) setSummary(summaryRes.data)
      if (agentRes.success && Array.isArray(agentRes.data)) {
        setAgents(agentRes.data)
        if (!agentId && agentRes.data[0]?.id) setAgentId(agentRes.data[0].id)
      }
    } catch (error) {
      console.error('[APS] load control room failed', error)
      toast.error(t('aps.errors.loadControlRoom'))
    } finally {
      setIsLoading(false)
    }
  }, [agentId, t])

  useEffect(() => {
    void load()
  }, [load])

  const handleCreate = async () => {
    if (!name.trim() || !goal.trim() || !agentId) return
    try {
      setIsCreating(true)
      const response = await apiClient.post<{ success: boolean; data: { production: Production } | Production }>('/productions', {
        name: name.trim(),
        goal: goal.trim(),
        config: {
          defaultAgentId: agentId,
          autoStart: false,
          autoDispatch: false,
        },
      })
      const payload = response.data as { production?: Production } | Production | undefined
      const production = payload && 'production' in (payload as Record<string, unknown>)
        ? (payload as { production: Production }).production
        : payload as Production | undefined
      if (!production?.id) throw new Error('invalid production response')
      setShowCreate(false)
      setName('')
      setGoal('')
      router.push(`/productions/${production.id}`)
    } catch (error) {
      console.error('[APS] create failed', error)
      toast.error(t('aps.errors.createProduction'))
    } finally {
      setIsCreating(false)
    }
  }

  const sortedItems = useMemo(() => {
    return [...(summary?.items || [])].sort((left, right) => {
      const severityDelta =
        severityWeight[left.topIssue.severity as keyof typeof severityWeight]
        - severityWeight[right.topIssue.severity as keyof typeof severityWeight]
      if (severityDelta !== 0) return severityDelta
      const leftPressure =
        left.controlRoom.openEscalations + left.controlRoom.pendingReviews + left.controlRoom.failedTasks
      const rightPressure =
        right.controlRoom.openEscalations + right.controlRoom.pendingReviews + right.controlRoom.failedTasks
      if (rightPressure !== leftPressure) return rightPressure - leftPressure
      return new Date(right.production.updatedAt).getTime() - new Date(left.production.updatedAt).getTime()
    })
  }, [summary])
  const urgentItems = useMemo(() => sortedItems.filter((item) => item.topIssue.severity !== 'info'), [sortedItems])
  const healthyItems = useMemo(() => sortedItems.filter((item) => item.topIssue.severity === 'info'), [sortedItems])
  const formControlClassName = 'w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-base text-text-primary placeholder:text-text-tertiary transition-all duration-fast ease-out focus:border-primary-500 focus:shadow-glow-primary focus:outline-none'
  const formatPortfolioIssue = (code: string, fallback: string) => {
    switch (code) {
      case 'awaiting_human':
        return {
          title: t('aps.portfolioIssue.awaitingHumanTitle'),
          description: t('aps.portfolioIssue.awaitingHumanDescription'),
        }
      case 'blocked_stage':
        return {
          title: t('aps.portfolioIssue.blockedStageTitle'),
          description: t('aps.portfolioIssue.blockedStageDescription'),
        }
      case 'pending_reviews':
        return {
          title: t('aps.portfolioIssue.pendingReviewsTitle'),
          description: t('aps.portfolioIssue.pendingReviewsDescription'),
        }
      case 'failed_tasks':
        return {
          title: t('aps.portfolioIssue.failedTasksTitle'),
          description: t('aps.portfolioIssue.failedTasksDescription'),
        }
      case 'running':
        return {
          title: t('aps.portfolioIssue.runningTitle'),
          description: t('aps.portfolioIssue.runningDescription'),
        }
      case 'healthy':
        return {
          title: t('aps.portfolioIssue.healthyTitle'),
          description: t('aps.portfolioIssue.healthyDescription'),
        }
      default:
        return {
          title: fallback,
          description: fallback,
        }
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
        <PageHeader
          title={
            <div className="flex items-center gap-2">
              <span>{t('aps.controlRoom.title')}</span>
              <span className="px-2 py-1 rounded-md text-xs bg-primary/10 text-primary border border-primary/20">
                {t('aps.common.beta')}
              </span>
            </div>
          }
          subtitle={t('aps.controlRoom.subtitle')}
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
          }
        />

        <Card className="border-border-default">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/productions/human">
                <Button variant="secondary">
                  <UserCog size={16} className="mr-1" />
                  {t('aps.buttons.humanInbox')}
                </Button>
              </Link>
              <Link href="/productions/reviews">
                <Button variant="secondary">
                  <ClipboardCheck size={16} className="mr-1" />
                  {t('aps.buttons.reviewInbox')}
                </Button>
              </Link>
              <Link href="/productions/escalations">
                <Button variant="secondary">
                  <AlertTriangle size={16} className="mr-1" />
                  {t('aps.buttons.escalationInbox')}
                </Button>
              </Link>
              <Button onClick={() => setShowCreate(true)}>
                <Plus size={16} className="mr-1" />
                {t('aps.buttons.newProduction')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : !summary ? (
          <div className="text-center py-16 text-muted-foreground">
            <Factory size={40} className="mx-auto mb-3 opacity-30" />
            <p>{t('aps.controlRoom.empty')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.totalProductions')}</div><div className="text-2xl font-semibold mt-2">{summary.totals.productions}</div></CardContent></Card>
              <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.active')}</div><div className="text-2xl font-semibold mt-2">{summary.totals.active}</div></CardContent></Card>
              <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.awaitingHuman')}</div><div className="text-2xl font-semibold mt-2">{summary.totals.awaitingHuman}</div></CardContent></Card>
              <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.pendingReviewEscalation')}</div><div className="text-2xl font-semibold mt-2">{summary.totals.pendingReviews + summary.totals.openEscalations}</div></CardContent></Card>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_0.95fr] gap-6">
              <Card>
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{t('aps.sections.productions')}</h2>
                      <p className="text-sm text-muted-foreground">{t('aps.sections.productionsHint')}</p>
                    </div>
                    <Badge variant={urgentItems.length > 0 ? 'warning' : 'default'}>
                      {sortedItems.length > 0 ? t('aps.labels.productionCount', { count: sortedItems.length }) : t('common.noData')}
                    </Badge>
                  </div>
                  {sortedItems.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-8 text-center">{t('aps.empty.noControlRoomItems')}</div>
                  ) : (
                    <div className="space-y-3">
                      {sortedItems.map((item) => {
                        const issueText = formatPortfolioIssue(item.topIssue.code, item.topIssue.title)
                        return (
                        <div key={item.production.id} className="rounded-xl border border-border p-4 bg-card/50">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-3 min-w-0">
                              <div className="space-y-1">
                                <Link href={`/productions/${item.production.id}`} className="font-medium hover:text-primary">
                                  {item.production.name}
                                </Link>
                                <div className="text-sm text-muted-foreground">
                                  {issueText.title}
                                </div>
                              </div>
                              <p className="text-sm text-muted-foreground">{issueText.description}</p>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                                <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                                  <div className="text-text-tertiary">{t('aps.labels.currentStage')}</div>
                                  <div className="mt-1 truncate text-text-secondary">
                                    {item.currentStage ? item.currentStage.title : t('aps.empty.noStageYet')}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                                  <div className="text-text-tertiary">{t('aps.metrics.pendingReviewEscalation')}</div>
                                  <div className="mt-1 text-text-secondary">{item.controlRoom.pendingReviews}</div>
                                </div>
                                <div className="rounded-lg border border-border/70 bg-bg-surface px-3 py-2">
                                  <div className="text-text-tertiary">{t('aps.labels.tokens')}</div>
                                  <div className="mt-1 text-text-secondary">{item.controlRoom.totalTokens.toLocaleString()}</div>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center">
                              <Link href={`/productions/${item.production.id}`}>
                                <Button variant="secondary" size="sm">{t('aps.buttons.viewControlRoom')}</Button>
                              </Link>
                            </div>
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-6">
                <Card>
                  <CardContent className="p-5 space-y-4">
                    <div>
                      <h2 className="font-semibold">{t('aps.sections.priority')}</h2>
                      <p className="text-sm text-muted-foreground">{t('aps.sections.priorityHint')}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-border p-4">
                        <div className="text-xs text-muted-foreground">{t('aps.metrics.blockedStages')}</div>
                        <div className="text-2xl font-semibold mt-2">{summary.totals.blocked}</div>
                      </div>
                      <div className="rounded-xl border border-border p-4">
                        <div className="text-xs text-muted-foreground">{t('aps.metrics.runningTasks')}</div>
                        <div className="text-2xl font-semibold mt-2">{summary.totals.runningTasks}</div>
                      </div>
                      <div className="rounded-xl border border-border p-4">
                        <div className="text-xs text-muted-foreground">{t('aps.metrics.openEscalations')}</div>
                        <div className="text-2xl font-semibold mt-2">{summary.totals.openEscalations}</div>
                      </div>
                      <div className="rounded-xl border border-border p-4">
                        <div className="text-xs text-muted-foreground">{t('aps.metrics.totalTokens')}</div>
                        <div className="text-2xl font-semibold mt-2">{summary.totals.totalTokens.toLocaleString()}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center gap-2">
                      <Workflow size={16} className="text-primary" />
                      <h2 className="font-semibold">{t('aps.sections.healthy')}</h2>
                    </div>
                    {healthyItems.length === 0 ? (
                      <div className="text-sm text-muted-foreground">{t('aps.empty.noHealthy')}</div>
                    ) : (
                      <div className="space-y-3">
                        {healthyItems.slice(0, 5).map((item) => {
                          const issueText = formatPortfolioIssue(item.topIssue.code, item.topIssue.title)
                          return (
                          <Link key={item.production.id} href={`/productions/${item.production.id}`} className="block rounded-xl border border-border p-4 hover:border-primary/30">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                              <div className="font-medium truncate">{item.production.name}</div>
                              <div className="text-xs text-muted-foreground mt-1">
                                  {item.currentStage ? `${t('aps.labels.currentStage')}: ${item.currentStage.title}` : t('aps.empty.noStageYet')} · ${t('aps.labels.tokens')} ${item.controlRoom.totalTokens.toLocaleString()}
                              </div>
                            </div>
                            <Badge variant="default">{issueText.title}</Badge>
                            </div>
                          </Link>
                          )
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>

      <Modal
        open={showCreate}
        onClose={() => !isCreating && setShowCreate(false)}
        title={t('aps.create.title')}
        maxWidth="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">{t('aps.create.name')}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('aps.create.namePlaceholder')} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">{t('aps.create.goal')}</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className={`${formControlClassName} min-h-32 resize-y`}
              placeholder={t('aps.create.goalPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">{t('aps.create.defaultAgent')}</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className={formControlClassName}
            >
              <option value="">{t('aps.create.selectAgent')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={isCreating}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || !name.trim() || !goal.trim() || !agentId}>
              {isCreating ? <Loader2 size={16} className="mr-1 animate-spin" /> : <Play size={16} className="mr-1" />}
              {t('common.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
