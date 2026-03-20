'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Workflow, RefreshCw, Plus, AlertCircle, Pencil, Power, Trash2, CircleHelp, ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { EmptyStateActions } from '@/components/ui/EmptyStateActions'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { PageHelpStrip } from '@/components/ui/PageHelpStrip'
import { useRules } from '@/hooks/useRules'
import { apiClient } from '@/lib/api'
import type { RuleActionMode, RuleActionType, RiskLevel } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

const ACTION_TYPE_OPTIONS = [
  { value: 'notify', labelKey: 'rules.actionType.notify' },
  { value: 'run_agent', labelKey: 'rules.actionType.runAgent' },
  { value: 'execute_plan', labelKey: 'rules.actionType.executePlan' },
  { value: 'call_webhook', labelKey: 'rules.actionType.callWebhook' },
  { value: 'log_only', labelKey: 'rules.actionType.logOnly' },
]

const RISK_OPTIONS = [
  { value: 'low', labelKey: 'rules.risk.low' },
  { value: 'medium', labelKey: 'rules.risk.medium' },
  { value: 'high', labelKey: 'rules.risk.high' },
]

type ConditionPreset =
  | 'all'
  | 'subject_exists'
  | 'has_attachments'
  | 'high_risk'
  | 'cron_any'
  | 'cron_named'
  | 'cron_schedule'

const CONDITION_PRESET_DEFINITIONS: Record<ConditionPreset, { labelKey: string; condition: Record<string, unknown> }> = {
  all: {
    labelKey: 'rules.form.conditionPresets.all',
    condition: { all: [] },
  },
  subject_exists: {
    labelKey: 'rules.form.conditionPresets.subjectExists',
    condition: { all: [{ field: 'subject', op: 'exists', value: true }] },
  },
  has_attachments: {
    labelKey: 'rules.form.conditionPresets.hasAttachments',
    condition: { all: [{ field: 'payload.attachments', op: 'exists', value: true }] },
  },
  high_risk: {
    labelKey: 'rules.form.conditionPresets.highRisk',
    condition: { all: [{ field: 'risk_hint', op: 'in', value: ['high'] }] },
  },
  cron_any: {
    labelKey: 'rules.form.conditionPresets.cronAny',
    condition: { all: [{ field: 'payload.trigger_kind', op: '==', value: 'cron' }] },
  },
  cron_named: {
    labelKey: 'rules.form.conditionPresets.cronNamed',
    condition: { all: [{ field: 'payload.trigger_name', op: 'exists', value: true }] },
  },
  cron_schedule: {
    labelKey: 'rules.form.conditionPresets.cronSchedule',
    condition: { all: [{ field: 'payload.schedule', op: 'exists', value: true }] },
  },
}

function availableConditionPresets(eventType: string): ConditionPreset[] {
  const normalized = eventType.trim().toLowerCase()
  if (normalized === 'cron.job.tick' || normalized.startsWith('cron.')) {
    return ['all', 'cron_any', 'cron_named', 'cron_schedule']
  }
  return ['all', 'subject_exists', 'has_attachments', 'high_risk']
}

function isCronEventType(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase()
  return normalized === 'cron.job.tick' || normalized.startsWith('cron.')
}

const EVENT_TYPE_GROUPS: Array<{ key: 'chat' | 'tool' | 'approval' | 'gateway' | 'system'; options: string[] }> = [
  {
    key: 'chat',
    options: ['chat.message.received', 'chat.card.action'],
  },
  {
    key: 'tool',
    options: ['tool.exec.started', 'tool.exec.completed', 'tool.exec.failed'],
  },
  {
    key: 'approval',
    options: ['approval.requested', 'approval.approved', 'approval.rejected', 'approval.action'],
  },
  {
    key: 'gateway',
    options: ['session.deleted'],
  },
  {
    key: 'system',
    options: [
      'cron.job.tick',
      'task.completed',
      'task.failed',
      'task.cancelled',
      'health.heartbeat.tick',
      'health.heartbeat.manual',
      'rule.queue.accepted',
      'rule.queue.dropped',
      'rule.queue.telemetry',
      'rule.worker.started',
      'rule.worker.completed',
      'rule.worker.failed',
      'memory.write.manual',
      'memory.write.important',
      'agent.lifecycle.pre_execute',
      'agent.lifecycle.post_execute',
      'agent.lifecycle.failed',
      'sandbox_execution',
      'policy_violation',
    ],
  },
]

