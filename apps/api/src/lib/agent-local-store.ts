/**
 * Agent SQLite 存储
 */

import { randomUUID } from 'crypto'
import { createLogger } from './logger'
import { getLocalDb } from './db-local'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, SYSTEM_DEFAULT_AGENT_ID } from '../constants/config'

const logger = createLogger('agent-local-store')

export interface LocalAgentRow {
  id: string
  name: string
  description: string | null
  system_prompt: string
  config: Record<string, unknown>
  skills: string[]
  sub_agents: string[]
  version: number
  is_active: boolean
  is_public: boolean
  is_system: boolean
  default_vm_mode: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToAgent(row: Record<string, unknown>): LocalAgentRow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    system_prompt: (row.system_prompt as string) ?? '',
    config: JSON.parse((row.config_json as string) ?? '{}'),
    skills: JSON.parse((row.skills_json as string) ?? '[]'),
    sub_agents: JSON.parse((row.sub_agents_json as string) ?? '[]'),
    version: row.version as number,
    is_active: (row.is_active as number) === 1,
    is_public: (row.is_public as number) === 1,
    is_system: (row.is_system as number) === 1,
    default_vm_mode: (row.default_vm_mode as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

function buildSystemDefaultAgent(): LocalAgentRow {
  const now = nowIso()
  return {
    id: SYSTEM_DEFAULT_AGENT_ID,
    name: '系统助手',
    description: '系统默认 AI 助手，可使用所有系统预装能力',
    system_prompt: 'You are a helpful AI assistant with access to system tools and capabilities.',
    config: {
      model: '',
      modelProviderKey: '',
      temperature: 0.7,
      maxTokens: 4096,
      timeoutSeconds: 120,
      fallbackModel: '',
      fallbackProviderKey: '',
    },
    skills: [],
    sub_agents: [],
    version: 1,
    is_active: true,
    is_public: true,
    is_system: true,
    default_vm_mode: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    deleted_by: null,
  }
}

export function localCreateAgent(data: {
  name: string
  description?: string
  systemPrompt: string
  config: Record<string, unknown>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}): LocalAgentRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, config_json, skills_json, sub_agents_json,
      version, is_active, is_public, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?)
  `).run(
    id, data.name, data.description ?? null, data.systemPrompt,
    JSON.stringify(data.config), JSON.stringify(data.skills ?? []),
    JSON.stringify(data.subAgents ?? []),
    data.isPublic ? 1 : 0, now, now
  )
  logger.debug('创建 agent', { id })
  return rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindAgentById(id: string): LocalAgentRow | null {
  const row = getLocalDb().prepare('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToAgent(row as Record<string, unknown>) : null
}

export function localFindAgentByIdAndOrg(id: string): LocalAgentRow | null {
  return localFindAgentById(id)
}

export function localFindSystemDefaultAgent(): LocalAgentRow | null {
  const row = getLocalDb().prepare('SELECT * FROM agents WHERE is_system = 1 AND deleted_at IS NULL LIMIT 1').get()
  return row ? rowToAgent(row as Record<string, unknown>) : null
}

export function localEnsureSystemDefaultAgent(): LocalAgentRow {
  const db = getLocalDb()
  const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(SYSTEM_DEFAULT_AGENT_ID) as Record<string, unknown> | undefined
  const agent = buildSystemDefaultAgent()
  if (!existing) {
    db.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, config_json, skills_json, sub_agents_json,
        version, is_active, is_public, is_system, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)
    `).run(
      agent.id, agent.name, agent.description, agent.system_prompt,
      JSON.stringify(agent.config), JSON.stringify(agent.skills), JSON.stringify(agent.sub_agents),
      agent.created_at, agent.updated_at
    )
  } else {
    db.prepare(`
      UPDATE agents SET config_json = ?, is_system = 1, is_active = 1, is_public = 1,
        deleted_at = NULL, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(agent.config), nowIso(), SYSTEM_DEFAULT_AGENT_ID)
  }
  return rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(SYSTEM_DEFAULT_AGENT_ID) as Record<string, unknown>)
}

export function localFindAgentsByOrg(params: {
  page?: number
  limit?: number
  isActive?: boolean
  search?: string
} = {}): { data: LocalAgentRow[]; meta: { total: number; page: number; limit: number; totalPages: number } } {
  const db = getLocalDb()
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * limit

  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (params.isActive !== undefined) { where += ' AND is_active = ?'; binds.push(params.isActive ? 1 : 0) }
  if (params.search) {
    where += ' AND (name LIKE ? OR description LIKE ?)'
    binds.push(`%${params.search}%`, `%${params.search}%`)
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM agents ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM agents ${where} ORDER BY is_system DESC, updated_at DESC LIMIT ? OFFSET ?`).all(...binds, limit, offset)
  return {
    data: rows.map((r) => rowToAgent(r as Record<string, unknown>)),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export function localCountAgentsByOrg(): number {
  return ((getLocalDb().prepare('SELECT COUNT(*) as c FROM agents WHERE deleted_at IS NULL AND is_system = 0').get() as { c: number }).c)
}

export function localUpdateAgent(
  id: string,
  data: {
    name?: string
    description?: string
    systemPrompt?: string
    config?: Record<string, unknown>
    skills?: string[]
    subAgents?: string[]
    isActive?: boolean
    isPublic?: boolean
  },
  _updatedBy?: string,
  expectedVersion?: number
): LocalAgentRow | null {
  const db = getLocalDb()
  const existing = db.prepare('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined
  if (!existing) return null
  if ((existing.is_system as number) === 1) return null
  if (expectedVersion !== undefined && (existing.version as number) !== expectedVersion) return null

  const sets: string[] = ['version = version + 1', 'updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name) }
  if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description) }
  if (data.systemPrompt !== undefined) { sets.push('system_prompt = ?'); vals.push(data.systemPrompt) }
  if (data.config !== undefined) { sets.push('config_json = ?'); vals.push(JSON.stringify(data.config)) }
  if (data.skills !== undefined) { sets.push('skills_json = ?'); vals.push(JSON.stringify(data.skills)) }
  if (data.subAgents !== undefined) { sets.push('sub_agents_json = ?'); vals.push(JSON.stringify(data.subAgents)) }
  if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0) }
  if (data.isPublic !== undefined) { sets.push('is_public = ?'); vals.push(data.isPublic ? 1 : 0) }
  vals.push(id)

  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  return rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown>)
}

export function localFindOtherActiveAgentsByOrg(excludeAgentId: string, limit = 20): LocalAgentRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM agents WHERE id != ? AND is_active = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?'
  ).all(excludeAgentId, limit)
  return rows.map((r) => rowToAgent(r as Record<string, unknown>))
}

export function localSoftDeleteAgent(id: string, deletedBy?: string): boolean {
  const db = getLocalDb()
  const result = db.prepare(
    'UPDATE agents SET deleted_at = ?, deleted_by = ?, is_active = 0, updated_at = ? WHERE id = ? AND is_system = 0 AND deleted_at IS NULL'
  ).run(nowIso(), deletedBy ?? null, nowIso(), id)
  return (result.changes ?? 0) > 0
}
