'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, RefreshCw, Clock3, Wrench, Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'

interface MissingCapability {
  type?: string
  version?: string
  intent?: string
  reason?: string
  requiredCapabilities?: string[]
  preferredSources?: string[]
}

interface GatewayRunItem {
  runId: string
  runtimeSessionId: string
  snapshotVersion: number
  status: string
  resultSummary: string
  missingCapability?: MissingCapability | null
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

interface CapabilityInstallResponse {
  success: boolean
  data?: {
    resolution_mode?: 'recommend' | 'install'
    registry_name?: string
    install_request_id?: string
    recommended_skills?: Array<{
      skill_id?: string
      skill_name?: string
      risk_level?: string
    }>
    install_result?: {
      ok?: boolean
      registry_name?: string
    }
  }
}

interface CapabilityInstallRequestRecord {
  id: string
  task_id?: string | null
  session_id?: string | null
  target_type?: string
  target_id?: string
  approval_mode?: string
  state?: string
  error_text?: string | null
  metadata?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

interface CapabilityInstallHistoryResponse {
  success: boolean
  data?: {
    items?: CapabilityInstallRequestRecord[]
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
  const provider = String(searchParams.get('provider') || 'channel')
  const chatId = String(searchParams.get('chatId') || '')
  const focusRunId = String(searchParams.get('runId') || '')

  const [runs, setRuns] = useState<GatewayRunItem[]>([])
  const [messages, setMessages] = useState<GatewayContextMessage[]>([])
  const [activeRunId, setActiveRunId] = useState<string>(focusRunId)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [capabilityActionError, setCapabilityActionError] = useState<string | null>(null)
  const [capabilityResult, setCapabilityResult] = useState<CapabilityInstallResponse['data'] | null>(null)
  const [capabilityInstallRequest, setCapabilityInstallRequest] = useState<CapabilityInstallRequestRecord | null>(null)
  const [capabilityInstallHistory, setCapabilityInstallHistory] = useState<CapabilityInstallRequestRecord[]>([])
  const [isResolvingCapability, setIsResolvingCapability] = useState(false)
  const [isInstallingCapability, setIsInstallingCapability] = useState(false)
  const [isRetryingCapabilityTask, setIsRetryingCapabilityTask] = useState(false)

  const load = useCallback(async () => {
    if (!conversationId) return
    try {
      setIsLoading(true)
      setError(null)
      const [runsRes, contextRes] = await Promise.all([
        apiClient.get<GatewayRunsResponse>(`/runtime/channels/conversations/${encodeURIComponent(conversationId)}/runs`, { params: { limit: 50 } }),
        apiClient.get<GatewayContextResponse>(`/runtime/channels/conversations/${encodeURIComponent(conversationId)}/context`, { params: { limit: 200 } }),
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

  useEffect(() => {
    setCapabilityActionError(null)
    setCapabilityResult(null)
    setCapabilityInstallRequest(null)
    setCapabilityInstallHistory([])
  }, [activeRunId])

  const providerLabel = useMemo(() => {
    const normalized = provider.toLowerCase()
    if (normalized === 'telegram' || normalized === 'feishu' || normalized === 'web' || normalized === 'channel') {
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

  const selectedMissingCapability = selectedRun?.missingCapability ?? null
  const selectedTaskText = useMemo(
    () => displayedMessages.find((message) => message.role === 'user')?.content?.trim() || '',
    [displayedMessages]
  )

  const recommendedRegistryName = useMemo(() => {
    if (!capabilityResult) return ''
    const direct = String(capabilityResult.registry_name || '').trim()
    if (direct) return direct
    const firstSkill = capabilityResult.recommended_skills?.[0]
    return String(firstSkill?.skill_id || '').trim()
  }, [capabilityResult])

  const installRequestId = useMemo(
    () => String(capabilityInstallRequest?.id || capabilityResult?.install_request_id || '').trim(),
    [capabilityInstallRequest?.id, capabilityResult?.install_request_id]
  )

  const installState = String(capabilityInstallRequest?.state || '').trim()
  const installErrorText = String(capabilityInstallRequest?.error_text || '').trim()
  const retryResult = useMemo(() => {
    const metadata = (capabilityInstallRequest?.metadata || {}) as Record<string, unknown>
    const retry = metadata.retry_result
    return retry && typeof retry === 'object' ? (retry as Record<string, unknown>) : null
  }, [capabilityInstallRequest?.metadata])

  useEffect(() => {
    const sessionId = String(selectedRun?.runtimeSessionId || '').trim()
    if (!sessionId) {
      setCapabilityInstallHistory([])
      return
    }
    let cancelled = false
    const loadInstallHistory = async () => {
      try {
        const response = await apiClient.get<CapabilityInstallHistoryResponse>('/capabilities/install-history', {
          params: { sessionId, limit: 10 },
        })
        if (!cancelled) {
          setCapabilityInstallHistory(Array.isArray(response.data?.items) ? response.data!.items! : [])
        }
      } catch {
        if (!cancelled) {
          setCapabilityInstallHistory([])
        }
      }
    }
    void loadInstallHistory()
    return () => {
      cancelled = true
    }
  }, [selectedRun?.runtimeSessionId])

  useEffect(() => {
    if (!installRequestId) return
    if (!['awaiting_approval', 'installing', 'refreshing_catalog', 'retrying_task'].includes(installState)) {
      return
    }
    let cancelled = false
    const loadInstallStatus = async () => {
      try {
        const response = await apiClient.get<{ success: boolean; data?: CapabilityInstallRequestRecord }>(
          `/capabilities/install-status/${encodeURIComponent(installRequestId)}`
        )
        if (!cancelled) {
          setCapabilityInstallRequest(response.data ?? null)
        }
      } catch (err) {
        if (!cancelled) {
          setCapabilityActionError(err instanceof Error ? err.message : t('dashboard.channelDetail.capability.statusError'))
        }
      }
    }
    void loadInstallStatus()
    const timer = window.setInterval(() => void loadInstallStatus(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [installRequestId, installState, t])

  const handleResolveCapability = useCallback(async () => {
    if (!selectedMissingCapability?.intent) return
    try {
      setIsResolvingCapability(true)
      setCapabilityActionError(null)
      setCapabilityInstallRequest(null)
      const response = await apiClient.post<CapabilityInstallResponse>('/capabilities/resolve-missing', {
        missingCapability: selectedMissingCapability,
        taskId: selectedRun?.runId,
        sessionId: selectedRun?.runtimeSessionId,
        taskText: selectedTaskText || undefined,
        currentShortlistToolIds: [],
      })
      setCapabilityResult(response.data ?? null)
    } catch (err) {
      setCapabilityActionError(err instanceof Error ? err.message : t('dashboard.channelDetail.capability.resolveError'))
    } finally {
      setIsResolvingCapability(false)
    }
  }, [selectedMissingCapability, selectedRun?.runId, selectedRun?.runtimeSessionId, selectedTaskText, t])

  const handleInstallRecommended = useCallback(async () => {
    if (!installRequestId) return
    try {
      setIsInstallingCapability(true)
      setCapabilityActionError(null)
      const response = await apiClient.post<{ success: boolean; data?: CapabilityInstallRequestRecord }>('/capabilities/approve-install', {
        installRequestId,
        approved: true,
      })
      setCapabilityInstallRequest(response.data ?? null)
      await load()
    } catch (err) {
      setCapabilityActionError(err instanceof Error ? err.message : t('dashboard.channelDetail.capability.installError'))
    } finally {
      setIsInstallingCapability(false)
    }
  }, [installRequestId, load, t])

  const handleRetryCapabilityTask = useCallback(async () => {
    if (!installRequestId) return
    try {
      setIsRetryingCapabilityTask(true)
      setCapabilityActionError(null)
      const response = await apiClient.post<{ success: boolean; data?: CapabilityInstallRequestRecord }>('/capabilities/retry-task', {
        installRequestId,
      })
      setCapabilityInstallRequest(response.data ?? null)
      await load()
    } catch (err) {
      setCapabilityActionError(err instanceof Error ? err.message : t('dashboard.channelDetail.capability.retryError'))
    } finally {
      setIsRetryingCapabilityTask(false)
    }
  }, [installRequestId, load, t])

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
                  <ArrowLeft size={14} />
                  {t('dashboard.channelDetail.back')}
                </Link>
                <h1 className="text-2xl font-semibold text-text-primary">{t('dashboard.channelDetail.title')}</h1>
                <p className="text-sm text-text-secondary">{t('dashboard.channelDetail.subtitle')}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                  <Badge variant="outline">{providerLabel}</Badge>
                  <span>{t('dashboard.channelDetail.conversationId')}: {conversationId}</span>
                  {chatId && <span>{t('dashboard.channelDetail.chatId')}: {chatId}</span>}
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
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.channelDetail.runs')}</h2>
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
                    {t('dashboard.channelDetail.emptyRuns')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">{t('dashboard.channelDetail.context')}</h2>
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
              {selectedMissingCapability?.intent && (
                <div className="mt-4 rounded-lg border border-warning-500/30 bg-warning-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full bg-warning-500/15 p-2 text-warning-500">
                      <Wrench size={16} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">
                          {t('dashboard.channelDetail.capability.title')}
                        </p>
                        <Badge variant="warning">{selectedMissingCapability.intent}</Badge>
                      </div>
                      <p className="text-sm text-text-secondary">
                        {selectedMissingCapability.reason || t('dashboard.channelDetail.capability.noReason')}
                      </p>
                      {Array.isArray(selectedMissingCapability.requiredCapabilities) &&
                        selectedMissingCapability.requiredCapabilities.length > 0 && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            {selectedMissingCapability.requiredCapabilities.map((item) => (
                              <Badge key={item} variant="outline">{item}</Badge>
                            ))}
                          </div>
                        )}
                    </div>
                  </div>

                  {capabilityActionError && (
                    <InlineErrorAlert
                      className="px-3 py-2 text-xs"
                      message={capabilityActionError}
                      onClose={() => setCapabilityActionError(null)}
                    />
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Sparkles size={14} />}
                      loading={isResolvingCapability}
                      onClick={() => void handleResolveCapability()}
                    >
                      {t('dashboard.channelDetail.capability.find')}
                    </Button>
                    {recommendedRegistryName ? (
                      <Button
                        size="sm"
                        leftIcon={<Wrench size={14} />}
                        loading={isInstallingCapability}
                        onClick={() => void handleInstallRecommended()}
                      >
                        {t('dashboard.channelDetail.capability.install')}
                      </Button>
                    ) : null}
                    {installRequestId && installState === 'completed' && !retryResult ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<RefreshCw size={14} />}
                        loading={isRetryingCapabilityTask}
                        onClick={() => void handleRetryCapabilityTask()}
                      >
                        {t('dashboard.channelDetail.capability.retry')}
                      </Button>
                    ) : null}
                    <Link href="/skills" className="inline-flex">
                      <Button size="sm" variant="tertiary">
                        {t('dashboard.channelDetail.capability.openSkills')}
                      </Button>
                    </Link>
                  </div>

                  {installRequestId ? (
                    <div className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-3 space-y-1 text-sm">
                      <p className="font-medium text-text-primary">
                        {t('dashboard.channelDetail.capability.installRequest')}: {installRequestId}
                      </p>
                      <p className="text-text-secondary">
                        {t('dashboard.channelDetail.capability.state')}: {installState || '--'}
                      </p>
                      {installErrorText ? (
                        <p className="text-error-500">{installErrorText}</p>
                      ) : null}
                      {retryResult ? (
                        <p className="text-success-600">{t('dashboard.channelDetail.capability.retrySuccess')}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {capabilityInstallHistory.length > 0 ? (
                    <div className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-3 space-y-2">
                      <p className="text-sm font-medium text-text-primary">
                        {t('dashboard.channelDetail.capability.history')}
                      </p>
                      <div className="space-y-2">
                        {capabilityInstallHistory.map((item) => (
                          <div key={item.id} className="rounded-md border border-border-subtle px-3 py-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate font-medium text-text-primary">{item.target_id || item.id}</p>
                              <Badge variant={mapStatusVariant(String(item.state || 'outline'))}>{item.state || '--'}</Badge>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-text-tertiary">
                              <span>{item.target_type || '--'}</span>
                              <span>{formatTime(String(item.updated_at || item.created_at || ''), locale)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {capabilityResult?.resolution_mode === 'recommend' && (
                    <div className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-3 space-y-2">
                      <p className="text-sm font-medium text-text-primary">
                        {t('dashboard.channelDetail.capability.recommendation')}
                      </p>
                      {capabilityResult.recommended_skills?.length ? (
                        <div className="space-y-2">
                          {capabilityResult.recommended_skills.map((item) => (
                            <div key={item.skill_id || item.skill_name} className="flex items-center justify-between gap-3 text-sm">
                              <div className="min-w-0">
                                <p className="truncate text-text-primary">{item.skill_name || item.skill_id || '--'}</p>
                                {item.skill_id && (
                                  <p className="truncate text-xs text-text-tertiary">{item.skill_id}</p>
                                )}
                              </div>
                              {item.risk_level ? <Badge variant="outline">{item.risk_level}</Badge> : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-secondary">{t('dashboard.channelDetail.capability.noRecommendation')}</p>
                      )}
                    </div>
                  )}

                  {capabilityResult?.resolution_mode === 'install' && (
                    <div className="rounded-lg border border-success-500/30 bg-success-500/10 px-3 py-3 text-sm text-success-600">
                      {t('dashboard.channelDetail.capability.installSuccess')}
                    </div>
                  )}
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
                    {t('dashboard.channelDetail.emptyContext')}
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
