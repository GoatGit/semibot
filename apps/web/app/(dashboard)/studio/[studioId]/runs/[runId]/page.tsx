"use client"

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Loader2, CheckCircle, XCircle, Clock, Ban,
  ChevronDown, ChevronRight, FileText, AlertCircle, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import type { StudioRun, NodeResult } from '@/types'

function statusLabel(status: StudioRun['status'] | NodeResult['status']) {
  const map: Record<string, string> = {
    completed: '已完成', failed: '失败', running: '运行中',
    pending: '等待中', cancelled: '已取消',
  }
  return map[status] ?? status
}

function NodeStatusIcon({ status, size = 16 }: { status: NodeResult['status']; size?: number }) {
  if (status === 'completed') return <CheckCircle size={size} className="text-green-500 shrink-0" />
  if (status === 'failed') return <XCircle size={size} className="text-red-500 shrink-0" />
  if (status === 'running') return <Loader2 size={size} className="animate-spin text-primary shrink-0" />
  return <Clock size={size} className="text-muted-foreground shrink-0" />
}

function RunStatusBadge({ status }: { status: StudioRun['status'] }) {
  const styles: Record<string, string> = {
    completed: 'bg-green-500/10 text-green-600 border-green-500/20',
    failed: 'bg-red-500/10 text-red-500 border-red-500/20',
    running: 'bg-primary/10 text-primary border-primary/20',
    pending: 'bg-muted text-muted-foreground border-border',
    cancelled: 'bg-muted text-muted-foreground border-border',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${styles[status] ?? styles.pending}`}>
      {status === 'running' && <Loader2 size={10} className="animate-spin" />}
      {status === 'completed' && <CheckCircle size={10} />}
      {status === 'failed' && <XCircle size={10} />}
      {status === 'cancelled' && <Ban size={10} />}
      {status === 'pending' && <Clock size={10} />}
      {statusLabel(status)}
    </span>
  )
}

function NodeResultCard({ nodeId, result }: { nodeId: string; result: NodeResult }) {
  const [expanded, setExpanded] = useState(result.status === 'running')

  useEffect(() => {
    if (result.status === 'running') setExpanded(true)
  }, [result.status])

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${
      result.status === 'running' ? 'border-primary/40 shadow-sm shadow-primary/10' :
      result.status === 'completed' ? 'border-green-500/20' :
      result.status === 'failed' ? 'border-red-500/20' : 'border-border'
    }`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <NodeStatusIcon status={result.status} size={15} />
        <span className="text-sm font-medium flex-1">{nodeId}</span>
        {result.sessionId && (
          <span className="text-xs text-muted-foreground font-mono">{result.sessionId.slice(0, 8)}…</span>
        )}
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          result.status === 'running' ? 'bg-primary/10 text-primary' :
          result.status === 'completed' ? 'bg-green-500/10 text-green-600' :
          result.status === 'failed' ? 'bg-red-500/10 text-red-500' :
          'bg-muted text-muted-foreground'
        }`}>{statusLabel(result.status)}</span>
        {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
          {result.status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-primary">
              <Loader2 size={12} className="animate-spin" />
              正在处理中…
            </div>
          )}
          {result.output?.text && (
            <div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
                <FileText size={11} />
                输出内容
              </div>
              <pre className="text-xs whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-background rounded-lg p-3 border border-border leading-relaxed">
                {result.output.text}
              </pre>
            </div>
          )}
          {result.output && result.output.files.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground mb-1">输出文件</div>
              {result.output.files.map((f, i) => (
                <a key={i} href={f.url} target="_blank" rel="noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1">
                  <FileText size={11} />
                  {f.filename}
                </a>
              ))}
            </div>
          )}
          {result.error && (
            <div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/5 rounded-lg p-3">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              {result.error}
            </div>
          )}
          {!result.output?.text && !result.error && result.status !== 'running' && (
            <p className="text-xs text-muted-foreground">暂无输出</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function StudioRunDetailPage() {
  const { studioId, runId } = useParams<{ studioId: string; runId: string }>()
  const router = useRouter()
  const { t } = useLocale()

  const [run, setRun] = useState<StudioRun | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const eventSourceRef = useRef<EventSource | null>(null)

  const loadRun = useCallback(async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: StudioRun }>(`/studios/${studioId}/runs/${runId}`)
      if (res.success) setRun(res.data)
    } catch {
      toast.error(t('studio.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [studioId, runId, t])

  useEffect(() => { loadRun() }, [loadRun])

  useEffect(() => {
    if (!run) return
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return

    const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001') + '/api/v1'
    const es = new EventSource(`${apiBase}/studios/${studioId}/runs/${runId}/stream`)
    eventSourceRef.current = es

    es.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data)
        setRun((prev) => prev ? { ...prev, ...data } : prev)
      } catch { /* ignore */ }
    })

    es.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data)
        setRun((prev) => prev ? { ...prev, status: data.status, error: data.error } : prev)
      } catch { /* ignore */ }
      es.close()
    })

    es.onerror = () => { es.close() }
    return () => { es.close() }
  }, [run, run?.status, studioId, runId])

  const handleCancel = async () => {
    try {
      await apiClient.delete(`/studios/${studioId}/runs/${runId}`)
      await loadRun()
    } catch {
      toast.error(t('studio.error.cancel'))
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!run) return null

  const nodeEntries = Object.entries(run.nodeResults)
  const completedCount = nodeEntries.filter(([, r]) => r.status === 'completed').length
  const totalCount = nodeEntries.length

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-2 mb-6">
          <Button variant="secondary" size="sm" onClick={() => router.push(`/studio/${studioId}/runs`)}>
            <ArrowLeft size={15} />
          </Button>
          <h1 className="text-lg font-semibold flex-1">{t('studio.runDetail')}</h1>
          {(run.status === 'pending' || run.status === 'running') && (
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              <Ban size={13} className="mr-1.5" />
              {t('studio.cancel')}
            </Button>
          )}
        </div>

        {/* Run summary card */}
        <div className="rounded-xl border border-border bg-card p-4 mb-6 space-y-3">
          <div className="flex items-center justify-between">
            <RunStatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground font-mono">{run.id.slice(0, 16)}…</span>
          </div>

          {/* Progress bar for running */}
          {run.status === 'running' && totalCount > 0 && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>进度</span>
                <span>{completedCount} / {totalCount} 节点</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t('studio.startedAt')}: {new Date(run.createdAt).toLocaleString()}</span>
            {run.completedAt && (
              <span>{t('studio.completedAt')}: {new Date(run.completedAt).toLocaleString()}</span>
            )}
          </div>

          {run.error && (
            <div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/5 rounded-lg p-3 mt-1">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              {run.error}
            </div>
          )}
        </div>

        {/* Node results */}
        {nodeEntries.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} className="text-muted-foreground" />
              <h2 className="text-sm font-medium text-muted-foreground">{t('studio.nodeResults')}</h2>
              {totalCount > 0 && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {completedCount}/{totalCount} 完成
                </span>
              )}
            </div>
            <div className="space-y-2">
              {nodeEntries.map(([nodeId, result]) => (
                <NodeResultCard key={nodeId} nodeId={nodeId} result={result} />
              ))}
            </div>
          </div>
        )}

        {nodeEntries.length === 0 && run.status === 'pending' && (
          <div className="text-center py-12 text-muted-foreground">
            <Clock size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">等待执行中…</p>
          </div>
        )}
      </div>
    </div>
  )
}
