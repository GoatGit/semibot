"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ProductionStage, ProductionTask } from '@/types'

export default function ProductionStagePage() {
  const { t } = useLocale()
  const params = useParams<{ productionId: string; stageId: string }>()
  const { productionId, stageId } = params
  const [stage, setStage] = useState<ProductionStage | null>(null)
  const [tasks, setTasks] = useState<ProductionTask[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const [stageRes, tasksRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: ProductionStage }>(`/productions/${productionId}/stages/${stageId}`),
        apiClient.get<{ success: boolean; data: ProductionTask[] }>(`/productions/${productionId}/tasks`),
      ])
      setStage(stageRes.data || null)
      setTasks((tasksRes.data || []).filter((task) => task.stageId === stageId))
    } catch (error) {
      console.error('[APS] load stage failed', error)
      toast.error(t('aps.errors.loadStageDetail'))
    } finally {
      setIsLoading(false)
    }
  }, [productionId, stageId, t])

  useEffect(() => {
    void load()
  }, [load])

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
  if (!stage) return <div className="flex flex-1 items-center justify-center text-muted-foreground">{t('aps.empty.stageNotFound')}</div>

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href={`/productions/${productionId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductionDetail')}
          </Link>
          <h1 className="text-2xl font-semibold">{stage.title}</h1>
          <p className="text-sm text-muted-foreground">{stage.status} · {t('aps.labels.sequence')} {stage.sequence}</p>
        </div>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div>
              <h2 className="font-semibold">{t('aps.stage.tasksTitle')}</h2>
              <p className="text-sm text-muted-foreground mt-1">{t('aps.stage.tasksHint')}</p>
            </div>
            <div className="space-y-3">
              {tasks.map((task) => (
                <Link key={task.id} href={`/productions/${productionId}/tasks/${task.id}`} className="block rounded-lg border border-border p-4 hover:bg-background/40">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{task.title || task.key}</div>
                      <div className="text-xs text-muted-foreground mt-1">{task.kind} · {task.role}</div>
                    </div>
                    <span className="px-2 py-1 rounded-md border border-border text-xs">{task.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
