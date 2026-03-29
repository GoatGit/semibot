"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { TaskAttempt } from '@/types'

export default function ProductionAttemptPage() {
  const { locale, t } = useLocale()
  const params = useParams<{ productionId: string; attemptId: string }>()
  const { productionId, attemptId } = params
  const [attempt, setAttempt] = useState<TaskAttempt | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<{ success: boolean; data: TaskAttempt }>(`/productions/${productionId}/attempts/${attemptId}`)
      setAttempt(res.data || null)
    } catch (error) {
      console.error('[APS] load attempt failed', error)
      toast.error(t('aps.errors.loadAttemptDetail'))
    } finally {
      setIsLoading(false)
    }
  }, [attemptId, productionId, t])

  useEffect(() => {
    void load()
  }, [load])

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
  if (!attempt) return <div className="flex flex-1 items-center justify-center text-muted-foreground">{t('aps.empty.attemptNotFound')}</div>

  const typedResult = attempt.outputResult && typeof attempt.outputResult === 'object'
    ? (attempt.outputResult as Record<string, unknown>).typedResult as Record<string, unknown> | undefined
    : undefined
  const productionEvents = attempt.outputResult && typeof attempt.outputResult === 'object'
    ? ((attempt.outputResult as Record<string, unknown>).events as Array<Record<string, unknown>> | undefined)
    : undefined
  const repairEvents = Array.isArray(productionEvents)
    ? productionEvents.filter((event) => typeof event?.eventType === 'string' && String(event.eventType).includes('repair'))
    : []

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href={`/productions/${productionId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductionDetail')}
          </Link>
          <h1 className="text-2xl font-semibold">{t('aps.labels.attemptNumber', { number: attempt.attemptNo })}</h1>
          <p className="text-sm text-muted-foreground">{attempt.status} · worker={attempt.workerId || '--'}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.started')}</div><div className="mt-2 font-medium">{new Date(attempt.startedAt).toLocaleString(locale)}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.ended')}</div><div className="mt-2 font-medium">{attempt.endedAt ? new Date(attempt.endedAt).toLocaleString(locale) : '--'}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.failure')}</div><div className="mt-2 font-medium">{attempt.failureKind || '--'}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.heartbeat')}</div><div className="mt-2 font-medium">{attempt.heartbeatAt ? new Date(attempt.heartbeatAt).toLocaleString(locale) : '--'}</div></CardContent></Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.attempt.inputEnvelope')}</h2>
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-border bg-background/60 p-4 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(attempt.inputEnvelope || {}, null, 2)}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.attempt.outputUsage')}</h2>
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-border bg-background/60 p-4 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify({ outputResult: attempt.outputResult, usage: attempt.usage, failureDetail: attempt.failureDetail }, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.attempt.typedResult')}</h2>
              {typedResult ? (
                <pre className="max-h-[420px] overflow-auto rounded-xl border border-border bg-background/60 p-4 whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(typedResult, null, 2)}
                </pre>
              ) : (
                <div className="rounded-xl border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  --
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.attempt.repairEvents')}</h2>
              <p className="text-sm text-muted-foreground">{t('aps.attempt.repairEventsHint')}</p>
              {repairEvents.length === 0 ? (
                <div className="rounded-xl border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  {t('aps.attempt.noRepairEvents')}
                </div>
              ) : (
                <div className="space-y-3">
                  {repairEvents.map((event, index) => (
                    <div key={`${String(event.id || event.createdAt || index)}`} className="rounded-xl border border-border bg-background/40 p-4">
                      <div className="font-medium text-sm">{String(event.eventType || 'repair')}</div>
                      <div className="text-xs text-muted-foreground mt-2">
                        {JSON.stringify(event.payload || {}, null, 2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
