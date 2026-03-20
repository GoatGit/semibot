/**
 * Agent Repository — SQLite 代理
 */

import * as local from '../lib/agent-local-store'

export type { LocalAgentRow as AgentRow } from '../lib/agent-local-store'

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface CreateAgentData {
  name: string
  description?: string
  systemPrompt: string
  config: Record<string, unknown>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}

export interface UpdateAgentData {
  name?: string
  description?: string
  systemPrompt?: string
  config?: Record<string, unknown>
  skills?: string[]
  subAgents?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface ListAgentsParams {
  page?: number
  limit?: number
  isActive?: boolean
  search?: string
}

export async function create(data: CreateAgentData): Promise<local.LocalAgentRow> {
  return local.localCreateAgent(data)
}

export async function findById(id: string): Promise<local.LocalAgentRow | null> {
  return local.localFindAgentById(id)
}

export async function findSystemDefault(): Promise<local.LocalAgentRow | null> {
  return local.localFindSystemDefaultAgent()
}

export async function ensureSystemDefault(): Promise<local.LocalAgentRow> {
  return local.localEnsureSystemDefaultAgent()
}

export async function findByIdAndOrg(id: string): Promise<local.LocalAgentRow | null> {
  return local.localFindAgentByIdAndOrg(id)
}

export async function findByOrg(params: ListAgentsParams): Promise<PaginatedResult<local.LocalAgentRow>> {
  return local.localFindAgentsByOrg(params)
}

export async function countByOrg(): Promise<number> {
  return local.localCountAgentsByOrg()
}

export async function update(
  id: string,
  data: UpdateAgentData,
  updatedBy?: string,
  expectedVersion?: number
): Promise<local.LocalAgentRow | null> {
  return local.localUpdateAgent(id, data, updatedBy, expectedVersion)
}

export async function findOtherActiveByOrg(excludeAgentId: string, limit = 20): Promise<local.LocalAgentRow[]> {
  return local.localFindOtherActiveAgentsByOrg(excludeAgentId, limit)
}

export async function softDelete(id: string, deletedBy?: string): Promise<boolean> {
  return local.localSoftDeleteAgent(id, deletedBy)
}
