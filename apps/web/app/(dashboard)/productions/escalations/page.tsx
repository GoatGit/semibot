"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Loader2, PlayCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { Escalation, Production, ProductionTask } from '@/types'

interface EscalationInboxItem {
  production: Production
  escalation: Escalation
  task?: ProductionTask
}

export default function ProductionEscalationInboxPage() {
  const { locale, t } = useLocale()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isValidStatus = (value: string | null): value is 'all' | Escalation['status'] =>
    value === 'all' || value === 'open' || value === 'resolved' || value === 'cancelled'
  const queryStatus = searchParams.get('status')
  const [items, setItems] = useState<EscalationInboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [status, setStatus] = useState<'all' | Escalation['status']>(isValidStatus(queryStatus) ? queryStatus : 'all')

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<{ success: boolean; data: EscalationInboxItem[] }>('/productions/inbox/escalations')
      if (res.success && Array.isArray(res.data)) setItems(res.data)
    } catch (error) {
      console.error('[APS] load escalation inbox failed', error)
      toast.error(t('aps.errors.loadEscalationInbox'))
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
    () => items.filter((item) => status === 'all' || item.escalation.status === status),
    [items, status]
  )

  const updateStatus = (next: 'all' | Escalation['status']) => {
    setStatus(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('status')
    else params.set('status', next)
    const query = params.toString()
    router.replace(query ? `/productions/escalations?${query}` : '/productions/escalations', { scroll: false })
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
      console.error('[APS] escalation inbox resolve failed', error)
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
            <AlertTriangle size={20} className="text-primary" />
            <h1 className="text-xl font-semibold">{t('aps.buttons.escalationInbox')}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t('aps.escalationInbox.subtitle')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(['all', 'open', 'resolved', 'cancelled'] as const).map((value) => (
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
            <CardContent className="p-10 text-center text-sm text-muted-foreground">{t('aps.empty.noEscalations')}</CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredItems.map(({ production, escalation, task }) => (
              <Card key={escalation.id}>
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="font-medium">{escalation.reasonCode}</div>
                      <div className="text-sm text-muted-foreground">
                        <Link href={`/productions/${production.id}`} className="text-primary hover:underline">
                          {production.name}
                        </Link>
                        {' · '}
                        {escalation.sourceType}
                        {task ? ` · ${task.title || task.key}` : ''}
                      </div>
                    </div>
                    <span className="px-2 py-1 rounded-md border border-border text-xs">{escalation.status}</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.task')}</div>
                      <div className="mt-1 font-medium">{task?.kind || '--'} · {task?.role || '--'}</div>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.status')}</div>
                      <div className="mt-1 font-medium">{production.status}</div>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <div className="text-xs text-muted-foreground">{t('aps.fields.createdAt')}</div>
                      <div className="mt-1 font-medium">{new Date(escalation.createdAt).toLocaleString(locale)}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busyId === escalation.id} onClick={() => void handleResolve(production.id, escalation.id)}>
                      <PlayCircle size={14} className="mr-1" />
                      {t('aps.buttons.resumeRun')}
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
