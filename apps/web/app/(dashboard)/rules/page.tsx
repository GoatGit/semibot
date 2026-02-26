'use client'

import { useEffect, useMemo, useState } from 'react'
import { Workflow, RefreshCw, Plus, AlertCircle, Pencil, Power } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useRules } from '@/hooks/useRules'
import type { RuleActionMode, RuleActionType, RiskLevel } from '@/types'

const ACTION_MODE_OPTIONS = [
  { value: 'ask', label: 'ask（先询问）' },
  { value: 'suggest', label: 'suggest（建议执行）' },
  { value: 'auto', label: 'auto（自动执行）' },
  { value: 'skip', label: 'skip（跳过）' },
]

const ACTION_TYPE_OPTIONS = [
  { value: 'notify', label: 'notify' },
  { value: 'run_agent', label: 'run_agent' },
  { value: 'execute_plan', label: 'execute_plan' },
  { value: 'write_memory', label: 'write_memory' },
]

const RISK_OPTIONS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]

function mapRiskVariant(risk: RiskLevel): 'success' | 'warning' | 'error' {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  return 'success'
}

export default function RulesPage() {
  const [showEditor, setShowEditor] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    eventType: '',
    actionMode: 'suggest' as RuleActionMode,
    actionType: 'notify' as RuleActionType,
    riskLevel: 'low' as RiskLevel,
    priority: 50,
    dedupeWindowSeconds: 300,
    cooldownSeconds: 600,
    attentionBudgetPerDay: 10,
  })

  const {
    rules,
    isLoading,
    error,
    apiAvailable,
    loadRules,
    createRule,
    updateRule,
  } = useRules()

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const activeStats = useMemo(() => {
    const active = rules.filter((item) => item.isActive).length
    return { active, total: rules.length }
  }, [rules])

  const resetForm = () => {
    setForm({
      name: '',
      eventType: '',
      actionMode: 'suggest',
      actionType: 'notify',
      riskLevel: 'low',
      priority: 50,
      dedupeWindowSeconds: 300,
      cooldownSeconds: 600,
      attentionBudgetPerDay: 10,
    })
    setFormError(null)
  }

  const openCreateEditor = () => {
    setEditorMode('create')
    setEditingRuleId(null)
    resetForm()
    setShowEditor(true)
  }

  const openEditEditor = (ruleId: string) => {
    const found = rules.find((item) => item.id === ruleId)
    if (!found) return
    setEditorMode('edit')
    setEditingRuleId(ruleId)
    setForm({
      name: found.name,
      eventType: found.eventType,
      actionMode: found.actionMode,
      actionType: 'notify',
      riskLevel: found.riskLevel,
      priority: found.priority,
      dedupeWindowSeconds: found.dedupeWindowSeconds ?? 300,
      cooldownSeconds: found.cooldownSeconds ?? 600,
      attentionBudgetPerDay: found.attentionBudgetPerDay ?? 10,
    })
    setFormError(null)
    setShowEditor(true)
  }

  const submitEditor = async () => {
    if (!form.name.trim() || !form.eventType.trim()) {
      setFormError('请填写规则名称和事件类型')
      return
    }

    try {
      setIsSubmitting(true)
      setFormError(null)
      if (editorMode === 'create') {
        await createRule(form)
      } else if (editingRuleId) {
        await updateRule(editingRuleId, form)
      }
      await loadRules()
      setShowEditor(false)
      resetForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存规则失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleToggleRule = async (ruleId: string, nextActive: boolean) => {
    try {
      setActionError(null)
      await updateRule(ruleId, { isActive: nextActive })
      await loadRules()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新规则状态失败')
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
                  <Workflow size={22} className="text-primary-400" />
                  规则管理
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  配置事件触发策略，控制提醒、建议和自动执行行为。
                </p>
                <p className="mt-2 text-xs text-text-tertiary">
                  已启用 {activeStats.active} / {activeStats.total}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} />}
                  onClick={() => void loadRules()}
                  disabled={isLoading}
                >
                  刷新
                </Button>
                <Button
                  leftIcon={<Plus size={16} />}
                  onClick={openCreateEditor}
                  disabled={!apiAvailable}
                >
                  新建规则
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            规则 API 尚未接入，请先实现 `/v1/rules`。
          </div>
        )}

        {(error || actionError) && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500 flex items-center gap-2">
            <AlertCircle size={16} />
            {actionError || error}
          </div>
        )}

        <div className="space-y-3">
          {isLoading && rules.length === 0 ? (
            [1, 2, 3].map((item) => (
              <Card key={item} className="border-border-subtle">
                <CardContent className="p-4 animate-pulse">
                  <div className="h-4 w-44 rounded bg-bg-elevated mb-3" />
                  <div className="h-3 w-3/4 rounded bg-bg-elevated" />
                </CardContent>
              </Card>
            ))
          ) : rules.length > 0 ? (
            rules.map((rule) => (
              <Card key={rule.id} className="border-border-subtle">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-text-primary">{rule.name}</p>
                        <Badge variant={mapRiskVariant(rule.riskLevel)}>
                          {rule.riskLevel}
                        </Badge>
                        <Badge variant={rule.isActive ? 'success' : 'outline'}>
                          {rule.isActive ? 'active' : 'inactive'}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-text-secondary break-all">
                        {rule.eventType} · mode={rule.actionMode} · priority={rule.priority}
                      </div>
                      <div className="mt-2 text-xs text-text-tertiary">
                        dedupe={rule.dedupeWindowSeconds ?? 0}s · cooldown={rule.cooldownSeconds ?? 0}s · budget/day={rule.attentionBudgetPerDay ?? 0}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<Pencil size={14} />}
                        onClick={() => openEditEditor(rule.id)}
                        disabled={!apiAvailable}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant={rule.isActive ? 'tertiary' : 'secondary'}
                        leftIcon={<Power size={14} />}
                        onClick={() => void handleToggleRule(rule.id, !rule.isActive)}
                        disabled={!apiAvailable}
                      >
                        {rule.isActive ? '停用' : '启用'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="border-border-subtle">
              <CardContent className="p-8 text-center text-sm text-text-secondary">
                暂无规则，先创建一条规则开始。
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={showEditor}
        onClose={() => {
          setShowEditor(false)
          resetForm()
        }}
        title={editorMode === 'create' ? '新建规则' : '编辑规则'}
        description={editorMode === 'create' ? '创建事件触发规则' : '更新规则配置'}
        footer={(
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setShowEditor(false)
                resetForm()
              }}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button onClick={() => void submitEditor()} loading={isSubmitting}>
              {editorMode === 'create' ? '创建' : '保存'}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Input
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="规则名称"
          />
          <Input
            value={form.eventType}
            onChange={(e) => setForm((prev) => ({ ...prev, eventType: e.target.value }))}
            placeholder="事件类型（例如 tool.exec.failed）"
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select
              value={form.actionMode}
              options={ACTION_MODE_OPTIONS}
              onChange={(value) => setForm((prev) => ({ ...prev, actionMode: value as RuleActionMode }))}
            />
            <Select
              value={form.actionType}
              options={ACTION_TYPE_OPTIONS}
              onChange={(value) => setForm((prev) => ({ ...prev, actionType: value as RuleActionType }))}
            />
            <Select
              value={form.riskLevel}
              options={RISK_OPTIONS}
              onChange={(value) => setForm((prev) => ({ ...prev, riskLevel: value as RiskLevel }))}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Input
              type="number"
              value={String(form.priority)}
              onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value || 0) }))}
              placeholder="priority"
            />
            <Input
              type="number"
              value={String(form.dedupeWindowSeconds)}
              onChange={(e) => setForm((prev) => ({ ...prev, dedupeWindowSeconds: Number(e.target.value || 0) }))}
              placeholder="dedupe(s)"
            />
            <Input
              type="number"
              value={String(form.cooldownSeconds)}
              onChange={(e) => setForm((prev) => ({ ...prev, cooldownSeconds: Number(e.target.value || 0) }))}
              placeholder="cooldown(s)"
            />
            <Input
              type="number"
              value={String(form.attentionBudgetPerDay)}
              onChange={(e) => setForm((prev) => ({ ...prev, attentionBudgetPerDay: Number(e.target.value || 0) }))}
              placeholder="budget/day"
            />
          </div>
          {formError && (
            <p className="text-xs text-error-500">{formError}</p>
          )}
        </div>
      </Modal>
    </div>
  )
}
