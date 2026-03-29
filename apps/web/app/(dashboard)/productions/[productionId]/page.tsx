"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CheckCheck, GitBranch, Loader2, Play, RefreshCw, RotateCcw, TimerReset, Wand2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type {
  ArtifactVersion,
  Escalation,
  HumanDecision,
  Production,
  ProductionControlRoomSummary,
  ProductionEvent,
  ProductionPlan,
  ProductionStage,
  ProductionTask,
  ReviewDecision,
  ReviewJob,
  TaskAttempt,
} from '@/types'

interface ProductionDetailResponse {
  success: boolean
  data: {
    production: Production
    plan?: ProductionPlan
    stages: ProductionStage[]
    tasks: ProductionTask[]
    attempts: TaskAttempt[]
    artifacts: ArtifactVersion[]
    reviewJobs: ReviewJob[]
    reviewDecisions: ReviewDecision[]
    escalations: Escalation[]
    humanDecisions: HumanDecision[]
    events: ProductionEvent[]
    controlRoom: ProductionControlRoomSummary
  }
}

export default function ProductionDetailPage() {
  const params = useParams<{ productionId: string }>()
  const { locale, t } = useLocale()
  const productionId = params.productionId
  const [detail, setDetail] = useState<ProductionDetailResponse['data'] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [isReplanning, setIsReplanning] = useState(false)
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null)
  const [escalationBusyId, setEscalationBusyId] = useState<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [artifactContent, setArtifactContent] = useState<string>('')
  const [artifactContentLoading, setArtifactContentLoading] = useState(false)

  const load = useCallback(async () => {
    if (!productionId) return
    try {
      setIsLoading(true)
      const res = await apiClient.get<ProductionDetailResponse>(`/productions/${productionId}`)
      if (res.success && res.data) setDetail(res.data)
    } catch (error) {
      console.error('[APS] load detail failed', error)
      toast.error(t('aps.errors.loadProductionDetail'))
    } finally {
      setIsLoading(false)
    }
  }, [productionId, t])

  useEffect(() => {
    void load()
  }, [load])

  const handleRun = async () => {
    if (!productionId) return
    try {
      setIsRunning(true)
      await apiClient.post(`/productions/${productionId}/run`, {})
      toast.success(t('aps.toast.productionStarted'))
      await load()
    } catch (error) {
      console.error('[APS] run failed', error)
      toast.error(t('aps.errors.runProduction'))
    } finally {
      setIsRunning(false)
    }
  }

  const handleDispatchOne = async () => {
    if (!productionId) return
    try {
      setIsRunning(true)
      await apiClient.post(`/productions/${productionId}/dispatch`, {})
      await load()
    } catch (error) {
      console.error('[APS] dispatch failed', error)
      toast.error(t('aps.errors.dispatchTask'))
    } finally {
      setIsRunning(false)
    }
  }

  const handleReview = async (reviewJobId: string, decision: 'approved' | 'request_revision' | 'rejected') => {
    try {
      setReviewBusyId(reviewJobId)
      await apiClient.post(`/productions/review-jobs/${reviewJobId}/decision`, {
        decision,
        findings: [],
        revisionRequest: decision === 'request_revision'
          ? { mustFix: [t('aps.labels.defaultRevisionInstruction')], shouldFix: [] }
          : undefined,
      })
      toast.success(t('aps.toast.reviewSubmitted', { decision }))
      await load()
    } catch (error) {
      console.error('[APS] review submit failed', error)
      toast.error(t('aps.errors.submitReview'))
    } finally {
      setReviewBusyId(null)
    }
  }

  const handleResolveEscalation = async (escalationId: string) => {
    try {
      setEscalationBusyId(escalationId)
      await apiClient.post(`/productions/${productionId}/escalations/${escalationId}/resolve`, {
        decisionType: 'resume',
      })
      toast.success(t('aps.toast.escalationResolved'))
      await load()
    } catch (error) {
      console.error('[APS] escalation resolve failed', error)
      toast.error(t('aps.errors.resolveEscalation'))
    } finally {
      setEscalationBusyId(null)
    }
  }

  const handleQuickReplan = async () => {
    try {
      setIsReplanning(true)
      await apiClient.post(`/productions/${productionId}/replan`, {})
      toast.success(t('aps.toast.replanned'))
      await load()
    } catch (error) {
      console.error('[APS] replan failed', error)
      toast.error(t('aps.errors.replan'))
    } finally {
      setIsReplanning(false)
    }
  }

  const handleOpenArtifact = async (artifactId: string) => {
    try {
      setSelectedArtifactId(artifactId)
      setArtifactContentLoading(true)
      const res = await apiClient.get<{ success: boolean; data?: { artifact: ArtifactVersion; content: string } }>(
        `/productions/${productionId}/artifacts/${artifactId}/content`
      )
      setArtifactContent(res.data?.content || '')
    } catch (error) {
      console.error('[APS] load artifact content failed', error)
      toast.error(t('aps.errors.loadArtifactContent'))
    } finally {
      setArtifactContentLoading(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {t('aps.empty.productionNotFound')}
      </div>
    )
  }

  const formatReason = (reason?: string) => {
    switch (reason) {
      case 'review_rejected':
        return t('aps.reason.reviewRejected')
      case 'multiple_reviews_rejected':
        return t('aps.reason.multipleReviewsRejected')
      case 'review_requested_revision':
        return t('aps.reason.reviewRequestedRevision')
      case 'multiple_reviews_requested_revision':
        return t('aps.reason.multipleReviewsRequestedRevision')
      case 'pending_reviews':
        return t('aps.reason.pendingReviews')
      case 'failed_tasks':
        return t('aps.reason.failedTasks')
      case 'running_tasks':
        return t('aps.reason.runningTasks')
      case 'stage_ready_to_advance':
        return t('aps.reason.stageReadyToAdvance')
      case 'stage_not_ready':
        return t('aps.reason.stageNotReady')
      default:
        return reason || t('aps.labels.ok')
    }
  }

  const formatHealth = (health?: string) => {
    switch (health) {
      case 'healthy':
        return t('aps.health.healthy')
      case 'waiting_review':
        return t('aps.health.waitingReview')
      case 'blocked':
        return t('aps.health.blocked')
      case 'at_risk':
        return t('aps.health.atRisk')
      case 'completed':
        return t('aps.health.completed')
      default:
        return health || t('aps.labels.ok')
    }
  }

  const { production, stages, tasks, attempts, artifacts, events, reviewJobs, reviewDecisions, escalations, controlRoom } = detail
  const openEscalations = escalations.filter((item) => item.status === 'open')
  const pendingReviewJobs = reviewJobs.filter((item) => item.status !== 'completed')
  const failedTasks = tasks.filter((item) => item.status === 'failed')
  const latestEvents = events.slice(0, 5)
  const hottestAttempts = [...attempts]
    .sort((a, b) => Number((b.usage?.total_tokens as number | undefined) || 0) - Number((a.usage?.total_tokens as number | undefined) || 0))
    .slice(0, 3)
  const controlRoomItems = [
    ...openEscalations.map((item) => ({
      id: item.id,
      type: 'escalation',
      label: formatReason(item.reasonCode),
      detail: `${item.sourceType} · ${t('aps.labels.needsHumanIntervention')}`,
    })),
    ...pendingReviewJobs.map((item) => ({
      id: item.id,
      type: 'review',
      label: item.reviewerRole,
      detail: `${item.reviewerType} · ${t('aps.labels.reviewPending')}`,
    })),
    ...failedTasks.map((item) => ({
      id: item.id,
      type: 'task',
      label: item.title || item.key,
      detail: item.failureReason || t('aps.labels.taskFailed'),
    })),
  ].slice(0, 8)

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Link href="/productions" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft size={14} />
              {t('aps.buttons.backToProductions')}
            </Link>
            <h1 className="text-2xl font-semibold">{production.name}</h1>
            <p className="text-sm text-muted-foreground max-w-4xl">{production.goal}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void load()} disabled={isRunning}>
              <RefreshCw size={16} className="mr-1" />
              {t('common.refresh')}
            </Button>
            <Button variant="secondary" onClick={handleDispatchOne} disabled={isRunning}>
              <TimerReset size={16} className="mr-1" />
              {t('aps.buttons.dispatchOne')}
            </Button>
            <Button variant="secondary" onClick={handleQuickReplan} disabled={isRunning || isReplanning}>
              {isReplanning ? <Loader2 size={16} className="mr-1 animate-spin" /> : <Wand2 size={16} className="mr-1" />}
              {t('aps.buttons.quickReplan')}
            </Button>
            <Link href={`/productions/${productionId}/graph`}>
              <Button variant="secondary">
                <GitBranch size={16} className="mr-1" />
                {t('aps.buttons.graph')}
              </Button>
            </Link>
            <Button onClick={handleRun} disabled={isRunning}>
              {isRunning ? <Loader2 size={16} className="mr-1 animate-spin" /> : <Play size={16} className="mr-1" />}
              {t('aps.buttons.run')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.status')}</div><div className="text-2xl font-semibold mt-2">{production.status}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.stage')}</div><div className="text-2xl font-semibold mt-2">{stages.length}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.task')}</div><div className="text-2xl font-semibold mt-2">{tasks.length}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.artifact')}</div><div className="text-2xl font-semibold mt-2">{artifacts.length}</div></CardContent></Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.pendingReviews')}</div><div className="text-2xl font-semibold mt-2">{controlRoom.pendingReviews}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.humanIntervention')}</div><div className="text-2xl font-semibold mt-2">{controlRoom.openEscalations}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.runningTasks')}</div><div className="text-2xl font-semibold mt-2">{controlRoom.runningTasks}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.metrics.revisionChains')}</div><div className="text-2xl font-semibold mt-2">{controlRoom.revisionTasks}</div></CardContent></Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <h2 className="font-semibold">{t('aps.detail.controlRoom')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.controlRoomHint')}</p>
              </div>
              {controlRoomItems.length === 0 ? (
                <div className="text-sm text-muted-foreground">{t('aps.empty.noControlRoomItems')}</div>
              ) : (
                <div className="space-y-3">
                  {controlRoomItems.map((item) => (
                    <div key={`${item.type}-${item.id}`} className="rounded-lg border border-border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-sm">{item.label}</div>
                          <div className="text-xs text-muted-foreground mt-1">{item.detail}</div>
                        </div>
                        <span className="px-2 py-1 rounded-md border border-border text-xs">{item.type}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <h2 className="font-semibold">{t('aps.detail.latestSignals')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.latestSignalsHint')}</p>
              </div>
              <div className="space-y-3">
                {latestEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{t('aps.empty.noEvents')}</div>
                ) : latestEvents.map((event) => (
                  <div key={event.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-sm">{event.eventType}</div>
                      <div className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString(locale)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <h2 className="font-semibold">{t('aps.detail.stageHealth')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.stageHealthHint')}</p>
              </div>
              <div className="space-y-3">
                {controlRoom.stageHealth.map((item) => (
                  <div key={item.stageId} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                          <div className="font-medium text-sm">{item.stageTitle}</div>
                        <div className="text-xs text-muted-foreground mt-1">{formatReason(item.reason)}</div>
                      </div>
                      <span className="px-2 py-1 rounded-md border border-border text-xs">{formatHealth(item.health)}</span>
                    </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs text-muted-foreground">
                      <div>{t('aps.labels.tasksDone')}: {item.taskCounts.done}/{item.taskCounts.total}</div>
                      <div>{t('aps.labels.runningCount')}: {item.taskCounts.running}</div>
                      <div>{t('aps.labels.reviewPending')}: {item.reviewCounts.pending}</div>
                      <div>{t('aps.labels.rejected')}: {item.reviewCounts.rejected}</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <h2 className="font-semibold">{t('aps.detail.attemptHotspots')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.attemptHotspotsHint')}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{t('aps.metrics.totalTokens')}</div>
                <div className="text-2xl font-semibold mt-2">{controlRoom.totalTokens.toLocaleString()}</div>
              </div>
              <div className="space-y-3">
                {hottestAttempts.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{t('aps.empty.noAttemptHotspots')}</div>
                ) : hottestAttempts.map((attempt) => (
                  <Link key={attempt.id} href={`/productions/${productionId}/attempts/${attempt.id}`} className="block rounded-lg border border-border p-4 hover:bg-background/40">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-sm">{t('aps.labels.attemptNumber', { number: attempt.attemptNo })}</div>
                      <span className="px-2 py-1 rounded-md border border-border text-xs">{Number((attempt.usage?.total_tokens as number | undefined) || 0).toLocaleString()} {t('aps.labels.tokensLower')}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{attempt.status} · {attempt.failureKind || t('aps.labels.ok')}</div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_0.9fr] gap-6">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <h2 className="font-semibold">{t('aps.detail.stagesAndTasks')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.stagesAndTasksHint')}</p>
              </div>
              <div className="space-y-4">
                {stages.map((stage) => {
                  const stageTasks = tasks.filter((task) => task.stageId === stage.id)
                  return (
                    <div key={stage.id} className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <Link href={`/productions/${productionId}/stages/${stage.id}`} className="font-medium hover:text-primary">
                            {stage.title}
                          </Link>
                          <div className="text-xs text-muted-foreground">{stage.status} · {t('aps.labels.sequence')} {stage.sequence}</div>
                        </div>
                        <span className="px-2 py-1 rounded-md border border-border text-xs">{stageTasks.length} {t('aps.labels.tasks')}</span>
                      </div>
                      <div className="space-y-2">
                        {stageTasks.map((task) => (
                          <div key={task.id} className="rounded-lg border border-border/70 px-3 py-3 bg-background/40">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <Link href={`/productions/${productionId}/tasks/${task.id}`} className="font-medium hover:text-primary">
                                  {task.title || task.key}
                                </Link>
                                <div className="text-xs text-muted-foreground mt-1">{task.kind} · {task.role}</div>
                              </div>
                              <span className="px-2 py-1 rounded-md border border-border text-xs">{task.status}</span>
                            </div>
                            <p className="text-sm text-muted-foreground mt-3">{task.goal}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                <h2 className="font-semibold">{t('aps.detail.escalations')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.escalationsHint')}</p>
              </div>
              <div className="space-y-3">
                {escalations.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{t('aps.empty.noEscalations')}</div>
                  ) : escalations.slice(0, 6).map((escalation) => (
                    <div key={escalation.id} className="rounded-lg border border-border px-3 py-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-sm">{formatReason(escalation.reasonCode)}</div>
                          <div className="text-xs text-muted-foreground">{escalation.sourceType} · {escalation.status}</div>
                        </div>
                        {escalation.status === 'open' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={escalationBusyId === escalation.id}
                            onClick={() => void handleResolveEscalation(escalation.id)}
                          >
                            {t('aps.buttons.resumeRun')}
                          </Button>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground break-all">{escalation.id}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                <h2 className="font-semibold">{t('aps.detail.reviewJobs')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.reviewJobsHint')}</p>
              </div>
              <div className="space-y-3">
                {reviewJobs.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{t('aps.empty.noReviewJobs')}</div>
                  ) : reviewJobs.slice(0, 8).map((job) => {
                    const decision = reviewDecisions.find((item) => item.reviewJobId === job.id)
                    return (
                      <div key={job.id} className="rounded-lg border border-border px-3 py-3 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium text-sm">{job.reviewerRole}</div>
                            <div className="text-xs text-muted-foreground">{job.reviewerType} · {job.status}</div>
                          </div>
                          {decision ? (
                            <span className="px-2 py-1 rounded-md border border-border text-xs">{decision.decision}</span>
                          ) : (
                            <span className="px-2 py-1 rounded-md border border-border text-xs">{t('aps.labels.pending')}</span>
                          )}
                        </div>
                        {!decision && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={reviewBusyId === job.id}
                              onClick={() => void handleReview(job.id, 'approved')}
                            >
                              <CheckCheck size={14} className="mr-1" />
                              {t('aps.buttons.approve')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={reviewBusyId === job.id}
                              onClick={() => void handleReview(job.id, 'request_revision')}
                            >
                              <RotateCcw size={14} className="mr-1" />
                              {t('aps.buttons.requestRevision')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={reviewBusyId === job.id}
                              onClick={() => void handleReview(job.id, 'rejected')}
                            >
                              <XCircle size={14} className="mr-1" />
                              {t('aps.buttons.reject')}
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                <h2 className="font-semibold">{t('aps.detail.attempts')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.attemptsHint')}</p>
              </div>
                <div className="space-y-3">
                  {attempts.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{t('aps.empty.noAttempts')}</div>
                  ) : attempts.slice(0, 8).map((attempt) => (
                    <Link key={attempt.id} href={`/productions/${productionId}/attempts/${attempt.id}`} className="block rounded-lg border border-border px-3 py-3 hover:bg-background/40">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-sm">{t('aps.labels.attemptNumber', { number: attempt.attemptNo })}</div>
                        <span className="px-2 py-1 rounded-md border border-border text-xs">{attempt.status}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-2 break-all">{attempt.id}</div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <h2 className="font-semibold">{t('aps.fields.artifact')}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.artifactsHint')}</p>
                </div>
                <div className="space-y-3">
                  {artifacts.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{t('aps.empty.noArtifacts')}</div>
                  ) : artifacts.slice(0, 8).map((artifact) => (
                    <div key={artifact.id} className={`rounded-lg border px-3 py-3 transition-colors ${
                      selectedArtifactId === artifact.id ? 'border-primary bg-primary/5' : 'border-border'
                    }`}>
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => void handleOpenArtifact(artifact.id)}
                          className="min-w-0 flex-1 text-left hover:text-primary"
                        >
                          <div className="font-medium text-sm">{artifact.artifactKey} v{artifact.version}</div>
                          <div className="text-xs text-muted-foreground mt-2 break-all">{artifact.storageUri}</div>
                        </button>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 rounded-md border border-border text-xs">{artifact.reviewState}</span>
                          <Link href={`/productions/${productionId}/artifacts/${artifact.id}`}>
                            <Button size="sm" variant="tertiary">{t('aps.buttons.workspace')}</Button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {selectedArtifactId && (
                  <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">{t('aps.detail.artifactPreview')}</div>
                      {artifactContentLoading && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {artifactContentLoading ? t('aps.labels.loadingArtifactContent') : artifactContent || t('aps.empty.noArtifactContent')}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <h2 className="font-semibold">{t('aps.fields.events')}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{t('aps.detail.eventsHint')}</p>
                </div>
                <div className="space-y-3">
                  {events.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{t('aps.empty.noEvents')}</div>
                  ) : events.slice(0, 10).map((event) => (
                    <div key={event.id} className="rounded-lg border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-sm">{event.eventType}</div>
                        <div className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString(locale)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
