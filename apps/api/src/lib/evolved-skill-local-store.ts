/**
 * Evolved Skill SQLite 存储（含向量搜索）
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'
import { createLogger } from './logger'

const logger = createLogger('evolved-skill-local-store')

export interface LocalEvolvedSkillRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string
  name: string
  description: string
  trigger_keywords: string[]
  steps: unknown[]
  tools_used: string[]
  parameters: Record<string, unknown>
  preconditions: Record<string, unknown>
  expected_outcome: string | null
  embedding: number[] | null
  quality_score: number
  reusability_score: number
  status: string
  use_count: number
  success_count: number
  last_used_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_comment: string | null
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToSkill(row: Record<string, unknown>): LocalEvolvedSkillRow {
  return {
    id: row.id as string,
    org_id: (row.org_id as string) ?? 'local',
    agent_id: row.agent_id as string,
    session_id: row.session_id as string,
    name: row.name as string,
    description: row.description as string,
    trigger_keywords: JSON.parse((row.trigger_keywords_json as string) ?? '[]'),
    steps: JSON.parse((row.steps_json as string) ?? '[]'),
    tools_used: JSON.parse((row.tools_used_json as string) ?? '[]'),
    parameters: JSON.parse((row.parameters_json as string) ?? '{}'),
    preconditions: JSON.parse((row.preconditions_json as string) ?? '{}'),
    expected_outcome: (row.expected_outcome as string) ?? null,
    embedding: row.embedding_json ? JSON.parse(row.embedding_json as string) : null,
    quality_score: row.quality_score as number,
    reusability_score: row.reusability_score as number,
    status: row.status as string,
    use_count: row.use_count as number,
    success_count: row.success_count as number,
    last_used_at: (row.last_used_at as string) ?? null,
    reviewed_by: (row.reviewed_by as string) ?? null,
    reviewed_at: (row.reviewed_at as string) ?? null,
    review_comment: (row.review_comment as string) ?? null,
    version: row.version as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
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

export function localCreateEvolvedSkill(data: {
  agentId: string
  sessionId: string
  name: string
  description: string
  triggerKeywords?: string[]
  steps: unknown[]
  toolsUsed: string[]
  parameters?: Record<string, unknown>
  preconditions?: Record<string, unknown>
  expectedOutcome?: string
  qualityScore: number
  reusabilityScore: number
  status: string
}): LocalEvolvedSkillRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO evolved_skills
      (id, agent_id, session_id, name, description, trigger_keywords_json, steps_json, tools_used_json,
       parameters_json, preconditions_json, expected_outcome, quality_score, reusability_score, status,
       use_count, success_count, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
  `).run(
    id, data.agentId, data.sessionId, data.name, data.description,
    JSON.stringify(data.triggerKeywords ?? []), JSON.stringify(data.steps),
    JSON.stringify(data.toolsUsed), JSON.stringify(data.parameters ?? {}),
    JSON.stringify(data.preconditions ?? {}), data.expectedOutcome ?? null,
    data.qualityScore, data.reusabilityScore, data.status, now, now
  )
  logger.debug('创建 evolved skill', { id })
  return rowToSkill(db.prepare('SELECT * FROM evolved_skills WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindEvolvedSkillById(id: string): LocalEvolvedSkillRow | null {
  const row = getLocalDb().prepare('SELECT * FROM evolved_skills WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToSkill(row as Record<string, unknown>) : null
}

export function localFindEvolvedSkillByIdAndOrg(id: string): LocalEvolvedSkillRow | null {
  return localFindEvolvedSkillById(id)
}

export function localFindEvolvedSkillsByOrg(params: {
  status?: string
  agentId?: string
  page?: number
  limit?: number
} = {}): { data: LocalEvolvedSkillRow[]; meta: { total: number; page: number; limit: number; totalPages: number } } {
  const db = getLocalDb()
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (params.status) { where += ' AND status = ?'; binds.push(params.status) }
  if (params.agentId) { where += ' AND agent_id = ?'; binds.push(params.agentId) }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM evolved_skills ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM evolved_skills ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, limit, offset)
  return {
    data: rows.map((r) => rowToSkill(r as Record<string, unknown>)),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export function localUpdateEvolvedSkill(id: string, data: {
  status?: string
  reviewedBy?: string
  reviewedAt?: string
  reviewComment?: string
}): LocalEvolvedSkillRow | null {
  const db = getLocalDb()
  const sets: string[] = ['version = version + 1', 'updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (data.status !== undefined) { sets.push('status = ?'); vals.push(data.status) }
  if (data.reviewedBy !== undefined) { sets.push('reviewed_by = ?'); vals.push(data.reviewedBy) }
  if (data.reviewedAt !== undefined) { sets.push('reviewed_at = ?'); vals.push(data.reviewedAt) }
  if (data.reviewComment !== undefined) { sets.push('review_comment = ?'); vals.push(data.reviewComment) }
  vals.push(id)
  const result = db.prepare(`UPDATE evolved_skills SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToSkill(db.prepare('SELECT * FROM evolved_skills WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localUpdateEvolvedSkillStatus(id: string, status: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE evolved_skills SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(status, nowIso(), id)
  return (result.changes ?? 0) > 0
}

export function localSoftDeleteEvolvedSkill(id: string, deletedBy: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE evolved_skills SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), deletedBy, nowIso(), id)
  return (result.changes ?? 0) > 0
}

export function localIncrementEvolvedSkillUseCount(id: string): void {
  getLocalDb().prepare(
    'UPDATE evolved_skills SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), nowIso(), id)
}

export function localIncrementEvolvedSkillSuccessCount(id: string): void {
  getLocalDb().prepare(
    'UPDATE evolved_skills SET success_count = success_count + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), id)
}

export function localUpdateEvolvedSkillEmbedding(id: string, embedding: number[]): void {
  getLocalDb().prepare(
    'UPDATE evolved_skills SET embedding_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(JSON.stringify(embedding), nowIso(), id)
}

export function localFindEvolvedSkillsByEmbedding(
  embedding: number[],
  limit = 5,
  threshold = 0.6,
  statusFilter: string[] = ['approved', 'auto_approved']
): Array<LocalEvolvedSkillRow & { similarity: number }> {
  const placeholders = statusFilter.map(() => '?').join(',')
  const rows = getLocalDb().prepare(
    `SELECT * FROM evolved_skills WHERE status IN (${placeholders}) AND deleted_at IS NULL AND embedding_json IS NOT NULL`
  ).all(...statusFilter) as Record<string, unknown>[]

  return rows
    .map((r) => {
      const skill = rowToSkill(r)
      return { ...skill, similarity: cosineSimilarity(embedding, skill.embedding!) }
    })
    .filter((s) => s.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}

export function localGetEvolvedSkillStatsByAgent(agentId: string) {
  const rows = getLocalDb().prepare(
    'SELECT * FROM evolved_skills WHERE agent_id = ? AND deleted_at IS NULL'
  ).all(agentId) as Record<string, unknown>[]
  const skills = rows.map(rowToSkill)
  return {
    total: skills.length,
    approved: skills.filter((s) => s.status === 'approved').length,
    rejected: skills.filter((s) => s.status === 'rejected').length,
    pending: skills.filter((s) => s.status === 'pending_review').length,
    autoApproved: skills.filter((s) => s.status === 'auto_approved').length,
    totalReuse: skills.reduce((sum, s) => sum + s.use_count, 0),
    avgQuality: skills.length > 0 ? skills.reduce((sum, s) => sum + s.quality_score, 0) / skills.length : 0,
  }
}

export function localGetTopEvolvedSkills(agentId: string, limit = 5) {
  const rows = getLocalDb().prepare(`
    SELECT id, name, use_count, success_count FROM evolved_skills
    WHERE agent_id = ? AND deleted_at IS NULL AND status IN ('approved', 'auto_approved') AND use_count > 0
    ORDER BY use_count DESC LIMIT ?
  `).all(agentId, limit) as { id: string; name: string; use_count: number; success_count: number }[]
  return rows
}

export function localFindLowSuccessRateEvolvedSkills(maxSuccessRate: number, minUseCount: number): LocalEvolvedSkillRow[] {
  const rows = getLocalDb().prepare(`
    SELECT * FROM evolved_skills
    WHERE deleted_at IS NULL AND status IN ('approved', 'auto_approved')
      AND use_count >= ? AND use_count > 0
      AND CAST(success_count AS REAL) / use_count < ?
  `).all(minUseCount, maxSuccessRate) as Record<string, unknown>[]
  return rows.map(rowToSkill)
}

export function localFindStaleEvolvedSkills(staleDays: number): LocalEvolvedSkillRow[] {
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString()
  const rows = getLocalDb().prepare(`
    SELECT * FROM evolved_skills
    WHERE deleted_at IS NULL AND status IN ('approved', 'auto_approved')
      AND use_count = 0 AND created_at < ?
  `).all(cutoff) as Record<string, unknown>[]
  return rows.map(rowToSkill)
}

export function localFindEvolvedSkillsByIds(ids: string[]): LocalEvolvedSkillRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getLocalDb().prepare(
    `SELECT * FROM evolved_skills WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).all(...ids) as Record<string, unknown>[]
  return rows.map(rowToSkill)
}
