"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, CheckCheck, ClipboardCheck, Loader2, PlayCircle, RotateCcw, UserCog, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ArtifactVersion, Escalation, Production, ProductionTask, ReviewJob } from '@/types'

interface HumanInboxItem {
  kind: 'review' | 'escalation'
  production: Production
  reviewJob?: ReviewJob
  artifact?: ArtifactVersion
  escalation?: Escalation
  task?: ProductionTask
}

export default function ProductionHumanInboxPage() {
  const { locale, t } = useLocale()
  const [items, setItems] = useState<HumanInboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<{ success: boolean; data: HumanInboxItem[] }>('/productions/inbox/human')
      if (res.success && Array.isArray(res.data)) setItems(res.data)
    } catch (error) {
      console.error('[APS] load human inbox failed', error)
      toast.error(t('aps.errors.loadHumanInbox'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const handleReviewDecision = async (reviewJobId: string, decision: 'approved' | 'request_revision' | 'rejected') => {
    try {
      setBusyId(reviewJobId)
      await apiClient.post(`/productions/review-jobs/${reviewJobId}/decision`, {
        decision,
        findings: [],
        revisionRequest: decision === 'request_revision'
          ? { mustFix: [t('aps.labels.defaultHumanRevisionInstruction')], shouldFix: [] }
          : undefined,
      })
      toast.success(t('aps.toast.reviewSubmitted', { decision }))
      await load()
    } catch (error) {
      console.error('[APS] human inbox review submit failed', error)
      toast.error(t('aps.errors.submitReview'))
    } finally {
      setBusyId(null)
    }
  }

  const handleResolve = async (productionId: string, escalationId: string) => {
    try {
      setBusyId(escalationId)
      await apiClient.post(`/productions/${productionId}/escalations/${escalationId}/resolve`, {
        decisionType: 'resume',
      })
      toast.success(t('aps.toast.escalationRestored'))
      await load()
    } catch (error) {
      console.error('[APS] human inbox escalation resolve failed', error)
      toast.error(t('aps.errors.resolveEscalation'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href="/productions" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductions')}
          </Link>
          <div className="flex items-center gap-2">
            <UserCog size={20} className="text-primary" />
            <h1 className="text-xl font-semibold">{t('aps.buttons.humanInbox')}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t('aps.humanInbox.subtitle')}</p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">{t('aps.empty.noHumanInbox')}</CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {items.map((item) => {
              const key = item.reviewJob?.id || item.escalation?.id || item.production.id
              return (
                <Card key={key}>
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-medium">{item.task?.title || item.task?.key || item.escalation?.reasonCode || item.reviewJob?.reviewerRole}</div>
                          <Badge variant={item.kind === 'escalation' ? 'error' : 'warning'}>{item.kind === 'escalation' ? t('aps.labels.escalation') : t('aps.labels.review')}</Badge>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          <Link href={`/productions/${item.production.id}`} className="text-primary hover:underline">
                            {item.production.name}
                          </Link>
                          {item.kind === 'review' ? ` · ${item.reviewJob?.reviewerRole} · ${item.reviewJob?.reviewerType}` : ` · ${item.escalation?.sourceType}`}
                        </div>
                      </div>
                      <span className="px-2 py-1 rounded-md border border-border text-xs">
                        {item.reviewJob?.status || item.escalation?.status || item.production.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                      <div className="rounded-lg border border-border p-3">
                        <div className="text-xs text-muted-foreground">{t('aps.fields.artifact')} / {t('aps.fields.task')}</div>
                        <div className="mt-1 font-medium">
                          {item.artifact ? (
                            <Link href={`/productions/${item.production.id}/artifacts/${item.artifact.id}`} className="text-primary hover:underline">
                              {item.artifact.artifactKey} v{item.artifact.version}
                            </Link>
                          ) : `${item.task?.kind || '--'} · ${item.task?.role || '--'}`}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.productionStatus')}</div>
                        <div className="mt-1 font-medium">{item.production.status}</div>
                      </div>
                      <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.createdAt')}</div>
                        <div className="mt-1 font-medium">{new Date(item.reviewJob?.createdAt || item.escalation?.createdAt || item.production.updatedAt).toLocaleString(locale)}</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {item.kind === 'review' && item.reviewJob ? (
                        <>
                          <Button size="sm" variant="secondary" disabled={busyId === item.reviewJob.id} onClick={() => void handleReviewDecision(item.reviewJob!.id, 'approved')}>
                            <CheckCheck size={14} className="mr-1" />
                            {t('aps.buttons.approve')}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busyId === item.reviewJob.id} onClick={() => void handleReviewDecision(item.reviewJob!.id, 'request_revision')}>
                            <RotateCcw size={14} className="mr-1" />
                            {t('aps.buttons.requestRevision')}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busyId === item.reviewJob.id} onClick={() => void handleReviewDecision(item.reviewJob!.id, 'rejected')}>
                            <XCircle size={14} className="mr-1" />
                            {t('aps.buttons.reject')}
                          </Button>
                        </>
                      ) : null}
                      {item.kind === 'escalation' && item.escalation ? (
                        <Button size="sm" variant="secondary" disabled={busyId === item.escalation.id} onClick={() => void handleResolve(item.production.id, item.escalation!.id)}>
                          <PlayCircle size={14} className="mr-1" />
                          {t('aps.buttons.resumeRun')}
                        </Button>
                      ) : null}
                      <Link href={`/productions/${item.production.id}`}>
                        <Button size="sm" variant="tertiary">
                          {item.kind === 'review' ? <ClipboardCheck size={14} className="mr-1" /> : <AlertTriangle size={14} className="mr-1" />}
                          {t('aps.buttons.viewProduction')}
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
