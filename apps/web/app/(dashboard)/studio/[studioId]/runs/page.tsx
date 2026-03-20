"use client"

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Loader2, Zap, CheckCircle, XCircle, Clock, Ban, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import type { Studio, StudioRun } from '@/types'

function StatusIcon({ status }: { status: StudioRun['status'] }) {
  if (status === 'completed') return <CheckCircle size={15} className="text-green-500 shrink-0" />
  if (status === 'failed') return <XCircle size={15} className="text-red-500 shrink-0" />
  if (status === 'cancelled') return <Ban size={15} className="text-muted-foreground shrink-0" />
  if (status === 'running') return <Loader2 size={15} className="animate-spin text-primary shrink-0" />
  return <Clock size={15} className="text-muted-foreground shrink-0" />
}

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成', failed: '失败', running: '运行中', pending: '等待中', cancelled: '已取消',
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-green-500/10 text-green-600',
  failed: 'bg-red-500/10 text-red-500',
  running: 'bg-primary/10 text-primary',
  pending: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

export default function StudioRunsPage() {
  const { studioId } = useParams<{ studioId: string }>()
  const router = useRouter()
  const { t } = useLocale()

  const [studio, setStudio] = useState<Studio | null>(null)
  const [runs, setRuns] = useState<StudioRun[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showRunModal, setShowRunModal] = useState(false)
  const [runInputs, setRunInputs] = useState('')
  const [isRunning, setIsRunning] = useState(false)

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true)
      const [studioRes, runsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: Studio }>(`/studios/${studioId}`),
        apiClient.get<{ success: boolean; data: StudioRun[] }>(`/studios/${studioId}/runs`),
      ])
      if (studioRes.success) setStudio(studioRes.data)
      if (runsRes.success) setRuns(runsRes.data ?? [])
    } catch {
      toast.error(t('studio.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [studioId, t])

  useEffect(() => { loadData() }, [loadData])

  // Poll while any run is active
  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'running' || r.status === 'pending')
    if (!hasActive) return
    const timer = setInterval(loadData, 3000)
    return () => clearInterval(timer)
  }, [runs, loadData])

  const handleRun = async () => {
    try {
      let inputs: Record<string, unknown> = {}
      if (runInputs.trim()) {
        try { inputs = JSON.parse(runInputs) } catch { toast.error(t('studio.error.invalidJson')); return }
      }
      setIsRunning(true)
      const res = await apiClient.post<{ success: boolean; data: { runId: string } }>(`/studios/${studioId}/runs`, { inputs })
      if (res.success && res.data) {
        setShowRunModal(false)
        router.push(`/studio/${studioId}/runs/${res.data.runId}`)
      }
    } catch {
      toast.error(t('studio.error.run'))
    } finally {
      setIsRunning(false)
    }
  }

  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'pending')
  const pastRuns = runs.filter((r) => r.status !== 'running' && r.status !== 'pending')

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-2 mb-6">
          <Button variant="secondary" size="sm" onClick={() => router.push(`/studio/${studioId}`)}>
            <ArrowLeft size={15} />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold truncate">{studio?.name}</h1>
            <p className="text-xs text-muted-foreground">{t('studio.runs')}</p>
          </div>
          <Button size="sm" onClick={() => setShowRunModal(true)}>
            <Zap size={14} className="mr-1.5" />
            {t('studio.run')}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Zap size={36} className="mx-auto mb-3 opacity-20" />
            <p className="text-sm">{t('studio.noRuns')}</p>
            <Button size="sm" className="mt-4" onClick={() => setShowRunModal(true)}>
              <Zap size={13} className="mr-1.5" />
              {t('studio.run')}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Active runs */}
            {activeRuns.length > 0 && (
              <div>
                <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">进行中</h2>
                <div className="space-y-2">
                  {activeRuns.map((run) => (
                    <RunRow key={run.id} run={run} studioId={studioId} />
                  ))}
                </div>
              </div>
            )}

            {/* Past runs */}
            {pastRuns.length > 0 && (
              <div>
                <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">历史记录</h2>
                <div className="space-y-2">
                  {pastRuns.map((run) => (
                    <RunRow key={run.id} run={run} studioId={studioId} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Modal open={showRunModal} onClose={() => setShowRunModal(false)} title={t('studio.run')}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('studio.runInputs')}</label>
            <textarea
              className="w-full h-32 text-sm font-mono border border-border rounded-lg p-3 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder='{\"key\": \"value\"}'
              value={runInputs}
              onChange={(e) => setRunInputs(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">{t('studio.runInputsHint')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onClick={() => setShowRunModal(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleRun} disabled={isRunning}>
              {isRunning && <Loader2 size={14} className="mr-1 animate-spin" />}
              <Zap size={14} className="mr-1" />
              {t('studio.run')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function RunRow({ run, studioId }: { run: StudioRun; studioId: string }) {
  const nodeCount = Object.keys(run.nodeResults).length
  const completedCount = Object.values(run.nodeResults).filter((r) => r.status === 'completed').length

  return (
    <Link href={`/studio/${studioId}/runs/${run.id}`}>
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all hover:shadow-sm cursor-pointer ${
        run.status === 'running' ? 'border-primary/30 bg-primary/5' :
        run.status === 'failed' ? 'border-red-500/20' : 'border-border hover:border-border/80'
      }`}>
        <StatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-muted-foreground">{run.id.slice(0, 12)}…</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${STATUS_STYLE[run.status] ?? STATUS_STYLE.pending}`}>
              {STATUS_LABEL[run.status] ?? run.status}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
            {nodeCount > 0 && (
              <span className="text-xs text-muted-foreground">{completedCount}/{nodeCount} 节点</span>
            )}
          </div>
          {run.status === 'running' && nodeCount > 0 && (
            <div className="mt-1.5 h-1 bg-muted rounded-full overflow-hidden w-32">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{ width: `${(completedCount / nodeCount) * 100}%` }}
              />
            </div>
          )}
        </div>
        <ChevronRight size={14} className="text-muted-foreground shrink-0" />
      </div>
    </Link>
  )
}