const EVENT_TYPE_DISPLAY_NAME: Record<string, string> = {
  'chat.message.received': '收到聊天消息',
  'chat.card.action': '卡片交互动作',
  'tool.exec.started': '工具开始执行',
  'tool.exec.completed': '工具执行完成',
  'tool.exec.failed': '工具执行失败',
  'approval.requested': '创建审批请求',
  'approval.approved': '审批通过',
  'approval.rejected': '审批拒绝',
  'approval.action': '审批动作回调',
  'session.deleted': '会话删除',
  'cron.job.tick': 'Cron 调度触发',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务取消',
  'health.heartbeat.tick': '心跳自动巡检',
  'health.heartbeat.manual': '心跳手动触发',
  'rule.queue.accepted': '规则队列接收',
  'rule.queue.dropped': '规则队列丢弃',
  'rule.queue.telemetry': '规则队列遥测',
  'rule.worker.started': '规则工作器启动',
  'rule.worker.completed': '规则工作器完成',
  'rule.worker.failed': '规则工作器失败',
  'memory.write.manual': '记忆手动写入',
  'memory.write.important': '关键记忆写入',
  'agent.lifecycle.pre_execute': 'Agent 执行前',
  'agent.lifecycle.post_execute': 'Agent 执行后',
  'agent.lifecycle.failed': 'Agent 执行失败',
  sandbox_execution: '沙箱执行',
  policy_violation: '策略违规',
}

function buildConditionsFromPreset(preset: ConditionPreset): Record<string, unknown> {
  return CONDITION_PRESET_DEFINITIONS[preset]?.condition ?? { all: [] }
}

function defaultActionParams(actionType: RuleActionType): Record<string, unknown> {
  if (actionType === 'notify') return { channel: 'chat' }
  if (actionType === 'run_agent') return { agent_id: 'semibot' }
  if (actionType === 'execute_plan') return { plan: { steps: [] } }
  if (actionType === 'call_webhook') return { url: 'https://example.com/webhook', timeout: 10 }
  return {}
}

interface RuleActionFormItem {
  actionType: RuleActionType
  paramsJson: string
}

interface RuntimeCronJob {
  name: string
  schedule: string
  eventType?: string
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJson((value as Record<string, unknown>)[key])
      return acc
    }, {})
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function inferConditionPreset(conditions: Record<string, unknown> | undefined): ConditionPreset | null {
  const target = conditions ?? { all: [] }
  for (const [preset, definition] of Object.entries(CONDITION_PRESET_DEFINITIONS)) {
    if (jsonEquals(target, definition.condition)) {
      return preset as ConditionPreset
    }
  }
  return null
}

function inferCronTriggerName(conditions: Record<string, unknown> | undefined): string {
  const all = conditions?.all
  if (!Array.isArray(all)) return ''
  for (const item of all) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (row.field !== 'payload.trigger_name' || row.op !== '==') continue
    return typeof row.value === 'string' ? row.value : ''
  }
  return ''
}

function mapRiskVariant(risk: RiskLevel): 'success' | 'warning' | 'error' {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  return 'success'
}

function formatRuleEffectiveTime(value: string | undefined, locale: string): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale)
}

