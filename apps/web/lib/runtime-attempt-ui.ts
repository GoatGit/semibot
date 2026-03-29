import type { ApprovalRecord, EventRecord } from '@/types'

export function tailId(value: string, count = 8): string {
  if (!value) return '--'
  return value.length <= count ? value : `…${value.slice(-count)}`
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getPayloadValue(payload: EventRecord['payload'], key: string): unknown {
  if (!payload || typeof payload !== 'object') return undefined
  if (!key.includes('.')) return payload[key]
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[part]
  }, payload)
}

export function readPayloadString(payload: EventRecord['payload'], ...keys: string[]): string {
  for (const key of keys) {
    const value = getPayloadValue(payload, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

export function getEventSessionId(event: EventRecord): string {
  return readPayloadString(event.payload, 'session_id', 'sessionId')
}

export function getEventAttemptId(event: EventRecord): string {
  return readPayloadString(event.payload, 'attempt_id', 'attemptId')
}

export function extractApprovalSessionId(approval: ApprovalRecord): string {
  if (approval.sessionId) return approval.sessionId
  const context = readObject(approval.context)
  if (!context) return ''
  return (
    readStringField(context.session_id)
    || readStringField(context.sessionId)
    || readStringField(context.runtime_session_id)
    || readStringField(context.runtimeSessionId)
    || readStringField(context.approval_scope_id)
    || readStringField(context.approvalScopeId)
  )
}

export function extractApprovalAttemptId(approval: ApprovalRecord): string {
  if (approval.attemptId) return approval.attemptId
  const context = readObject(approval.context)
  if (!context) return ''
  return readStringField(context.attempt_id) || readStringField(context.attemptId)
}
