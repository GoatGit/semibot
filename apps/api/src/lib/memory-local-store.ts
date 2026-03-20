/**
 * Memory SQLite 存储（含向量搜索）
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'
import { createLogger } from './logger'

const logger = createLogger('memory-local-store')

export interface LocalMemoryRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string | null
  user_id: string | null
  content: string
  embedding: number[] | null
  memory_type: 'episodic' | 'semantic' | 'procedural'
  importance: number
  access_count: number
  last_accessed_at: string | null
  metadata: Record<string, unknown>
  expires_at: string | null
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToMemory(row: Record<string, unknown>): LocalMemoryRow {
  return {
    id: row.id as string,
    org_id: 'local',
    agent_id: row.agent_id as string,
    session_id: (row.session_id as string) ?? null,
    user_id: null,
    content: row.content as string,
    embedding: row.embedding_json ? JSON.parse(row.embedding_json as string) : null,
    memory_type: (row.memory_type as LocalMemoryRow['memory_type']) ?? 'episodic',
    importance: (row.importance as number) ?? 0.5,
    access_count: (row.access_count as number) ?? 0,
    last_accessed_at: (row.last_accessed_at as string) ?? null,
    metadata: JSON.parse((row.metadata_json as string) ?? '{}'),
    expires_at: (row.expires_at as string) ?? null,
    created_at: row.created_at as string,
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function localCreateMemory(data: {
  agentId: string
  sessionId?: string
  userId?: string
  content: string
  memoryType?: 'episodic' | 'semantic' | 'procedural'
  importance?: number
  metadata?: Record<string, unknown>
  expiresAt?: string
}): LocalMemoryRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO memories (id, agent_id, session_id, content, memory_type, importance, access_count, metadata_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id, data.agentId, data.sessionId ?? null, data.content,
    data.memoryType ?? 'episodic', data.importance ?? 0.5,
    JSON.stringify(data.metadata ?? {}), data.expiresAt ?? null, now
  )
  logger.debug('创建 memory', { id })
  return rowToMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindMemoryById(id: string): LocalMemoryRow | null {
  const row = getLocalDb().prepare('SELECT * FROM memories WHERE id = ?').get(id)
  return row ? rowToMemory(row as Record<string, unknown>) : null
}

export function localFindMemoriesByAgent(agentId: string, options: {
  memoryType?: string
  limit?: number
  minImportance?: number
} = {}): LocalMemoryRow[] {
  let where = 'WHERE agent_id = ?'
  const binds: unknown[] = [agentId]
  if (options.memoryType) { where += ' AND memory_type = ?'; binds.push(options.memoryType) }
  if (options.minImportance !== undefined) { where += ' AND importance >= ?'; binds.push(options.minImportance) }
  const limit = options.limit ?? 100
  const rows = getLocalDb().prepare(
    `SELECT * FROM memories ${where} ORDER BY importance DESC, created_at DESC LIMIT ?`
  ).all(...binds, limit)
  return rows.map((r) => rowToMemory(r as Record<string, unknown>))
}

export function localUpdateMemoryEmbedding(id: string, embedding: number[]): void {
  getLocalDb().prepare('UPDATE memories SET embedding_json = ? WHERE id = ?').run(JSON.stringify(embedding), id)
}

export function localIncrementMemoryAccess(id: string): void {
  getLocalDb().prepare(
    'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
  ).run(nowIso(), id)
}

export function localDeleteMemory(id: string): boolean {
  const result = getLocalDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
  return (result.changes ?? 0) > 0
}

export function localDeleteExpiredMemories(): number {
  const result = getLocalDb().prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(nowIso())
  return result.changes ?? 0
}

export function localFindMemoriesByEmbedding(
  embedding: number[],
  agentId: string,
  limit = 5,
  threshold = 0.6
): Array<LocalMemoryRow & { similarity: number }> {
  const rows = getLocalDb().prepare(
    'SELECT * FROM memories WHERE agent_id = ? AND embedding_json IS NOT NULL'
  ).all(agentId) as Record<string, unknown>[]

  return rows
    .map((r) => {
      const mem = rowToMemory(r)
      return { ...mem, similarity: cosineSimilarity(embedding, mem.embedding!) }
    })
    .filter((m) => m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}

// ─── Short-term memory ────────────────────────────────────────

export interface LocalShortTermMemoryRow {
  id: string
  session_id: string
  agent_id: string
  content: string
  updated_at: string
}

export function localUpsertShortTermMemory(sessionId: string, agentId: string, content: string): LocalShortTermMemoryRow {
  const db = getLocalDb()
  const now = nowIso()
  const existing = db.prepare('SELECT * FROM short_term_memory WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
  if (existing) {
    db.prepare('UPDATE short_term_memory SET content = ?, updated_at = ? WHERE session_id = ?').run(content, now, sessionId)
    return { id: existing.id as string, session_id: sessionId, agent_id: agentId, content, updated_at: now }
  }
  const id = randomUUID()
  db.prepare('INSERT INTO short_term_memory (id, session_id, agent_id, content, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, agentId, content, now)
  return { id, session_id: sessionId, agent_id: agentId, content, updated_at: now }
}

export function localGetShortTermMemory(sessionId: string): LocalShortTermMemoryRow | null {
  const row = getLocalDb().prepare('SELECT * FROM short_term_memory WHERE session_id = ?').get(sessionId)
  if (!row) return null
  const r = row as Record<string, unknown>
  return { id: r.id as string, session_id: r.session_id as string, agent_id: r.agent_id as string, content: r.content as string, updated_at: r.updated_at as string }
}

export function localDeleteShortTermMemory(sessionId: string): boolean {
  const result = getLocalDb().prepare('DELETE FROM short_term_memory WHERE session_id = ?').run(sessionId)
  return (result.changes ?? 0) > 0
}
