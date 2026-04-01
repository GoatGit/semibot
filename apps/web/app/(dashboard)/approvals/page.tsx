'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, CheckCircle2, XCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { EmptyStateActions } from '@/components/ui/EmptyStateActions'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { PageHelpStrip } from '@/components/ui/PageHelpStrip'
import { PageHeader } from '@/components/ui/PageHeader'
import { useApprovals } from '@/hooks/useApprovals'
import type { ApprovalRecord, RuntimeAttemptView } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'
import { copyToClipboard } from '@/lib/utils'
import { extractApprovalAttemptId, extractApprovalSessionId, tailId } from '@/lib/runtime-attempt-ui'
import { apiClient } from '@/lib/api'
import { useLayoutStore } from '@/stores/layoutStore'
import { buildAttemptDetailContent, buildAttemptDetailTitle } from '@/lib/runtime-attempt-detail'

function mapRiskVariant(risk: ApprovalRecord['riskLevel']): 'success' | 'warning' | 'error' {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  return 'success'
}

function mapStatusVariant(status: ApprovalRecord['status']): 'default' | 'success' | 'warning' | 'error' {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'error'
  if (status === 'expired') return 'warning'
  return 'default'
}

function formatTime(dateString: string, locale: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale)
}

function buildApprovalDetail(
  approval: ApprovalRecord,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const parts: string[] = []

  if (approval.toolName) {
    parts.push(t('approvals.detail.tool', { tool: `\`${approval.toolName}\`` }))
  }
  if (approval.capabilityId) {
    parts.push(`Capability: \`${approval.capabilityId}\``)
  }
  if (approval.action) {
    parts.push(t('approvals.detail.action', { action: `\`${approval.action}\`` }))
  }
  if (approval.target) {
    parts.push(t('approvals.detail.target', { target: `\`${approval.target}\`` }))
  }

  if (parts.length > 0) return parts.join(' · ')
  return approval.summary || ''
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function extractSkillOrchestrationTrace(approval: ApprovalRecord): Record<string, unknown> | null {
  const context = readObject(approval.context)
  if (!context) return null
  const direct = readObject(context.skill_orchestration_trace)
  if (direct) return direct
  const camel = readObject(context.skillOrchestrationTrace)
  if (camel) return camel
  return null
}

export default function ApprovalsPage() {
  const { locale, t } = useLocale()
  const router = useRouter()
  const { openDetailContent } = useLayoutStore()
  const searchParams = useSearchParams()
  const statusOptions = [
    { value: 'all', label: t('approvals.status.all') },
    { value: 'pending', label: t('approvals.status.pending') },
    { value: 'approved', label: t('approvals.status.approved') },
    { value: 'rejected', label: t('approvals.status.rejected') },
    { value: 'expired', label: t('approvals.status.expired') },
  ]
  const isValidStatus = (value: string | null): value is 'all' | ApprovalRecord['status'] =>
    value === 'all' || value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired'
  const queryStatus = searchParams.get('status')
  const queryCapability = searchParams.get('capability')
  const [status, setStatus] = useState<'all' | ApprovalRecord['status']>(isValidStatus(queryStatus) ? queryStatus : 'all')
  const [capabilityQuery, setCapabilityQuery] = useState(queryCapability ?? '')
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const {
    approvals,
    isLoading,
    error,
    apiAvailable,
    loadApprovals,
    resolveApproval,
  } = useApprovals()

  useEffect(() => {
    const next = isValidStatus(queryStatus) ? queryStatus : 'all'
    setStatus((current) => (current === next ? current : next))
  }, [queryStatus])

  useEffect(() => {
    const next = queryCapability ?? ''
    setCapabilityQuery((current) => (current === next ? current : next))
  }, [queryCapability])

  useEffect(() => {
    void loadApprovals({ status, capability: capabilityQuery.trim() || undefined, limit: 100 })
  }, [capabilityQuery, loadApprovals, status])

  const updateStatus = (next: 'all' | ApprovalRecord['status']) => {
    setStatus(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('status')
    else params.set('status', next)
    if (capabilityQuery.trim()) params.set('capability', capabilityQuery.trim())
    else params.delete('capability')
    const query = params.toString()
    router.replace(query ? `/approvals?${query}` : '/approvals', { scroll: false })
  }

  const updateCapabilityQuery = (next: string) => {
    setCapabilityQuery(next)
    const params = new URLSearchParams(searchParams.toString())
    if (status === 'all') params.delete('status')
    else params.set('status', status)
    if (next.trim()) params.set('capability', next.trim())
    else params.delete('capability')
    const query = params.toString()
    router.replace(query ? `/approvals?${query}` : '/approvals', { scroll: false })
  }

  const filteredApprovals = approvals

  const stats = useMemo(() => {
    const pending = filteredApprovals.filter((item) => item.status === 'pending').length
    return { pending, total: filteredApprovals.length }
  }, [filteredApprovals])

  const pendingIds = useMemo(
    () => filteredApprovals.filter((item) => item.status === 'pending').map((item) => item.id),
    [filteredApprovals]
  )

  const handleResolve = async (id: string, decision: 'approve' | 'reject') => {
    try {
      setActionError(null)
      setResolvingId(id)
      await resolveApproval(id, decision)
      await loadApprovals({ status, capability: capabilityQuery.trim() || undefined, limit: 100 })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('approvals.error.action'))
    } finally {
      setResolvingId(null)
    }
  }

  const handleBulkResolve = async (decision: 'approve' | 'reject') => {
    if (pendingIds.length === 0 || resolvingId || bulkAction) return
    setActionError(null)
    setBulkAction(decision)
    try {
      const action = decision === 'approve' ? 'approve' : 'reject'
      await Promise.all(pendingIds.map((id) => resolveApproval(id, action)))
      await loadApprovals({ status, capability: capabilityQuery.trim() || undefined, limit: 100 })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('approvals.error.action'))
    } finally {
      setBulkAction(null)
    }
  }

  const handleOpenAttemptDetail = async (attemptId: string) => {
    try {
      const response = await apiClient.get<{ success?: boolean; data?: RuntimeAttemptView }>(`/sessions/attempts/${encodeURIComponent(attemptId)}`)
      const view = response?.data
      if (!view) return
      openDetailContent(buildAttemptDetailContent(view, locale))
    } catch (error) {
      openDetailContent({
        kind: 'markdown',
        title: buildAttemptDetailTitle(attemptId),
        filename: `attempt-${attemptId}.md`,
        content: [
          `# Attempt ${attemptId}`,
          '',
          '加载 attempt 详情失败。',
          '',
          '```text',
          error instanceof Error ? error.message : String(error),
          '```',
        ].join('\n'),
      })
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <PageHeader
          title={t('approvals.title')}
          subtitle={`${t('approvals.subtitle')} · ${t('approvals.pending')} ${stats.pending} / ${t('approvals.total')} ${stats.total}`}
          actions={
            <Button
              variant="secondary"
              leftIcon={<RefreshCw size={16} />}
              onClick={() => void loadApprovals({ status, capability: capabilityQuery.trim() || undefined, limit: 100 })}
              disabled={isLoading}
            >
              {t('common.refresh')}
            </Button>
          }
        />

        <PageHelpStrip text={t('help.nav.approvals')} ctaLabel={t('nav.helpCenter')} />

        <Card className="border-border-default relative z-10">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <div className="max-w-xs min-w-[180px] flex-1">
                  <Input
                    value={capabilityQuery}
                    onChange={(event) => updateCapabilityQuery(event.target.value)}
                    placeholder="Filter by capability ID"
                  />
                </div>
                <Select
                  value={status}
                  options={statusOptions}
                  onChange={(value) => updateStatus(value as 'all' | ApprovalRecord['status'])}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void handleBulkResolve('approve')}
                  disabled={pendingIds.length === 0 || !!resolvingId || !!bulkAction}
                  loading={bulkAction === 'approve'}
                >
                  {t('chatSession.approveAll')}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void handleBulkResolve('reject')}
                  disabled={pendingIds.length === 0 || !!resolvingId || !!bulkAction}
                  loading={bulkAction === 'reject'}
                >
                  {t('chatSession.rejectAll')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            <>
              {t('approvals.apiUnavailableMessage', {
                path1: '/v1/approvals',
                path2: "/v1/approvals/{id}/approve|reject",
              })}
            </>
          </div>
        )}

        {(error || actionError) && (
          <InlineErrorAlert message={actionError || error || ''} />
        )}

        <div className="space-y-3">
          {isLoading && filteredApprovals.length === 0 ? (
            [1, 2, 3].map((item) => (
              <Card key={item} className="border-border-subtle">
                <CardContent className="p-4 animate-pulse">
                  <div className="h-4 w-40 rounded bg-bg-elevated mb-3" />
                  <div className="h-3 w-2/3 rounded bg-bg-elevated" />
                </CardContent>
              </Card>
            ))
          ) : filteredApprovals.length > 0 ? (
            filteredApprovals.map((approval) => {
              const detailText = buildApprovalDetail(approval, t)
              const orchestrationTrace = extractSkillOrchestrationTrace(approval)
              const sessionId = extractApprovalSessionId(approval)
              const attemptId = extractApprovalAttemptId(approval)
              return (
                <Card key={approval.id} className="border-border-subtle">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-text-primary">{approval.id}</p>
                          <Badge variant={mapStatusVariant(approval.status)}>
                            {approval.status === 'pending' && t('approvals.status.pending')}
                            {approval.status === 'approved' && t('approvals.status.approved')}
                            {approval.status === 'rejected' && t('approvals.status.rejected')}
                            {approval.status === 'expired' && t('approvals.status.expired')}
                          </Badge>
                          <Badge variant={mapRiskVariant(approval.riskLevel)}>
                            {t('approvals.risk')} {approval.riskLevel === 'high' ? t('approvals.riskLevel.high') : approval.riskLevel === 'medium' ? t('approvals.riskLevel.medium') : t('approvals.riskLevel.low')}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-text-secondary">
                          {approval.eventType || t('approvals.unknownEvent')} · {formatTime(approval.createdAt, locale)}
                        </div>
                        {(sessionId || attemptId) && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {sessionId ? (
                              <Badge variant="outline">
                                {t('runtimeMonitor.drawer.fields.session')}: {tailId(sessionId)}
                              </Badge>
                            ) : null}
                            {attemptId ? (
                              <Badge variant="outline">
                                Attempt: {tailId(attemptId)}
                              </Badge>
                            ) : null}
                          </div>
                        )}
                        {detailText && (
                          <p className="mt-2 text-sm text-text-primary break-words">
                            {detailText}
                          </p>
                        )}
                        {approval.reason && (
                          <p className="mt-2 text-sm text-text-secondary">{approval.reason}</p>
                        )}
                        {orchestrationTrace && (
                          <div className="mt-3 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2">
                            <p className="text-xs font-medium text-text-primary">
                              {t('approvals.trace.title')}
                            </p>
                            <div className="mt-1 text-xs text-text-secondary space-y-1">
                              <p>
                                {t('approvals.trace.selectedSkill')}: {String(orchestrationTrace.selected_skill ?? orchestrationTrace.selectedSkill ?? '-')}
                              </p>
                              <p>
                                {t('approvals.trace.skillKind')}: {String(orchestrationTrace.selected_skill_kind ?? orchestrationTrace.selectedSkillKind ?? '-')}
                              </p>
                              <p>
                                {t('approvals.trace.skillMdGate')}: {String(orchestrationTrace.skill_md_gate_injected ?? orchestrationTrace.skillMdGateInjected ?? false)}
                              </p>
                            </div>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-primary-400">
                                {t('approvals.trace.raw')}
                              </summary>
                              <pre className="mt-2 overflow-x-auto text-[11px] text-text-secondary">
                                {JSON.stringify(orchestrationTrace, null, 2)}
                              </pre>
                            </details>
                          </div>
                        )}
                      </div>

                      {approval.status === 'pending' && (
                        <div className="flex items-center gap-2">
                          {attemptId ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void copyToClipboard(attemptId)}
                            >
                              复制 Attempt
                            </Button>
                          ) : null}
                          {attemptId ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleOpenAttemptDetail(attemptId)}
                            >
                              查看 Attempt
                            </Button>
                          ) : null}
                          {sessionId ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => router.push(`/chat/${sessionId}`)}
                            >
                              {t('runtimeMonitor.actions.openSession')}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            leftIcon={<CheckCircle2 size={14} />}
                            loading={resolvingId === approval.id}
                            onClick={() => void handleResolve(approval.id, 'approve')}
                          >
                            {t('approvals.approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            leftIcon={<XCircle size={14} />}
                            loading={resolvingId === approval.id}
                            onClick={() => void handleResolve(approval.id, 'reject')}
                          >
                            {t('approvals.reject')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          ) : (
            <Card className="border-border-subtle">
              <CardContent className="p-8">
                <EmptyStateActions
                  className="text-center"
                  message={t('approvals.empty')}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
