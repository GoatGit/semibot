'use client'

import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, RefreshCw, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Select'
import { useApprovals } from '@/hooks/useApprovals'
import type { ApprovalRecord } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

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
  if (approval.action) {
    parts.push(t('approvals.detail.action', { action: `\`${approval.action}\`` }))
  }
  if (approval.target) {
    parts.push(t('approvals.detail.target', { target: `\`${approval.target}\`` }))
  }

  if (parts.length > 0) return parts.join(' · ')
  return approval.summary || ''
}

export default function ApprovalsPage() {
  const { locale, t } = useLocale()
  const statusOptions = [
    { value: 'all', label: t('approvals.status.all') },
    { value: 'pending', label: t('approvals.status.pending') },
    { value: 'approved', label: t('approvals.status.approved') },
    { value: 'rejected', label: t('approvals.status.rejected') },
    { value: 'expired', label: t('approvals.status.expired') },
  ]
  const [status, setStatus] = useState<'all' | ApprovalRecord['status']>('all')
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
    void loadApprovals({ status, limit: 100 })
  }, [loadApprovals, status])

  const stats = useMemo(() => {
    const pending = approvals.filter((item) => item.status === 'pending').length
    return { pending, total: approvals.length }
  }, [approvals])

  const pendingIds = useMemo(
    () => approvals.filter((item) => item.status === 'pending').map((item) => item.id),
    [approvals]
  )

  const handleResolve = async (id: string, decision: 'approve' | 'reject') => {
    try {
      setActionError(null)
      setResolvingId(id)
      await resolveApproval(id, decision)
      await loadApprovals({ status, limit: 100 })
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
      await loadApprovals({ status, limit: 100 })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('approvals.error.action'))
    } finally {
      setBulkAction(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                  <ShieldCheck size={22} className="text-primary-400" />
                  {t('approvals.title')}
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  {t('approvals.subtitle')}
                </p>
                <p className="mt-2 text-xs text-text-tertiary">
                  {t('approvals.pending')} {stats.pending} / {t('approvals.total')} {stats.total}
                </p>
              </div>
              <Button
                variant="secondary"
                leftIcon={<RefreshCw size={16} />}
                onClick={() => void loadApprovals({ status, limit: 100 })}
                disabled={isLoading}
              >
                {t('common.refresh')}
              </Button>
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
          </CardContent>
        </Card>

        <Card className="border-border-default">
          <CardContent className="p-4">
            <div className="max-w-xs">
              <Select
                value={status}
                options={statusOptions}
                onChange={(value) => setStatus(value as 'all' | ApprovalRecord['status'])}
              />
            </div>
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            <>
              {t('approvals.apiUnavailablePrefix')}{' '}
              <code>/v1/approvals</code> {t('approvals.and')}{' '}
              <code>/v1/approvals/{'{id}'}/approve|reject</code>
              {t('approvals.period')}
            </>
          </div>
        )}

        {(error || actionError) && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500 flex items-center gap-2">
            <AlertCircle size={16} />
            {actionError || error}
          </div>
        )}

        <div className="space-y-3">
          {isLoading && approvals.length === 0 ? (
            [1, 2, 3].map((item) => (
              <Card key={item} className="border-border-subtle">
                <CardContent className="p-4 animate-pulse">
                  <div className="h-4 w-40 rounded bg-bg-elevated mb-3" />
                  <div className="h-3 w-2/3 rounded bg-bg-elevated" />
                </CardContent>
              </Card>
            ))
          ) : approvals.length > 0 ? (
            approvals.map((approval) => {
              const detailText = buildApprovalDetail(approval, t)
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
                        {detailText && (
                          <p className="mt-2 text-sm text-text-primary break-words">
                            {detailText}
                          </p>
                        )}
                        {approval.reason && (
                          <p className="mt-2 text-sm text-text-secondary">{approval.reason}</p>
                        )}
                      </div>

                      {approval.status === 'pending' && (
                        <div className="flex items-center gap-2">
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
              <CardContent className="p-8 text-center text-sm text-text-secondary">
                {t('approvals.empty')}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
