'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, RefreshCw, Clock3 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'

interface GatewayRunItem {
  runId: string
  runtimeSessionId: string
  snapshotVersion: number
  status: string
  resultSummary: string
  updatedAt: string
}

interface GatewayContextMessage {
  id: string
  contextVersion: number
  role: string
  content: string
  metadata: Record<string, unknown>
  createdAt: string
}

interface GatewayRunsResponse {
  success: boolean
  data?: {
    runs?: GatewayRunItem[]
  }
}

interface GatewayContextResponse {
  success: boolean
  data?: {
    messages?: GatewayContextMessage[]
  }
}

function formatTime(dateString: string, locale: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale)
}

function mapStatusVariant(status: string): 'outline' | 'success' | 'warning' | 'error' {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'done' || normalized === 'completed') return 'success'
  if (normalized === 'running' || normalized === 'queued') return 'warning'
  if (normalized === 'failed' || normalized === 'error') return 'error'
  return 'outline'
}

export default function GatewayConversationDetailPage() {
  const params = useParams<{ conversationId: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { locale, t } = useLocale()
  const conversationId = String(params?.conversationId || '').trim()
  const provider = String(searchParams.get('provider') || 'gateway')
  const chatId = String(searchParams.get('chatId') || '')
  const focusRunId = String(searchParams.get('runId') || '')

  const [runs, setRuns] = useState<GatewayRunItem[]>([])
  const [messages, setMessages] = useState<GatewayContextMessage[]>([])
  const [activeRunId, setActiveRunId] = useState<string>(focusRunId)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!conversationId) return
    try {
      setIsLoading(true)
      setError(null)
      const [runsRes, contextRes] = await Promise.all([
        apiClient.get<GatewayRunsResponse>(`/runtime/gateway/conversations/${encodeURIComponent(conversationId)}/runs`, { params: { limit: 50 } }),
        apiClient.get<GatewayContextResponse>(`/runtime/gateway/conversations/${encodeURIComponent(conversationId)}/context`, { params: { limit: 200 } }),
      ])

      const runItems = Array.isArray(runsRes.data?.runs) ? runsRes.data!.runs! : []
      const contextItems = Array.isArray(contextRes.data?.messages) ? contextRes.data!.messages! : []

      setRuns(runItems.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()))
      setMessages(contextItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dashboard.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [conversationId, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (focusRunId) {
      setActiveRunId(focusRunId)
      return
    }
    if (!activeRunId && runs.length > 0) {
      setActiveRunId(runs[0].runId)
    }
  }, [focusRunId, runs, activeRunId])

  const providerLabel = useMemo(() => {
    const normalized = provider.toLowerCase()
    if (normalized === 'telegram' || normalized === 'feishu' || normalized === 'web' || normalized === 'gateway') {
      return t(`dashboard.recentSessions.sources.${normalized}`)
    }
    return provider
  }, [provider, t])

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )

  const displayedMessages = useMemo(() => {
    if (!activeRunId) return messages
    const matched = messages.filter((message) => {
      const metadata = (message.metadata || {}) as Record<string, unknown>
      const messageRunId =
        (typeof metadata.run_id === 'string' && metadata.run_id) ||
        (typeof metadata.runId === 'string' && metadata.runId) ||
        (typeof metadata.task_run_id === 'string' && metadata.task_run_id) ||
        (typeof metadata.taskRunId === 'string' && metadata.taskRunId) ||
        ''
      return messageRunId === activeRunId
    })
    return matched.length > 0 ? matched : messages
  }, [messages, activeRunId])

  const handleSelectRun = useCallback((runId: string) => {
    setActiveRunId(runId)
    const paramsObj = new URLSearchParams(searchParams.toString())
    paramsObj.set('runId', runId)
    const query = paramsObj.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
                  <ArrowLeft size={14} />
                  {t('dashboard.gatewayDetail.back')}
                </Link>
                <h1 className="text-2xl font-semibold text-text-primary">{t('dashboard.gatewayDetail.title')}</h1>
                <p className="text-sm text-text-secondary">{t('dashboard.gatewayDetail.subtitle')}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                  <Badge variant="outline">{providerLabel}</Badge>
                  <span>{t('dashboard.gatewayDetail.conversationId')}: {conversationId}</span>
                  {chatId && <span>{t('dashboard.gatewayDetail.chatId')}: {chatId}</span>}
                </div>
              </div>
              <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={() => void load()} disabled={isLoading}>
                {t('common.refresh')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.gatewayDetail.runs')}</h2>
              <div className="mt-4 space-y-2">
                {runs.length > 0 ? (
                  runs.map((run) => (
                    <button
                      key={run.runId}
                      type="button"
                      onClick={() => handleSelectRun(run.runId)}
                      className={[
                        'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                        'hover:border-border-strong',
                        run.runId === activeRunId ? 'border-primary-500 bg-primary-500/5' : 'border-border-subtle bg-bg-surface'
                      ].join(' ')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">{run.resultSummary || run.runtimeSessionId}</p>
                        <Badge variant={mapStatusVariant(run.status)}>{run.status}</Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                        <Clock3 size={12} />
                        {formatTime(run.updatedAt, locale)}
                        <span>{run.runtimeSessionId}</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                    {t('dashboard.gatewayDetail.emptyRuns')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.gatewayDetail.context')}</h2>
              {selectedRun && (
                <div className="mt-4 rounded-lg border border-border-subtle bg-bg-surface px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {selectedRun.resultSummary || selectedRun.runtimeSessionId}
                    </p>
                    <Badge variant={mapStatusVariant(selectedRun.status)}>{selectedRun.status}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                    <Clock3 size={12} />
                    {formatTime(selectedRun.updatedAt, locale)}
                    <span>{selectedRun.runtimeSessionId}</span>
                  </div>
                </div>
              )}
              <div className="mt-4 space-y-2">
                {displayedMessages.length > 0 ? (
                  displayedMessages.map((message) => (
                    <div key={message.id} className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{message.role}</Badge>
                        <span className="text-xs text-text-tertiary">{formatTime(message.createdAt, locale)}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-primary">
                        {message.content || '--'}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-sm text-text-secondary">
                    {t('dashboard.gatewayDetail.emptyContext')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
