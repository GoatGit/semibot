/**
 * Studio SQLite 存储
 */

import { randomUUID } from 'crypto'
import { createLogger } from './logger'
import { getLocalDb } from './db-local'
import type { AgentNode, StudioEdge, StudioStatus, NodeResult } from '@semibot/shared-types'

const logger = createLogger('studio-local-store')

export interface LocalStudioRow {
  id: string
  name: string
  description: string | null
  nodes: AgentNode[]
  edges: StudioEdge[]
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

export interface LocalStudioRunRow {
  id: string
  studio_id: string
  status: StudioStatus
  inputs: Record<string, unknown>
  current_node_id: string | null
  node_results: Record<string, NodeResult>
  error: string | null
  created_at: string
  completed_at: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToStudio(row: Record<string, unknown>): LocalStudioRow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    nodes: JSON.parse((row.nodes_json as string) ?? '[]'),
    edges: JSON.parse((row.edges_json as string) ?? '[]'),
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

function rowToRun(row: Record<string, unknown>): LocalStudioRunRow {
  return {
    id: row.id as string,
    studio_id: row.studio_id as string,
    status: row.status as StudioStatus,
    inputs: JSON.parse((row.inputs_json as string) ?? '{}'),
    current_node_id: (row.current_node_id as string) ?? null,
    node_results: JSON.parse((row.node_results_json as string) ?? '{}'),
    error: (row.error as string) ?? null,
    created_at: row.created_at as string,
    completed_at: (row.completed_at as string) ?? null,
  }
}

// ─── Studio CRUD ──────────────────────────────────────────────

export interface CreateStudioData {
  name: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
}

export interface UpdateStudioData {
  name?: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
  isActive?: boolean
}

export function localCreateStudio(data: CreateStudioData): LocalStudioRow {
  const db = getLocalDb()
  const id = randomUUID()
  const now = nowIso()
  db.prepare(`
    INSERT INTO studios (id, name, description, nodes_json, edges_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    data.name,
    data.description ?? null,
    JSON.stringify(data.nodes ?? []),
    JSON.stringify(data.edges ?? []),
    now,
    now,
  )
  logger.info('Studio 已创建', { id, name: data.name })
  return localFindStudioById(id)!
}

export function localFindStudioById(id: string): LocalStudioRow | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM studios WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined
  return row ? rowToStudio(row) : null
}

export function localFindStudios(params: { page?: number; limit?: number; search?: string }): {
  data: LocalStudioRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
} {
  const db = getLocalDb()
  const page = Math.max(1, params.page ?? 1)
  const limit = Math.min(100, Math.max(1, params.limit ?? 20))
  const offset = (page - 1) * limit

  let where = 'WHERE deleted_at IS NULL'
  const args: unknown[] = []
  if (params.search) {
    where += ' AND (name LIKE ? OR description LIKE ?)'
    args.push(`%${params.search}%`, `%${params.search}%`)
  }

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM studios ${where}`).get(...args) as { cnt: number }).cnt
  const rows = db.prepare(`SELECT * FROM studios ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[]

  return {
    data: rows.map(rowToStudio),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

export function localUpdateStudio(id: string, data: UpdateStudioData): LocalStudioRow | null {
  const db = getLocalDb()
  const existing = localFindStudioById(id)
  if (!existing) return null

  const sets: string[] = ['updated_at = ?']
  const args: unknown[] = [nowIso()]

  if (data.name !== undefined) { sets.push('name = ?'); args.push(data.name) }
  if (data.description !== undefined) { sets.push('description = ?'); args.push(data.description) }
  if (data.nodes !== undefined) { sets.push('nodes_json = ?'); args.push(JSON.stringify(data.nodes)) }
  if (data.edges !== undefined) { sets.push('edges_json = ?'); args.push(JSON.stringify(data.edges)) }
  if (data.isActive !== undefined) { sets.push('is_active = ?'); args.push(data.isActive ? 1 : 0) }

  args.push(id)
  db.prepare(`UPDATE studios SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...args)
  return localFindStudioById(id)
}

export function localSoftDeleteStudio(id: string): boolean {
  const db = getLocalDb()
  const result = db.prepare('UPDATE studios SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(nowIso(), nowIso(), id)
  return (result.changes ?? 0) > 0
}

// ─── Studio Run CRUD ──────────────────────────────────────────

export function localCreateStudioRun(studioId: string, inputs: Record<string, unknown>): LocalStudioRunRow {
  const db = getLocalDb()
  const id = randomUUID()
  const now = nowIso()
  db.prepare(`
    INSERT INTO studio_runs (id, studio_id, status, inputs_json, node_results_json, created_at)
    VALUES (?, ?, 'pending', ?, '{}', ?)
  `).run(id, studioId, JSON.stringify(inputs), now)
  logger.info('StudioRun 已创建', { id, studioId })
  return localFindStudioRunById(id)!
}

export function localFindStudioRunById(id: string): LocalStudioRunRow | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM studio_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToRun(row) : null
}

export function localFindStudioRuns(studioId: string, params: { page?: number; limit?: number }): {
  data: LocalStudioRunRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
} {
  const db = getLocalDb()
  const page = Math.max(1, params.page ?? 1)
  const limit = Math.min(100, Math.max(1, params.limit ?? 20))
  const offset = (page - 1) * limit

  const total = (db.prepare('SELECT COUNT(*) as cnt FROM studio_runs WHERE studio_id = ?').get(studioId) as { cnt: number }).cnt
  const rows = db.prepare('SELECT * FROM studio_runs WHERE studio_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(studioId, limit, offset) as Record<string, unknown>[]

  return {
    data: rows.map(rowToRun),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

export function localUpdateStudioRunStatus(id: string, status: StudioStatus, error?: string): void {
  const db = getLocalDb()
  const completedAt = (status === 'completed' || status === 'failed' || status === 'cancelled') ? nowIso() : null
  db.prepare('UPDATE studio_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?').run(status, error ?? null, completedAt, id)
}

export function localUpdateStudioRunCurrentNode(id: string, nodeId: string): void {
  const db = getLocalDb()
  db.prepare('UPDATE studio_runs SET current_node_id = ?, status = ? WHERE id = ?').run(nodeId, 'running', id)
}

export function localSaveNodeResult(runId: string, nodeId: string, result: NodeResult): void {
  const db = getLocalDb()
  const run = localFindStudioRunById(runId)
  if (!run) return
  const nodeResults = { ...run.node_results, [nodeId]: result }
  db.prepare('UPDATE studio_runs SET node_results_json = ? WHERE id = ?').run(JSON.stringify(nodeResults), runId)
}
