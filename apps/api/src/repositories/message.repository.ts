/**
 * Message Repository
 *
 * 处理 Message 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface MessageRow {
  id: string
  session_id: string
  parent_id: string | null
  role: MessageRole
  content: string
  tool_calls: ToolCall[] | null
  tool_call_id: string | null
  tokens_used: number | null
  latency_ms: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface CreateMessageData {
  sessionId: string
  role: MessageRole
  content: string
  parentId?: string
  toolCalls?: ToolCall[]
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

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Message
 */
export async function create(data: CreateMessageData): Promise<MessageRow> {
  const result = await sql`
    INSERT INTO messages (
      session_id, parent_id, role, content,
      tool_calls, tool_call_id, tokens_used, latency_ms, metadata
    )
    VALUES (
      ${data.sessionId},
      ${data.parentId ?? null},
      ${data.role},
      ${data.content},
      ${data.toolCalls ? JSON.stringify(data.toolCalls) : null},
      ${data.toolCallId ?? null},
      ${data.tokensUsed ?? null},
      ${data.latencyMs ?? null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}
    )
    RETURNING *
  `

  return result[0] as unknown as MessageRow
}

/**
 * 根据 ID 获取 Message
 */
export async function findById(id: string): Promise<MessageRow | null> {
  const result = await sql`
    SELECT * FROM messages WHERE id = ${id}
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as MessageRow
}

/**
 * 根据 Session ID 获取所有 Messages
 */
export async function findBySessionId(sessionId: string): Promise<MessageRow[]> {
  const result = await sql`
    SELECT * FROM messages
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
  `

  return result as unknown as MessageRow[]
}

/**
 * 统计 Session 的 Message 数量
 */
export async function countBySessionId(sessionId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM messages WHERE session_id = ${sessionId}
  `

  return parseInt((result[0] as { count: string }).count, 10)
}

/**
 * 更新 Message
 */
export async function update(id: string, data: UpdateMessageData): Promise<MessageRow | null> {
  const message = await findById(id)
  if (!message) return null

  const newContent = data.content ?? message.content
  const newTokensUsed = data.tokensUsed ?? message.tokens_used
  const newLatencyMs = data.latencyMs ?? message.latency_ms
  const newMetadata = data.metadata ? JSON.stringify(data.metadata) : null

  const result = await sql`
    UPDATE messages
    SET content = ${newContent},
        tokens_used = ${newTokensUsed},
        latency_ms = ${newLatencyMs},
        metadata = COALESCE(${newMetadata}::jsonb, metadata)
    WHERE id = ${id}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as MessageRow
}

/**
 * 删除 Session 的所有 Messages
 */
export async function deleteBySessionId(sessionId: string): Promise<number> {
  const result = await sql`
    DELETE FROM messages
    WHERE session_id = ${sessionId}
    RETURNING id
  `

  return result.length
}