export default function RulesPage() {
  const searchParams = useSearchParams()
  const { locale, t } = useLocale()
  const actionTypeOptions = ACTION_TYPE_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) }))
  const eventTypeOptions = EVENT_TYPE_GROUPS.map((group) => ({
    label: t(`rules.form.eventTypeGroups.${group.key}`),
    options: group.options.map((item) => ({
      value: item,
      label: `${item} · ${EVENT_TYPE_DISPLAY_NAME[item] || '未命名事件'}`,
    })),
  }))
  const defaultEventType = EVENT_TYPE_GROUPS[0]?.options[0] || 'chat.message.received'
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
  const [advancedMode, setAdvancedMode] = useState(false)
  const [cronJobs, setCronJobs] = useState<RuntimeCronJob[]>([])
  const [form, setForm] = useState({
    name: '',
    eventType: defaultEventType,
    conditionPreset: 'all' as ConditionPreset,
    actionMode: 'suggest' as RuleActionMode,
    conditionsJson: '{\n  "all": []\n}',
    actionItems: [{ actionType: 'notify' as RuleActionType, paramsJson: '{\n  "channel": "chat"\n}' }] as RuleActionFormItem[],
    riskLevel: 'low' as RiskLevel,
    priority: 50,
    dedupeWindowSeconds: 300,
    cooldownSeconds: 600,
    attentionBudgetPerDay: 10,
    cronCreateScheduler: true,
    cronJobName: '',
    cronSchedule: '*/5 * * * *',
  })
  const conditionPresetOptions = useMemo(
    () =>
      availableConditionPresets(form.eventType).map((preset) => ({
        value: preset,
        label: t(CONDITION_PRESET_DEFINITIONS[preset].labelKey),
      })),
    [form.eventType, t]
  )
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

  const loadCronJobs = async (): Promise<RuntimeCronJob[]> => {
    try {
      const response = await apiClient.get<{ data?: { jobs?: RuntimeCronJob[] } }>('/runtime/scheduler/cron-jobs')
      const jobs = Array.isArray(response?.data?.jobs) ? response.data.jobs : []
      setCronJobs(jobs)
      return jobs
    } catch {
      setCronJobs([])
      return []
    }
  }

  useEffect(() => {
    void loadRules()
    void loadCronJobs()
  }, [loadRules])

  const activeStats = useMemo(() => {
    const active = rules.filter((item) => item.isActive).length
    return { active, total: rules.length }
  }, [rules])

  const resetForm = () => {
    setForm({
      name: '',
      eventType: defaultEventType,
      conditionPreset: 'all',
      actionMode: 'suggest',
      conditionsJson: '{\n  "all": []\n}',
      actionItems: [{ actionType: 'notify', paramsJson: '{\n  "channel": "chat"\n}' }],
      riskLevel: 'low',
      priority: 50,
      dedupeWindowSeconds: 300,
      cooldownSeconds: 600,
      attentionBudgetPerDay: 10,
      cronCreateScheduler: true,
      cronJobName: '',
      cronSchedule: '*/5 * * * *',
    })
    setFormError(null)
    setAdvancedMode(false)
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

  useEffect(() => {
    if (!showEditor) return
    if (form.eventType.trim()) return
    setForm((prev) => ({ ...prev, eventType: defaultEventType }))
  }, [defaultEventType, form.eventType, showEditor])

  useEffect(() => {
    if (advancedMode) return
    const allowed = availableConditionPresets(form.eventType)
    if (allowed.includes(form.conditionPreset)) return
    setForm((prev) => ({ ...prev, conditionPreset: allowed[0] || 'all' }))
  }, [advancedMode, form.conditionPreset, form.eventType])

  useEffect(() => {
    if (advancedMode) return
    if (!isCronEventType(form.eventType)) return
    setForm((prev) => {
      const nextConditionPreset = prev.conditionPreset === 'all' ? 'cron_named' : prev.conditionPreset
      if (prev.cronJobName && nextConditionPreset === prev.conditionPreset) {
        return prev
      }
      return {
        ...prev,
        cronJobName: prev.cronJobName || `cron_${Date.now()}`,
        conditionPreset: nextConditionPreset,
      }
    })
  }, [advancedMode, form.eventType])

  const openEditEditor = async (ruleId: string) => {
    const found = rules.find((item) => item.id === ruleId)
    if (!found) return
    const latestCronJobs = await loadCronJobs()
    setEditorMode('edit')
    setEditingRuleId(ruleId)
    const actions = Array.isArray(found.actions) && found.actions.length > 0
      ? found.actions
      : [{ actionType: 'notify' as RuleActionType, params: defaultActionParams('notify') }]
    const firstAction = actions[0]
    const inferredPreset = inferConditionPreset(found.conditions)
    const inferredCronTriggerName = inferCronTriggerName(found.conditions)
    const inferredCronJob = latestCronJobs.find((job) => job.name === inferredCronTriggerName)
    const shouldEnableCronUpsertByDefault =
      isCronEventType(found.eventType) && Boolean(inferredCronTriggerName) && Boolean(inferredCronJob)
    const inferredActionParams = firstAction?.params ?? defaultActionParams((firstAction?.actionType ?? 'notify') as RuleActionType)
    const actionType = (firstAction?.actionType ?? 'notify') as RuleActionType
    const shouldOpenAdvanced =
      inferredPreset === null || !jsonEquals(inferredActionParams, defaultActionParams(actionType))
    setForm({
      name: found.name,
      eventType: found.eventType,
      conditionPreset: inferredPreset ?? 'all',
      actionMode: found.actionMode,
      conditionsJson: JSON.stringify(found.conditions ?? { all: [] }, null, 2),
      actionItems: actions.map((item) => ({
        actionType: item.actionType as RuleActionType,
        paramsJson: JSON.stringify(item.params ?? defaultActionParams(item.actionType as RuleActionType), null, 2),
      })),
      riskLevel: found.riskLevel,
      priority: found.priority,
      dedupeWindowSeconds: found.dedupeWindowSeconds ?? 300,
      cooldownSeconds: found.cooldownSeconds ?? 600,
      attentionBudgetPerDay: found.attentionBudgetPerDay ?? 10,
      cronCreateScheduler: shouldEnableCronUpsertByDefault,
      cronJobName: inferredCronTriggerName || '',
      cronSchedule: inferredCronJob?.schedule || '*/5 * * * *',
    })
    setAdvancedMode(shouldOpenAdvanced)
    setFormError(null)
    setShowEditor(true)
  }

  const addActionItem = () => {
    setForm((prev) => ({
      ...prev,
      actionItems: [
        ...prev.actionItems,
        { actionType: 'notify', paramsJson: JSON.stringify(defaultActionParams('notify'), null, 2) },
      ],
    }))
  }

  const removeActionItem = (index: number) => {
    setForm((prev) => {
      const next = prev.actionItems.filter((_, i) => i !== index)
      return {
        ...prev,
        actionItems: next.length > 0 ? next : [{ actionType: 'notify', paramsJson: JSON.stringify(defaultActionParams('notify'), null, 2) }],
      }
    })
  }

  const updateActionItemType = (index: number, actionType: RuleActionType) => {
    setForm((prev) => ({
      ...prev,
      actionItems: prev.actionItems.map((item, i) => (i === index
        ? { ...item, actionType, paramsJson: JSON.stringify(defaultActionParams(actionType), null, 2) }
        : item)),
    }))
  }

  const updateActionItemParams = (index: number, paramsJson: string) => {
    setForm((prev) => ({
      ...prev,
      actionItems: prev.actionItems.map((item, i) => (i === index ? { ...item, paramsJson } : item)),
    }))
  }

  const submitEditor = async () => {
    if (!form.name.trim() || !form.eventType.trim()) {
      setFormError(t('rules.error.requiredFields'))
      return
    }

    let parsedConditions: Record<string, unknown> | undefined
    let parsedActionParamsList: Array<{ actionType: RuleActionType; params: Record<string, unknown> }> = []
    if (advancedMode) {
      try {
        const c = JSON.parse(form.conditionsJson)
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
          setFormError(t('rules.error.invalidConditionsJson'))
          return
        }
        parsedConditions = c as Record<string, unknown>
      } catch {
        setFormError(t('rules.error.invalidConditionsJson'))
        return
      }
      const parsedItems: Array<{ actionType: RuleActionType; params: Record<string, unknown> }> = []
      for (const item of form.actionItems) {
        try {
          const p = JSON.parse(item.paramsJson)
          if (!p || typeof p !== 'object' || Array.isArray(p)) {
            setFormError(t('rules.error.invalidActionParamsJson'))
            return
          }
          parsedItems.push({ actionType: item.actionType, params: p as Record<string, unknown> })
        } catch {
          setFormError(t('rules.error.invalidActionParamsJson'))
          return
        }
      }
      parsedActionParamsList = parsedItems
    } else {
      parsedConditions = buildConditionsFromPreset(form.conditionPreset)
      if (isCronEventType(form.eventType) && form.cronCreateScheduler) {
        parsedConditions = {
          all: [
            {
              field: 'payload.trigger_name',
              op: '==',
              value: form.cronJobName.trim(),
            },
          ],
        }
      }
      parsedActionParamsList = form.actionItems.map((item) => ({
        actionType: item.actionType,
        params: defaultActionParams(item.actionType),
      }))
    }

    let cronPayload:
      | {
        upsert: boolean
        name: string
        schedule: string
        eventType: string
        source: string
        subject: string
        payload: Record<string, unknown>
      }
      | undefined
    if (isCronEventType(form.eventType) && form.cronCreateScheduler) {
      const cronJobName = form.cronJobName.trim()
      const cronSchedule = form.cronSchedule.trim()
      if (!cronJobName || !cronSchedule) {
        setFormError(t('rules.error.cronRequired'))
        return
      }
      cronPayload = {
        upsert: true,
        name: cronJobName,
        schedule: cronSchedule,
        eventType: form.eventType,
        source: 'system.cron',
        subject: 'system',
        payload: {
          trigger_name: cronJobName,
        },
      }
    }

    try {
      setIsSubmitting(true)
      setFormError(null)
      if (editorMode === 'create') {
        await createRule({
          ...form,
          conditions: parsedConditions,
          actions: parsedActionParamsList.map((item) => ({ actionType: item.actionType, params: item.params })),
          actionType: parsedActionParamsList[0]?.actionType ?? 'notify',
          actionParams: parsedActionParamsList[0]?.params ?? defaultActionParams('notify'),
          cron: cronPayload,
        })
      } else if (editingRuleId) {
        await updateRule(editingRuleId, {
          ...form,
          conditions: parsedConditions,
          actions: parsedActionParamsList.map((item) => ({ actionType: item.actionType, params: item.params })),
          actionType: parsedActionParamsList[0]?.actionType ?? 'notify',
          actionParams: parsedActionParamsList[0]?.params ?? defaultActionParams('notify'),
          cron: cronPayload,
        })
        if (isCronEventType(form.eventType) && !form.cronCreateScheduler) {
          const jobName = form.cronJobName.trim()
          if (jobName) {
            try {
              await apiClient.delete(`/runtime/scheduler/cron-jobs/${encodeURIComponent(jobName)}`)
            } catch {
              // ignore: cron job might already be removed
            }
          }
        }
      }
      await loadRules()
      await loadCronJobs()
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

        <PageHelpStrip text={t('help.nav.rules')} ctaLabel={t('nav.helpCenter')} />

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            {t('rules.apiUnavailable')}
          </div>
        )}

        {(error || actionError) && (
          <InlineErrorAlert message={actionError || error || ''} />
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
                      <div className="mt-1 text-xs text-text-secondary break-all">
                        actions={(rule.actions || []).map((item) => item.actionType).join(', ') || '-'}
                      </div>
                      {isCronEventType(rule.eventType) && (
                        <div className="mt-1 text-xs text-text-secondary break-all">
                          {(() => {
                            const triggerName = inferCronTriggerName(rule.conditions)
                            const job = triggerName ? cronJobs.find((item) => item.name === triggerName) : null
                            if (!triggerName) return `cron=-`
                            if (!job) return `cron=${triggerName}`
                            return `cron=${triggerName} (${job.schedule})`
                          })()}
                        </div>
                      )}
                      <div className="mt-2 text-xs text-text-tertiary">
                        {t('rules.meta.dedupe')}={rule.dedupeWindowSeconds ?? 0}s · {t('rules.meta.cooldown')}={rule.cooldownSeconds ?? 0}s · {t('rules.meta.budgetPerDay')}={rule.attentionBudgetPerDay ?? 0}
                      </div>
                      <div className="mt-1 text-xs text-text-tertiary">
                        {t('rules.meta.effectiveAt')}={formatRuleEffectiveTime(rule.effectiveAt, locale)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<Pencil size={14} />}
                        onClick={() => void openEditEditor(rule.id)}
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
              <CardContent className="p-8">
                <EmptyStateActions
                  className="text-center"
                  message={t('rules.empty')}
                  actions={(
                    <>
                      <Button size="sm" onClick={openCreateEditor} disabled={!apiAvailable}>
                        {t('rules.new')}
                      </Button>
                    </>
                  )}
                />
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
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{t('rules.form.ruleName')}</p>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('rules.form.ruleName')}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{t('rules.form.eventType')}</p>
            <Select
              value={form.eventType}
              options={eventTypeOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, eventType: value }))}
            />
          </div>
          {isCronEventType(form.eventType) && (
            <div className="space-y-2 rounded-md border border-border-default p-3">
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={form.cronCreateScheduler}
                  onChange={(e) => setForm((prev) => ({ ...prev, cronCreateScheduler: e.target.checked }))}
                />
                {t('rules.form.cronCreateScheduler')}
              </label>
              {form.cronCreateScheduler && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <p className="text-xs text-text-tertiary">{t('rules.form.cronJobName')}</p>
                    <Input
                      value={form.cronJobName}
                      onChange={(e) => setForm((prev) => ({ ...prev, cronJobName: e.target.value }))}
                      placeholder={t('rules.form.cronJobNamePlaceholder')}
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-text-tertiary">{t('rules.form.cronSchedule')}</p>
                    <Input
                      value={form.cronSchedule}
                      onChange={(e) => setForm((prev) => ({ ...prev, cronSchedule: e.target.value }))}
                      placeholder="*/5 * * * *"
                    />
                    <p className="text-[11px] text-text-tertiary">{t('rules.formHelp.cronSchedule')}</p>
                  </div>
                </div>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={advancedMode}
              onChange={(e) => setAdvancedMode(e.target.checked)}
            />
            {t('rules.form.advancedMode')}
          </label>
          {advancedMode ? (
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.conditionsJson')}</p>
              <textarea
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
                rows={8}
                value={form.conditionsJson}
                onChange={(e) => setForm((prev) => ({ ...prev, conditionsJson: e.target.value }))}
                placeholder='{"all":[]}'
              />
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.conditionPreset')}</p>
              <Select
                value={form.conditionPreset}
                options={conditionPresetOptions}
                onChange={(value) => setForm((prev) => ({ ...prev, conditionPreset: value as ConditionPreset }))}
              />
              <p className="text-[11px] text-text-tertiary">{t('rules.form.advancedHint')}</p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select
              value={form.actionMode}
              options={actionModeOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, actionMode: value as RuleActionMode }))}
            />
            <Select
              value={form.riskLevel}
              options={riskOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, riskLevel: value as RiskLevel }))}
            />
          </div>
          <div className="space-y-2 rounded-md border border-border-default p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-text-tertiary">{t('rules.form.actions')}</p>
              <Button type="button" size="xs" variant="secondary" onClick={addActionItem}>
                <Plus size={12} className="mr-1" />
                {t('rules.form.addAction')}
              </Button>
            </div>
            <div className="space-y-2">
              {form.actionItems.map((item, index) => (
                <div key={`action-${index}`} className="rounded-md border border-border-subtle p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select
                        value={item.actionType}
                        options={actionTypeOptions}
                        onChange={(value) => updateActionItemType(index, value as RuleActionType)}
                      />
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="tertiary"
                      onClick={() => removeActionItem(index)}
                      disabled={form.actionItems.length <= 1}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                  {advancedMode ? (
                    <textarea
                      className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
                      rows={5}
                      value={item.paramsJson}
                      onChange={(e) => updateActionItemParams(index, e.target.value)}
                      placeholder='{"channel":"chat"}'
                    />
                  ) : (
                    <pre className="rounded-md border border-border-default bg-bg-surface px-3 py-2 text-xs text-text-secondary">
                      {JSON.stringify(defaultActionParams(item.actionType), null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.priority')}</p>
              <Input
                type="number"
                value={String(form.priority)}
                onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value || 0) }))}
              />
              <p className="text-[11px] text-text-tertiary">{t('rules.formHelp.priority')}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.dedupe')}</p>
              <Input
                type="number"
                value={String(form.dedupeWindowSeconds)}
                onChange={(e) => setForm((prev) => ({ ...prev, dedupeWindowSeconds: Number(e.target.value || 0) }))}
              />
              <p className="text-[11px] text-text-tertiary">{t('rules.formHelp.dedupe')}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.cooldown')}</p>
              <Input
                type="number"
                value={String(form.cooldownSeconds)}
                onChange={(e) => setForm((prev) => ({ ...prev, cooldownSeconds: Number(e.target.value || 0) }))}
              />
              <p className="text-[11px] text-text-tertiary">{t('rules.formHelp.cooldown')}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('rules.form.budgetPerDay')}</p>
              <Input
                type="number"
                value={String(form.attentionBudgetPerDay)}
                onChange={(e) => setForm((prev) => ({ ...prev, attentionBudgetPerDay: Number(e.target.value || 0) }))}
              />
              <p className="text-[11px] text-text-tertiary">{t('rules.formHelp.budgetPerDay')}</p>
            </div>
          </div>
          {formError && (
            <p className="text-xs text-error-500">{formError}</p>
          )}
        </div>
      </Modal>
    </div>
  )
}
