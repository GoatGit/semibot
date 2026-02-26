'use client'

import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, RefreshCw, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Select'
import { useApprovals } from '@/hooks/useApprovals'
import type { ApprovalRecord } from '@/types'

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: 'pending' },
  { value: 'approved', label: 'approved' },
  { value: 'rejected', label: 'rejected' },
  { value: 'expired', label: 'expired' },
]

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

function formatTime(dateString: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN')
}

export default function ApprovalsPage() {
  const [status, setStatus] = useState<'all' | ApprovalRecord['status']>('all')
  const [resolvingId, setResolvingId] = useState<string | null>(null)
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

  const handleResolve = async (id: string, decision: 'approve' | 'reject') => {
    try {
      setActionError(null)
      setResolvingId(id)
      await resolveApproval(id, decision)
      await loadApprovals({ status, limit: 100 })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '审批操作失败')
    } finally {
      setResolvingId(null)
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
                  审批中心
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  处理高风险动作审批请求，确保自动执行可控。
                </p>
                <p className="mt-2 text-xs text-text-tertiary">
                  待审批 {stats.pending} / 全部 {stats.total}
                </p>
              </div>
              <Button
                variant="secondary"
                leftIcon={<RefreshCw size={16} />}
                onClick={() => void loadApprovals({ status, limit: 100 })}
                disabled={isLoading}
              >
                刷新
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border-default">
          <CardContent className="p-4">
            <div className="max-w-xs">
              <Select
                value={status}
                options={STATUS_OPTIONS}
                onChange={(value) => setStatus(value as 'all' | ApprovalRecord['status'])}
              />
            </div>
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            审批 API 尚未接入，请先实现 <code>/v1/approvals</code> 与 <code>/v1/approvals/{'{id}'}/approve|reject</code>。
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
            approvals.map((approval) => (
              <Card key={approval.id} className="border-border-subtle">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-text-primary">{approval.id}</p>
                        <Badge variant={mapStatusVariant(approval.status)}>
                          {approval.status}
                        </Badge>
                        <Badge variant={mapRiskVariant(approval.riskLevel)}>
                          risk {approval.riskLevel}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-text-secondary">
                        {approval.eventType || 'unknown event'} · {formatTime(approval.createdAt)}
                      </div>
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
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          leftIcon={<XCircle size={14} />}
                          loading={resolvingId === approval.id}
                          onClick={() => void handleResolve(approval.id, 'reject')}
                        >
                          拒绝
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="border-border-subtle">
              <CardContent className="p-8 text-center text-sm text-text-secondary">
                暂无审批项
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
