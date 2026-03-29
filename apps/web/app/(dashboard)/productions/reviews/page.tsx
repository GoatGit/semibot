"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, CheckCheck, ClipboardCheck, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ArtifactVersion, Production, ProductionTask, ReviewJob } from '@/types'

interface ReviewInboxItem {
  production: Production
  reviewJob: ReviewJob
  task?: ProductionTask
  artifact?: ArtifactVersion
}

export default function ProductionReviewInboxPage() {
  const { locale, t } = useLocale()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isValidStatus = (value: string | null): value is 'all' | ReviewJob['status'] =>
    value === 'all' || value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
  const queryStatus = searchParams.get('status')
  const [items, setItems] = useState<ReviewInboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [status, setStatus] = useState<'all' | ReviewJob['status']>(isValidStatus(queryStatus) ? queryStatus : 'all')

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<{ success: boolean; data: ReviewInboxItem[] }>('/productions/inbox/reviews')
      if (res.success && Array.isArray(res.data)) setItems(res.data)
    } catch (error) {
      console.error('[APS] load review inbox failed', error)
      toast.error(t('aps.errors.loadReviewInbox'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const next = isValidStatus(queryStatus) ? queryStatus : 'all'
    setStatus((current) => (current === next ? current : next))
  }, [queryStatus])

  const filteredItems = useMemo(
    () => items.filter((item) => status === 'all' || item.reviewJob.status === status),
    [items, status]
  )

  const updateStatus = (next: 'all' | ReviewJob['status']) => {
    setStatus(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('status')
    else params.set('status', next)
    const query = params.toString()
    router.replace(query ? `/productions/reviews?${query}` : '/productions/reviews', { scroll: false })
  }

  const handleDecision = async (reviewJobId: string, decision: 'approved' | 'request_revision' | 'rejected') => {
    try {
      setBusyId(reviewJobId)
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
      console.error('[APS] review inbox submit failed', error)
      toast.error(t('aps.errors.submitReview'))
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
            <ClipboardCheck size={20} className="text-primary" />
            <h1 className="text-xl font-semibold">{t('aps.buttons.reviewInbox')}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t('aps.reviewInbox.subtitle')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(['all', 'pending', 'running', 'completed', 'failed', 'cancelled'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => updateStatus(value)}
              className="inline-flex"
            >
              <Badge variant={status === value ? 'warning' : 'outline'}>
                {value === 'all' ? t('common.all') : value}
              </Badge>
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : filteredItems.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">{t('aps.empty.noReviewJobs')}</CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredItems.map(({ production, reviewJob, task, artifact }) => (
              <Card key={reviewJob.id}>
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="font-medium">{task?.title || task?.key || reviewJob.reviewerRole}</div>
                      <div className="text-sm text-muted-foreground">
                        <Link href={`/productions/${production.id}`} className="text-primary hover:underline">
                          {production.name}
                        </Link>
                        {' · '}
                        {reviewJob.reviewerRole} · {reviewJob.reviewerType}
                      </div>
                    </div>
                    <span className="px-2 py-1 rounded-md border border-border text-xs">{reviewJob.status}</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.artifact')}</div>
                      <div className="mt-1 font-medium">
                        {artifact ? (
                          <Link href={`/productions/${production.id}/artifacts/${artifact.id}`} className="text-primary hover:underline">
                            {artifact.artifactKey} v{artifact.version}
                          </Link>
                        ) : t('aps.empty.unlinked')}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.task')}</div>
                      <div className="mt-1 font-medium">{task?.kind || '--'} · {task?.role || '--'}</div>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.createdAt')}</div>
                      <div className="mt-1 font-medium">{new Date(reviewJob.createdAt).toLocaleString(locale)}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busyId === reviewJob.id} onClick={() => void handleDecision(reviewJob.id, 'approved')}>
                      <CheckCheck size={14} className="mr-1" />
                      {t('aps.buttons.approve')}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busyId === reviewJob.id} onClick={() => void handleDecision(reviewJob.id, 'request_revision')}>
                      <RotateCcw size={14} className="mr-1" />
                      {t('aps.buttons.requestRevision')}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busyId === reviewJob.id} onClick={() => void handleDecision(reviewJob.id, 'rejected')}>
                      <XCircle size={14} className="mr-1" />
                      {t('aps.buttons.reject')}
                    </Button>
                    <Link href={`/productions/${production.id}`}>
                      <Button size="sm" variant="tertiary">{t('aps.buttons.viewProduction')}</Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
