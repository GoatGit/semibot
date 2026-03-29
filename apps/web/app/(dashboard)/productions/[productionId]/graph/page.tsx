"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, GitCompare, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ProductionGraphDiffSummary, ProductionPlanSnapshot, ProductionStage, ProductionTask } from '@/types'

interface ProductionDetailResponse {
  success: boolean
  data: {
    stages: ProductionStage[]
    tasks: ProductionTask[]
    planSnapshots: ProductionPlanSnapshot[]
  }
}

interface GraphSummaryResponse {
  success: boolean
  data: ProductionGraphDiffSummary
}

export default function ProductionGraphPage() {
  const { locale, t } = useLocale()
  const params = useParams<{ productionId: string }>()
  const productionId = params.productionId
  const [stages, setStages] = useState<ProductionStage[]>([])
  const [tasks, setTasks] = useState<ProductionTask[]>([])
  const [plans, setPlans] = useState<ProductionPlanSnapshot[]>([])
  const [selectedBasePlanId, setSelectedBasePlanId] = useState('')
  const [graphSummary, setGraphSummary] = useState<ProductionGraphDiffSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<ProductionDetailResponse>(`/productions/${productionId}`)
      setStages(res.data?.stages || [])
      setTasks(res.data?.tasks || [])
      setPlans(res.data?.planSnapshots || [])
      const defaultBase = (res.data?.planSnapshots || [])[1]?.id || ''
      setSelectedBasePlanId(defaultBase)
    } catch (error) {
      console.error('[APS] load graph failed', error)
      toast.error(t('aps.errors.loadProductionGraph'))
    } finally {
      setIsLoading(false)
    }
  }, [productionId, t])

  const loadGraphSummary = useCallback(async (basePlanId?: string) => {
    try {
      const query = basePlanId ? `?basePlanId=${encodeURIComponent(basePlanId)}` : ''
      const res = await apiClient.get<GraphSummaryResponse>(`/productions/${productionId}/graph-summary${query}`)
      if (res.success) setGraphSummary(res.data)
    } catch (error) {
      console.error('[APS] load graph summary failed', error)
      toast.error(t('aps.errors.loadGraphDiff'))
    }
  }, [productionId, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!productionId) return
    void loadGraphSummary(selectedBasePlanId || undefined)
  }, [loadGraphSummary, productionId, selectedBasePlanId])

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const supersededSet = useMemo(() => new Set(graphSummary?.supersededTaskIds || []), [graphSummary])

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href={`/productions/${productionId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductionDetail')}
          </Link>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t('aps.graph.title')}</h1>
              <p className="text-sm text-muted-foreground mt-1">{t('aps.graph.subtitle')}</p>
            </div>
            <div className="flex items-center gap-2">
              <GitCompare size={16} className="text-primary" />
              <select
                value={selectedBasePlanId}
                onChange={(e) => setSelectedBasePlanId(e.target.value)}
                className="rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary focus:border-primary-500 focus:shadow-glow-primary focus:outline-none"
              >
                <option value="">{t('aps.graph.autoSelectPreviousPlan')}</option>
                {plans.slice(1).map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {t('aps.graph.planVersion', { version: plan.planVersion })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {graphSummary && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.graph.currentPlan')}</div><div className="mt-2 font-medium">{graphSummary.currentPlan ? `v${graphSummary.currentPlan.planVersion}` : '--'}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.graph.basePlan')}</div><div className="mt-2 font-medium">{graphSummary.basePlan ? `v${graphSummary.basePlan.planVersion}` : '--'}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.graph.addedTasks')}</div><div className="mt-2 font-medium">{graphSummary.stats.addedTasks}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.graph.removedTasks')}</div><div className="mt-2 font-medium">{graphSummary.stats.removedTasks}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.graph.superseded')}</div><div className="mt-2 font-medium">{graphSummary.stats.supersededTasks}</div></CardContent></Card>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
          <div className="space-y-4">
            {stages.map((stage) => {
              const stageTasks = tasks.filter((task) => task.stageId === stage.id)
              return (
                <Card key={stage.id}>
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold">{stage.title}</div>
                        <div className="text-xs text-muted-foreground">{stage.status} · {t('aps.labels.sequence')} {stage.sequence}</div>
                      </div>
                      <Link href={`/productions/${productionId}/stages/${stage.id}`} className="text-sm text-primary hover:underline">
                        {t('aps.buttons.openStage')}
                      </Link>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {stageTasks.map((task) => {
                        const isSuperseded = supersededSet.has(task.id)
                        return (
                          <div key={task.id} className={`rounded-xl border p-4 space-y-3 ${isSuperseded ? 'border-amber-500/30 bg-amber-500/5' : 'border-border'}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="font-medium">{task.title || task.key}</div>
                                <div className="text-xs text-muted-foreground mt-1">{task.kind} · {task.role}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                {isSuperseded ? <Badge variant="warning">{t('aps.graph.supersededBadge')}</Badge> : null}
                                <span className="px-2 py-1 rounded-md border border-border text-xs">{task.status}</span>
                              </div>
                            </div>
                            <div className="text-sm text-muted-foreground">{task.goal}</div>
                            <div className="space-y-1">
                              <div className="text-xs text-muted-foreground">{t('aps.graph.dependsOn')}</div>
                              {task.dependsOnTaskIds.length === 0 ? (
                                <div className="text-sm">{t('common.noData')}</div>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {task.dependsOnTaskIds.map((depId) => (
                                    <span key={depId} className="px-2 py-1 rounded-md border border-border text-xs">
                                      {taskById.get(depId)?.title || taskById.get(depId)?.key || depId.slice(-8)}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <Link href={`/productions/${productionId}/tasks/${task.id}`} className="text-sm text-primary hover:underline">
                              {t('aps.buttons.openTask')}
                            </Link>
                          </div>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <h2 className="font-semibold">{t('aps.graph.planHistory')}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{t('aps.graph.planHistoryHint')}</p>
                </div>
                <div className="space-y-3">
                  {plans.map((plan) => (
                    <div key={plan.id} className="rounded-xl border border-border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{t('aps.graph.planVersion', { version: plan.planVersion })}</div>
                          <div className="text-xs text-muted-foreground mt-1">{plan.plannerType} · {new Date(plan.createdAt).toLocaleString(locale)}</div>
                        </div>
                        {graphSummary?.currentPlan?.id === plan.id ? <Badge variant="default">{t('aps.graph.currentBadge')}</Badge> : null}
                      </div>
                      <div className="text-sm text-muted-foreground mt-2">{plan.rationale || '--'}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <h2 className="font-semibold">{t('aps.graph.replanDiff')}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{t('aps.graph.replanDiffHint')}</p>
                </div>
                {graphSummary ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">{t('aps.graph.addedStages')}</div>
                      <div className="flex flex-wrap gap-2">
                        {graphSummary.addedStageKeys.length === 0 ? <span className="text-sm text-muted-foreground">{t('common.noData')}</span> : graphSummary.addedStageKeys.map((key) => <Badge key={key} variant="success">{key}</Badge>)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">{t('aps.graph.removedStages')}</div>
                      <div className="flex flex-wrap gap-2">
                        {graphSummary.removedStageKeys.length === 0 ? <span className="text-sm text-muted-foreground">{t('common.noData')}</span> : graphSummary.removedStageKeys.map((key) => <Badge key={key} variant="error">{key}</Badge>)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">{t('aps.graph.addedTasks')}</div>
                      <div className="flex flex-wrap gap-2">
                        {graphSummary.addedTaskKeys.length === 0 ? <span className="text-sm text-muted-foreground">{t('common.noData')}</span> : graphSummary.addedTaskKeys.map((key) => <Badge key={key} variant="success">{key}</Badge>)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">{t('aps.graph.removedTasks')}</div>
                      <div className="flex flex-wrap gap-2">
                        {graphSummary.removedTaskKeys.length === 0 ? <span className="text-sm text-muted-foreground">{t('common.noData')}</span> : graphSummary.removedTaskKeys.map((key) => <Badge key={key} variant="error">{key}</Badge>)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">{t('aps.empty.noGraphDiff')}</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
