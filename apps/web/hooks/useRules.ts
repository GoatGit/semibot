'use client'

import { useCallback, useState } from 'react'
import { apiClient } from '@/lib/api'
import type { EventRule, RuleActionMode, RuleActionType, RiskLevel } from '@/types'

interface CreateRuleInput {
  name: string
  eventType: string
  actionMode: RuleActionMode
  actionType: RuleActionType
  riskLevel: RiskLevel
  priority: number
  dedupeWindowSeconds?: number
  cooldownSeconds?: number
  attentionBudgetPerDay?: number
}

interface UpdateRuleInput {
  name?: string
  eventType?: string
  actionMode?: RuleActionMode
  actionType?: RuleActionType
  riskLevel?: RiskLevel
  priority?: number
  dedupeWindowSeconds?: number
  cooldownSeconds?: number
  attentionBudgetPerDay?: number
  isActive?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeRule(raw: unknown): EventRule | null {
  if (!isObject(raw)) return null

  const id = readString(raw.id)
  if (!id) return null

  return {
    id,
    name: readString(raw.name, '未命名规则'),
    eventType: readString(raw.eventType) || readString(raw.event_type, 'unknown'),
    actionMode: (readString(raw.actionMode) || readString(raw.action_mode) || 'suggest') as EventRule['actionMode'],
    riskLevel: (readString(raw.riskLevel) || readString(raw.risk_level) || 'low') as EventRule['riskLevel'],
    priority: readNumber(raw.priority, 50),
    isActive: readBoolean(raw.isActive, readBoolean(raw.is_active, true)),
    dedupeWindowSeconds: readNumber(raw.dedupeWindowSeconds, readNumber(raw.dedupe_window_seconds, 0)),
    cooldownSeconds: readNumber(raw.cooldownSeconds, readNumber(raw.cooldown_seconds, 0)),
    attentionBudgetPerDay: readNumber(raw.attentionBudgetPerDay, readNumber(raw.attention_budget_per_day, 0)),
  }
}

function normalizeRulesResponse(raw: unknown): EventRule[] {
  if (!isObject(raw)) return []
  const items =
    Array.isArray(raw.items)
      ? raw.items
      : isObject(raw.data) && Array.isArray((raw.data as Record<string, unknown>).items)
        ? ((raw.data as Record<string, unknown>).items as unknown[])
        : Array.isArray(raw.data)
          ? raw.data
          : []

  return items
    .map(normalizeRule)
    .filter((item): item is EventRule => item !== null)
    .sort((a, b) => b.priority - a.priority)
}

function getHttpStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined
  const response = error.response
  if (!isObject(response)) return undefined
  return typeof response.status === 'number' ? response.status : undefined
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (isObject(error) && typeof error.message === 'string') {
    return error.message
  }
  return fallback
}

export function useRules() {
  const [rules, setRules] = useState<EventRule[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiAvailable, setApiAvailable] = useState(true)

  const loadRules = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<unknown>('/rules')
      setRules(normalizeRulesResponse(response))
      setError(null)
      setApiAvailable(true)
    } catch (err) {
      const status = getHttpStatus(err)
      if (status === 404) {
        setApiAvailable(false)
        setError('规则接口尚未接入（/v1/rules）')
      } else {
        setError(getErrorMessage(err, '加载规则失败'))
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const createRule = useCallback(async (input: CreateRuleInput) => {
    await apiClient.post('/rules', {
      name: input.name,
      event_type: input.eventType,
      conditions: { all: [] },
      action_mode: input.actionMode,
      actions: [
        {
          action_type: input.actionType,
          params: { channel: 'chat' },
        },
      ],
      risk_level: input.riskLevel,
      priority: input.priority,
      dedupe_window_seconds: input.dedupeWindowSeconds ?? 300,
      cooldown_seconds: input.cooldownSeconds ?? 600,
      attention_budget_per_day: input.attentionBudgetPerDay ?? 10,
      is_active: true,
    })
  }, [])

  const updateRule = useCallback(async (ruleId: string, input: UpdateRuleInput) => {
    const payload: Record<string, unknown> = {}

    if (input.name !== undefined) payload.name = input.name
    if (input.eventType !== undefined) payload.event_type = input.eventType
    if (input.actionMode !== undefined) payload.action_mode = input.actionMode
    if (input.riskLevel !== undefined) payload.risk_level = input.riskLevel
    if (input.priority !== undefined) payload.priority = input.priority
    if (input.dedupeWindowSeconds !== undefined) payload.dedupe_window_seconds = input.dedupeWindowSeconds
    if (input.cooldownSeconds !== undefined) payload.cooldown_seconds = input.cooldownSeconds
    if (input.attentionBudgetPerDay !== undefined) payload.attention_budget_per_day = input.attentionBudgetPerDay
    if (input.isActive !== undefined) payload.is_active = input.isActive
    if (input.actionType !== undefined) {
      payload.actions = [
        {
          action_type: input.actionType,
          params: { channel: 'chat' },
        },
      ]
    }

    await apiClient.put(`/rules/${ruleId}`, payload)
  }, [])

  return {
    rules,
    isLoading,
    error,
    apiAvailable,
    loadRules,
    createRule,
    updateRule,
  }
}
