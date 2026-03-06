/**
 * Events API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, errors, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { runtimeRequest } from '../../lib/runtime-client'
import * as eventEngineService from '../../services/event-engine.service'
import * as sessionService from '../../services/session.service'
import { createLogger } from '../../lib/logger'

const router: Router = Router()
const eventsRouteLogger = createLogger('events-route')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const listEventsQuerySchema = z.object({
  type: z.string().max(120).optional(),
  page: z.coerce.number().min(1).max(1000).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(120).optional(),
  session_id: z.string().min(1).max(120).optional(),
})

const replaySchema = z.object({
  event_id: z.string().min(1),
})

const stringMapSchema = z.record(z.string().min(1).max(120), z.string().min(1).max(120))

const updatePresentationSchema = z.object({
  eventTypeLabels: stringMapSchema.optional(),
  categoryLabels: stringMapSchema.optional(),
  actionLabels: stringMapSchema.optional(),
})

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function isUuidSessionId(value: string | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function eventBelongsToSession(event: unknown, sessionId: string): boolean {
  if (!event || typeof event !== 'object') return false
  const row = event as Record<string, unknown>
  const subject = normalizeSessionId(row.subject)
  if (subject === sessionId) return true

  const payload = row.payload
  if (!payload || typeof payload !== 'object') return false
  const payloadRecord = payload as Record<string, unknown>
  const direct = normalizeSessionId(payloadRecord.session_id) ?? normalizeSessionId(payloadRecord.sessionId)
  if (direct === sessionId) return true

  const nestedSession = payloadRecord.session
  if (nestedSession && typeof nestedSession === 'object') {
    const nestedId = normalizeSessionId((nestedSession as Record<string, unknown>).id)
    if (nestedId === sessionId) return true
  }
  return false
}

type SessionDerivedEvent = {
  event_id: string
  event_type: string
  source: string
  subject: string
  payload: Record<string, unknown>
  risk_hint: 'low' | 'medium' | 'high'
  timestamp: string
}

export function normalizeEventTimestamp(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return new Date().toISOString()
}

function deriveSessionEventsFromMessages(
  sessionId: string,
  messages: Awaited<ReturnType<typeof sessionService.getSessionMessages>>
): SessionDerivedEvent[] {
  const derived: SessionDerivedEvent[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      derived.push({
        event_id: `evt_${sessionId}_${msg.id}_user`,
        event_type: 'chat.message.received',
        source: 'api.session_messages',
        subject: sessionId,
        payload: {
          session_id: sessionId,
          message: msg.content,
        },
        risk_hint: 'low',
        timestamp: normalizeEventTimestamp(msg.createdAt),
      })
      continue
    }

    if (msg.role !== 'assistant') continue
    const metadata = msg.metadata as Record<string, unknown> | undefined
    const executionProcess = metadata?.execution_process as Record<string, unknown> | undefined
    const timeline = Array.isArray(executionProcess?.messages)
      ? executionProcess.messages as Array<Record<string, unknown>>
      : []

    for (const item of timeline) {
      const eventTimestamp = normalizeEventTimestamp(item.timestamp ?? msg.createdAt)
      const itemType = String(item.type || '')
      const itemId = String(item.id || '')
      const data = (item.data && typeof item.data === 'object')
        ? item.data as Record<string, unknown>
        : {}

      if (itemType === 'tool_call') {
        const toolName = String(data.toolName || '')
        if (!toolName) continue
        derived.push({
          event_id: `evt_${sessionId}_${itemId || `tool_call_${derived.length}`}`,
          event_type: 'tool.exec.started',
          source: 'api.session_messages',
          subject: toolName,
          payload: {
            session_id: sessionId,
            tool_name: toolName,
            params: data.arguments,
          },
          risk_hint: 'low',
          timestamp: eventTimestamp,
        })
        continue
      }

      if (itemType === 'tool_result') {
        const toolName = String(data.toolName || '')
        if (!toolName) continue
        const success = Boolean(data.success)
        derived.push({
          event_id: `evt_${sessionId}_${itemId || `tool_result_${derived.length}`}`,
          event_type: success ? 'tool.exec.completed' : 'tool.exec.failed',
          source: 'api.session_messages',
          subject: toolName,
          payload: {
            session_id: sessionId,
            tool_name: toolName,
            result: data.result ?? null,
            error: data.error ?? null,
            success,
          },
          risk_hint: success ? 'low' : 'medium',
          timestamp: eventTimestamp,
        })
      }
    }

    derived.push({
      event_id: `evt_${sessionId}_${msg.id}_done`,
      event_type: 'task.completed',
      source: 'api.session_messages',
      subject: sessionId,
      payload: {
        session_id: sessionId,
        final_response: msg.content,
      },
      risk_hint: 'low',
      timestamp: normalizeEventTimestamp(msg.createdAt),
    })
  }

  derived.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return derived
}

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  validate(listEventsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { type, page, limit, sessionId, session_id } = req.query as z.infer<typeof listEventsQuerySchema>
    const targetSessionId = normalizeSessionId(sessionId) ?? normalizeSessionId(session_id)
    const perPage = limit ?? 50
    const pageNumber = page ?? 1
    const runtimeLimit = targetSessionId ? Math.max(perPage * pageNumber, 300) : perPage
    const payload = await runtimeRequest<{ items?: unknown[]; next_cursor?: string | null }>('/v1/events', {
      method: 'GET',
      query: {
        event_type: type,
        limit: runtimeLimit,
      },
      timeoutMs: 4000,
    })
    const rawItems = Array.isArray(payload.items) ? payload.items : []
    let filteredItems = targetSessionId
      ? rawItems.filter((item) => eventBelongsToSession(item, targetSessionId))
      : rawItems

    if (isUuidSessionId(targetSessionId) && filteredItems.length === 0) {
      try {
        const sessionMessages = await sessionService.getSessionMessages(req.user!.orgId, targetSessionId)
        filteredItems = deriveSessionEventsFromMessages(targetSessionId, sessionMessages)
      } catch (error) {
        eventsRouteLogger.debug('derive_session_events_from_messages_failed', {
          sessionId: targetSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const start = (pageNumber - 1) * perPage
    const items = filteredItems.slice(start, start + perPage)
    res.json({
      success: true,
      items,
      page: pageNumber,
      limit: perPage,
      total: filteredItems.length,
      next_cursor: payload.next_cursor ?? null,
    })
  })
)

router.post(
  '/replay',
  authenticate,
  combinedRateLimit,
  requirePermission('events:write'),
  validate(replaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { event_id } = req.body as z.infer<typeof replaySchema>
    const replay = await runtimeRequest<{ event_id?: string; matched_rules?: number; outcomes?: unknown[] }>(
      '/v1/events/replay',
      {
        method: 'POST',
        body: { event_id },
        timeoutMs: 5000,
      }
    )
    res.json({
      success: true,
      accepted: true,
      replay_id: replay.event_id || event_id,
      matched_rules: replay.matched_rules ?? 0,
      outcomes: Array.isArray(replay.outcomes) ? replay.outcomes : [],
    })
  })
)

router.get(
  '/presentation',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const dictionary = await eventEngineService.getEventPresentationDictionary(req.user!.orgId)
    res.json({
      success: true,
      data: dictionary,
    })
  })
)

router.put(
  '/presentation',
  authenticate,
  combinedRateLimit,
  requirePermission('events:write'),
  validate(updatePresentationSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      throw errors.forbidden('仅 owner/admin 可更新事件展示字典')
    }

    const payload = req.body as z.infer<typeof updatePresentationSchema>
    const dictionary = await eventEngineService.updateEventPresentationDictionary(req.user!.orgId, payload)
    res.json({
      success: true,
      data: dictionary,
    })
  })
)

export default router
