/**
 * Evolved Skill Repository — SQLite 代理
 */

import * as local from '../lib/evolved-skill-local-store'

export type { LocalEvolvedSkillRow as EvolvedSkillRow } from '../lib/evolved-skill-local-store'

export interface CreateEvolvedSkillData {
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
}

export interface ListEvolvedSkillsParams {
  status?: string
  agentId?: string
  page?: number
  limit?: number
}

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface EvolvedSkillWithScore extends local.LocalEvolvedSkillRow {
  similarity: number
}

export async function create(data: CreateEvolvedSkillData): Promise<local.LocalEvolvedSkillRow> {
  return local.localCreateEvolvedSkill(data)
}

export async function findById(id: string): Promise<local.LocalEvolvedSkillRow | null> {
  return local.localFindEvolvedSkillById(id)
}

export async function findByIdAndOrg(id: string): Promise<local.LocalEvolvedSkillRow | null> {
  return local.localFindEvolvedSkillByIdAndOrg(id)
}

export async function findByOrg(params: ListEvolvedSkillsParams): Promise<PaginatedResult<local.LocalEvolvedSkillRow>> {
  return local.localFindEvolvedSkillsByOrg(params)
}

export async function update(id: string, data: {
  status?: string
  reviewedBy?: string
  reviewedAt?: string
  reviewComment?: string
}): Promise<local.LocalEvolvedSkillRow | null> {
  return local.localUpdateEvolvedSkill(id, data)
}

export async function updateStatus(id: string, status: string): Promise<boolean> {
  return local.localUpdateEvolvedSkillStatus(id, status)
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  return local.localSoftDeleteEvolvedSkill(id, deletedBy)
}

export async function incrementUseCount(id: string): Promise<void> {
  return local.localIncrementEvolvedSkillUseCount(id)
}

export async function incrementSuccessCount(id: string): Promise<void> {
  return local.localIncrementEvolvedSkillSuccessCount(id)
}

export async function updateEmbedding(id: string, embedding: number[]): Promise<void> {
  return local.localUpdateEvolvedSkillEmbedding(id, embedding)
}

export async function findByEmbedding(
  embedding: number[],
  limit = 5,
  threshold = 0.6,
  statusFilter: string[] = ['approved', 'auto_approved']
): Promise<EvolvedSkillWithScore[]> {
  return local.localFindEvolvedSkillsByEmbedding(embedding, limit, threshold, statusFilter)
}

export async function getStatsByAgent(agentId: string) {
  return local.localGetEvolvedSkillStatsByAgent(agentId)
}

export async function getTopSkills(agentId: string, limit = 5) {
  return local.localGetTopEvolvedSkills(agentId, limit)
}

export async function findLowSuccessRate(maxSuccessRate: number, minUseCount: number) {
  return local.localFindLowSuccessRateEvolvedSkills(maxSuccessRate, minUseCount)
}

export async function findStaleSkills(staleDays: number) {
  return local.localFindStaleEvolvedSkills(staleDays)
}

export async function findByIds(ids: string[]) {
  return local.localFindEvolvedSkillsByIds(ids)
}
