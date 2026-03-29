/**
 * Message Repository — 消息历史保存在 checkpoints，此处为兼容层
 */

import * as local from '../lib/session-local-store'

export type { MessageRole, ToolCall, LocalMessageRow as MessageRow } from '../lib/session-local-store'

export interface CreateMessageData {
  sessionId: string
  attemptId?: string
  userMessageId?: string
  role: local.MessageRole
  content: string
  parentId?: string
  toolCalls?: local.ToolCall[]
  toolCallId?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
}

export interface UpdateMessageData {
  content?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
}

export async function create(data: CreateMessageData): Promise<local.LocalMessageRow> {
  return local.localCreateMessage(data)
}

export async function findById(_id: string): Promise<local.LocalMessageRow | null> {
  return null
}

export async function findByIdAndOrg(_id: string): Promise<local.LocalMessageRow | null> {
  return null
}

export async function findBySessionId(sessionId: string): Promise<local.LocalMessageRow[]> {
  return local.localFindMessagesBySessionId(sessionId)
}

export async function findByAttemptId(attemptId: string): Promise<local.LocalMessageRow[]> {
  return local.localFindMessagesByAttemptId(attemptId)
}

export async function countBySessionId(sessionId: string): Promise<number> {
  return local.localCountMessagesBySessionId(sessionId)
}

export async function update(_id: string, _data: UpdateMessageData): Promise<local.LocalMessageRow | null> {
  return null
}

export async function softDeleteBySessionId(_sessionId: string, _deletedBy?: string): Promise<number> {
  return 0
}
