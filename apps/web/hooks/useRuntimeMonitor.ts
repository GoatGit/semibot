'use client'

import { useCallback, useState } from 'react'
import { apiClient } from '@/lib/api'
import type { EventRecord, RuntimeMonitorSnapshot, RuntimeMonitorSummary, RuntimeStaleSession } from '@/types'

interface RuntimeMonitorQuery {
  limit?: number
  sessionId?: string
  capability?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function normalizeEvent(raw: unknown): EventRecord | null {
  if (!isObject(raw)) return null
  const id = readString(raw.id) || readString(raw.event_id)
  if (!id) return null
  return {
    id,
    eventType: readString(raw.eventType) || readString(raw.event_type) || 'unknown',
    source: readString(raw.source) || 'runtime',
    subject: readString(raw.subject) || undefined,
    payload: isObject(raw.payload) ? raw.payload : undefined,
    riskHint: (readString(raw.riskHint) || readString(raw.risk_hint) || undefined) as EventRecord['riskHint'],
    createdAt: readString(raw.createdAt) || readString(raw.created_at) || readString(raw.timestamp) || new Date().toISOString(),
  }
}

function normalizeEvents(raw: unknown): EventRecord[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(normalizeEvent)
    .filter((item): item is EventRecord => item !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function normalizeSummary(raw: unknown): RuntimeMonitorSummary {
  const source = isObject(raw) ? raw : {}
  const routeModeCounts = isObject(source.routeModeCounts) ? source.routeModeCounts : {}
  return {
    signalCount: readNumber(source.signalCount),
    failureCount: readNumber(source.failureCount),
    heartbeatCount: readNumber(source.heartbeatCount),
    usageCallCount: readNumber(source.usageCallCount),
    routeDecisionCount: readNumber(source.routeDecisionCount),
    routeModeCounts: {
      direct_answer: readNumber(routeModeCounts.direct_answer),
      direct_reasoning: readNumber(routeModeCounts.direct_reasoning),
      plan_act: readNumber(routeModeCounts.plan_act),
      delegate: readNumber(routeModeCounts.delegate),
    },
    drRunCount: readNumber(source.drRunCount),
    drUpgradeCount: readNumber(source.drUpgradeCount),
    promptTokens24h: readNumber(source.promptTokens24h),
    completionTokens24h: readNumber(source.completionTokens24h),
    totalTokens24h: readNumber(source.totalTokens24h),
    latestSignalAt: readString(source.latestSignalAt) || null,
    latestFailureAt: readString(source.latestFailureAt) || null,
    latestHeartbeatAt: readString(source.latestHeartbeatAt) || null,
    loopAlertCount: readNumber(source.loopAlertCount),
    retryableFailureCount: readNumber(source.retryableFailureCount),
    activeSessionCount: readNumber(source.activeSessionCount),
    staleSessionCount: readNumber(source.staleSessionCount),
  }
}

function normalizeStaleSessions(raw: unknown): RuntimeStaleSession[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!isObject(item)) return null
      const sessionId = readString(item.sessionId) || readString(item.session_id)
      const lastHeartbeatAt = readString(item.lastHeartbeatAt) || readString(item.last_heartbeat_at)
      if (!sessionId || !lastHeartbeatAt) return null
      return {
        sessionId,
        lastHeartbeatAt,
        ageSeconds: readNumber(item.ageSeconds ?? item.age_seconds),
      }
    })
    .filter((item): item is RuntimeStaleSession => item !== null)
}

function emptySnapshot(available = false, error?: string): RuntimeMonitorSnapshot {
  return {
    available,
    error,
    summary: {
      signalCount: 0,
      failureCount: 0,
      heartbeatCount: 0,
      usageCallCount: 0,
      routeDecisionCount: 0,
      routeModeCounts: {
        direct_answer: 0,
        direct_reasoning: 0,
        plan_act: 0,
        delegate: 0,
      },
      drRunCount: 0,
      drUpgradeCount: 0,
      promptTokens24h: 0,
      completionTokens24h: 0,
      totalTokens24h: 0,
      latestSignalAt: null,
      latestFailureAt: null,
      latestHeartbeatAt: null,
      loopAlertCount: 0,
      retryableFailureCount: 0,
      activeSessionCount: 0,
      staleSessionCount: 0,
    },
    timeline: [],
    signals: [],
    failures: [],
    heartbeats: [],
    usage: [],
    staleSessions: [],
  }
}

export function useRuntimeMonitor() {
  const [snapshot, setSnapshot] = useState<RuntimeMonitorSnapshot>(emptySnapshot())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRuntimeMonitor = useCallback(async (query: RuntimeMonitorQuery = {}) => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<{ data?: unknown }>('/runtime/monitor', {
        params: {
          limit: query.limit ?? 200,
          sessionId: query.sessionId,
          capability: query.capability,
        },
      })
      const data = isObject(response?.data) ? response.data : {}
      setSnapshot({
        available: Boolean(data.available),
        error: readString(data.error) || undefined,
        summary: normalizeSummary(data.summary),
        timeline: normalizeEvents(data.timeline),
        signals: normalizeEvents(data.signals),
        failures: normalizeEvents(data.failures),
        heartbeats: normalizeEvents(data.heartbeats),
        usage: normalizeEvents(data.usage),
        staleSessions: normalizeStaleSessions(data.staleSessions),
      })
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载 Runtime Monitor 失败'
      setSnapshot(emptySnapshot(false, message))
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    snapshot,
    isLoading,
    error,
    loadRuntimeMonitor,
  }
}
