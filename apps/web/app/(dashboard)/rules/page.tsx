'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Workflow, RefreshCw, Plus, AlertCircle, Pencil, Power } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useRules } from '@/hooks/useRules'
import type { RuleActionMode, RuleActionType, RiskLevel } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

const ACTION_TYPE_OPTIONS = [
  { value: 'notify', labelKey: 'rules.actionType.notify' },
  { value: 'run_agent', labelKey: 'rules.actionType.runAgent' },
  { value: 'execute_plan', labelKey: 'rules.actionType.executePlan' },
  { value: 'write_memory', labelKey: 'rules.actionType.writeMemory' },
]

const RISK_OPTIONS = [
  { value: 'low', labelKey: 'rules.risk.low' },
  { value: 'medium', labelKey: 'rules.risk.medium' },
  { value: 'high', labelKey: 'rules.risk.high' },
]

function mapRiskVariant(risk: RiskLevel): 'success' | 'warning' | 'error' {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  return 'success'
}

export default function RulesPage() {
  const searchParams = useSearchParams()
  const { t } = useLocale()
  const actionTypeOptions = ACTION_TYPE_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) }))
  const riskOptions = RISK_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) }))
  const actionModeOptions = [
    { value: 'ask', label: t('rules.actionMode.ask') },
    { value: 'suggest', label: t('rules.actionMode.suggest') },
    { value: 'auto', label: t('rules.actionMode.auto') },
    { value: 'skip', label: t('rules.actionMode.skip') },
  ]
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
  const prefillAppliedRef = useRef(false)

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

  useEffect(() => {
    if (prefillAppliedRef.current) return
    const create = (searchParams.get('create') || '').trim()
    const eventType = (searchParams.get('eventType') || '').trim()
    if (!create && !eventType) return

    prefillAppliedRef.current = true
    setEditorMode('create')
    setEditingRuleId(null)
    setForm((prev) => ({
      ...prev,
      name: eventType ? `rule_for_${eventType}` : prev.name,
      eventType: eventType || prev.eventType,
    }))
    setFormError(null)
    setShowEditor(create === '1' || Boolean(eventType))
  }, [searchParams])

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
      setFormError(t('rules.error.requiredFields'))
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
      setFormError(err instanceof Error ? err.message : t('rules.error.save'))
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
      setActionError(err instanceof Error ? err.message : t('rules.error.updateStatus'))
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
                  {t('rules.title')}
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  {t('rules.subtitle')}
                </p>
                <p className="mt-2 text-xs text-text-tertiary">
                  {t('rules.enabled')} {activeStats.active} / {activeStats.total}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} />}
                  onClick={() => void loadRules()}
                  disabled={isLoading}
                >
                  {t('common.refresh')}
                </Button>
                <Button
                  leftIcon={<Plus size={16} />}
                  onClick={openCreateEditor}
                  disabled={!apiAvailable}
                >
                  {t('rules.new')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            {t('rules.apiUnavailable')}
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
                          {rule.isActive ? t('rules.status.active') : t('rules.status.inactive')}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-text-secondary break-all">
                        {rule.eventType} · mode={rule.actionMode} · priority={rule.priority}
                      </div>
                      <div className="mt-2 text-xs text-text-tertiary">
                        {t('rules.meta.dedupe')}={rule.dedupeWindowSeconds ?? 0}s · {t('rules.meta.cooldown')}={rule.cooldownSeconds ?? 0}s · {t('rules.meta.budgetPerDay')}={rule.attentionBudgetPerDay ?? 0}
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
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant={rule.isActive ? 'tertiary' : 'secondary'}
                        leftIcon={<Power size={14} />}
                        onClick={() => void handleToggleRule(rule.id, !rule.isActive)}
                        disabled={!apiAvailable}
                      >
                        {rule.isActive ? t('rules.disable') : t('rules.enable')}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="border-border-subtle">
              <CardContent className="p-8 text-center text-sm text-text-secondary">
                {t('rules.empty')}
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
        title={editorMode === 'create' ? t('rules.new') : t('rules.edit')}
        description={editorMode === 'create' ? t('rules.createDescription') : t('rules.updateDescription')}
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
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitEditor()} loading={isSubmitting}>
              {editorMode === 'create' ? t('common.create') : t('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Input
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t('rules.form.ruleName')}
          />
          <Input
            value={form.eventType}
            onChange={(e) => setForm((prev) => ({ ...prev, eventType: e.target.value }))}
            placeholder={t('rules.form.eventType')}
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select
              value={form.actionMode}
              options={actionModeOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, actionMode: value as RuleActionMode }))}
            />
            <Select
              value={form.actionType}
              options={actionTypeOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, actionType: value as RuleActionType }))}
            />
            <Select
              value={form.riskLevel}
              options={riskOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, riskLevel: value as RiskLevel }))}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Input
              type="number"
              value={String(form.priority)}
              onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value || 0) }))}
              placeholder={t('rules.form.priority')}
            />
            <Input
              type="number"
              value={String(form.dedupeWindowSeconds)}
              onChange={(e) => setForm((prev) => ({ ...prev, dedupeWindowSeconds: Number(e.target.value || 0) }))}
              placeholder={t('rules.form.dedupe')}
            />
            <Input
              type="number"
              value={String(form.cooldownSeconds)}
              onChange={(e) => setForm((prev) => ({ ...prev, cooldownSeconds: Number(e.target.value || 0) }))}
              placeholder={t('rules.form.cooldown')}
            />
            <Input
              type="number"
              value={String(form.attentionBudgetPerDay)}
              onChange={(e) => setForm((prev) => ({ ...prev, attentionBudgetPerDay: Number(e.target.value || 0) }))}
              placeholder={t('rules.form.budgetPerDay')}
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
