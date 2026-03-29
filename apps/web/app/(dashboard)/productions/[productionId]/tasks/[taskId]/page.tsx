"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ArtifactVersion, ProductionTask, ReviewJob, TaskAttempt } from '@/types'

export default function ProductionTaskPage() {
  const { t } = useLocale()
  const params = useParams<{ productionId: string; taskId: string }>()
  const { productionId, taskId } = params
  const [task, setTask] = useState<ProductionTask | null>(null)
  const [attempts, setAttempts] = useState<TaskAttempt[]>([])
  const [reviewJobs, setReviewJobs] = useState<ReviewJob[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactVersion[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const [taskRes, detailRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: ProductionTask }>(`/productions/${productionId}/tasks/${taskId}`),
        apiClient.get<{
          success: boolean
          data: { attempts: TaskAttempt[]; reviewJobs: ReviewJob[]; artifacts: ArtifactVersion[] }
        }>(`/productions/${productionId}`),
      ])
      const taskData = taskRes.data || null
      setTask(taskData)
      setAttempts((detailRes.data?.attempts || []).filter((attempt) => attempt.taskId === taskId))
      setReviewJobs((detailRes.data?.reviewJobs || []).filter((job) => job.taskId === taskId))
      setArtifacts((detailRes.data?.artifacts || []).filter((artifact) => artifact.createdByTaskId === taskId))
    } catch (error) {
      console.error('[APS] load task failed', error)
      toast.error(t('aps.errors.loadTaskDetail'))
    } finally {
      setIsLoading(false)
    }
  }, [productionId, taskId, t])

  useEffect(() => {
    void load()
  }, [load])

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
  if (!task) return <div className="flex flex-1 items-center justify-center text-muted-foreground">{t('aps.empty.taskNotFound')}</div>

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href={`/productions/${productionId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductionDetail')}
          </Link>
          <h1 className="text-2xl font-semibold">{task.title || task.key}</h1>
          <p className="text-sm text-muted-foreground">{task.kind} · {task.role} · {task.status}</p>
        </div>

        <Card>
          <CardContent className="p-5 space-y-3">
            <h2 className="font-semibold">{t('aps.fields.goal')}</h2>
            <p className="text-sm text-muted-foreground">{task.goal}</p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.detail.attempts')}</h2>
              {attempts.length === 0 ? <div className="text-sm text-muted-foreground">{t('aps.empty.noAttempts')}</div> : attempts.map((attempt) => (
                <Link key={attempt.id} href={`/productions/${productionId}/attempts/${attempt.id}`} className="block rounded-lg border border-border p-3 hover:bg-background/40">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-sm">{t('aps.labels.attemptNumber', { number: attempt.attemptNo })}</div>
                    <span className="px-2 py-1 rounded-md border border-border text-xs">{attempt.status}</span>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.detail.reviewJobs')}</h2>
              {reviewJobs.length === 0 ? <div className="text-sm text-muted-foreground">{t('aps.empty.noReviewJobs')}</div> : reviewJobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-border p-3">
                  <div className="font-medium text-sm">{job.reviewerRole}</div>
                  <div className="text-xs text-muted-foreground mt-1">{job.reviewerType} · {job.status}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="font-semibold">{t('aps.fields.artifact')}</h2>
              {artifacts.length === 0 ? <div className="text-sm text-muted-foreground">{t('aps.empty.noArtifacts')}</div> : artifacts.map((artifact) => (
                <Link key={artifact.id} href={`/productions/${productionId}/artifacts/${artifact.id}`} className="block rounded-lg border border-border p-3 hover:bg-background/40">
                  <div className="font-medium text-sm">{artifact.artifactKey} v{artifact.version}</div>
                  <div className="text-xs text-muted-foreground mt-1">{artifact.reviewState}</div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
