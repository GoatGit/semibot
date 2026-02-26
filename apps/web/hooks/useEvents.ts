'use client'

import { useCallback, useState } from 'react'
import { apiClient } from '@/lib/api'
import type { EventRecord } from '@/types'

interface EventsQuery {
  type?: string
  limit?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeEvent(raw: unknown): EventRecord | null {
  if (!isObject(raw)) return null

  const id = readString(raw.id)
  if (!id) return null

  const eventType = readString(raw.eventType) || readString(raw.event_type)
  const source = readString(raw.source)
  const subject = readString(raw.subject)
  const createdAt = readString(raw.createdAt) || readString(raw.created_at)
  const riskHint = readString(raw.riskHint) || readString(raw.risk_hint)
  const payload = isObject(raw.payload) ? raw.payload : undefined

  return {
    id,
    eventType: eventType || 'unknown',
    source: source || 'system',
    subject: subject || undefined,
    payload,
    riskHint: (riskHint || undefined) as EventRecord['riskHint'],
    createdAt: createdAt || new Date().toISOString(),
  }
}

function normalizeEventsResponse(raw: unknown): EventRecord[] {
  if (!isObject(raw)) return []

  const asItems = Array.isArray(raw.items) ? raw.items : []
  const asData = Array.isArray(raw.data) ? raw.data : []
  const nestedItems =
    isObject(raw.data) && Array.isArray((raw.data as Record<string, unknown>).items)
      ? ((raw.data as Record<string, unknown>).items as unknown[])
      : []

  const merged = [...asItems, ...asData, ...nestedItems]
  const seen = new Set<string>()
  const events: EventRecord[] = []

  for (const item of merged) {
    const normalized = normalizeEvent(item)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    events.push(normalized)
  }

  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

export function useEvents() {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiAvailable, setApiAvailable] = useState(true)

  const loadEvents = useCallback(async (query: EventsQuery = {}) => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<unknown>('/events', {
        params: {
          type: query.type,
          limit: query.limit ?? 50,
        },
      })

      setEvents(normalizeEventsResponse(response))
      setError(null)
      setApiAvailable(true)
    } catch (err) {
      const status = getHttpStatus(err)
      if (status === 404) {
        setApiAvailable(false)
        setError('事件接口尚未接入（/v1/events）')
      } else {
        setError(getErrorMessage(err, '加载事件失败'))
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const replayEvent = useCallback(async (eventId: string): Promise<void> => {
    await apiClient.post('/events/replay', { event_id: eventId })
  }, [])

  return {
    events,
    isLoading,
    error,
    apiAvailable,
    loadEvents,
    replayEvent,
  }
}
