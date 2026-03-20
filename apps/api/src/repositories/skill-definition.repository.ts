/**
 * Skill Definition Repository — 本地文件存储代理
 */

import * as local from '../lib/skill-local-store'

export interface SkillDefinitionRow {
  id: string
  skill_id: string
  name: string
  description: string | null
  trigger_keywords: string[]
  is_active: boolean
  is_public: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateSkillDefinitionData {
  skillId: string
  name: string
  description?: string
  protocol?: string
  sourceType?: string
  sourceUrl?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
  status?: string
  createdBy?: string
}

export interface UpdateSkillDefinitionData {
  name?: string
  description?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface SkillDefinition {
  id: string
  skillId: string
  name: string
  description?: string
  triggerKeywords: string[]
  isActive: boolean
  isPublic: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

function rowToSkillDefinition(row: local.LocalSkillDefinitionRow): SkillDefinition {
  return {
    id: row.id,
    skillId: row.skill_id,
    name: row.name,
    description: row.description || undefined,
    triggerKeywords: row.trigger_keywords,
    isActive: row.is_active,
    isPublic: row.is_public,
    createdBy: row.created_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function create(data: CreateSkillDefinitionData): Promise<SkillDefinition> {
  const row = await local.localCreateSkillDefinition(data)
  return rowToSkillDefinition(row)
}

export async function findById(id: string): Promise<SkillDefinition | null> {
  const row = await local.localFindSkillDefinitionById(id)
  return row ? rowToSkillDefinition(row) : null
}

export async function findBySkillId(skillId: string): Promise<SkillDefinition | null> {
  const row = await local.localFindSkillDefinitionBySkillId(skillId)
  return row ? rowToSkillDefinition(row) : null
}

export async function findAll(options: {
  page?: number
  pageSize?: number
  isActive?: boolean
  isPublic?: boolean
  search?: string
}): Promise<{ data: SkillDefinition[]; total: number; page: number; pageSize: number }> {
  const result = await local.localFindAllSkillDefinitions(options)
  return { ...result, data: result.data.map(rowToSkillDefinition) }
}

export async function update(id: string, data: UpdateSkillDefinitionData): Promise<SkillDefinition | null> {
  const row = await local.localUpdateSkillDefinition(id, data)
  return row ? rowToSkillDefinition(row) : null
}

export async function softDelete(id: string): Promise<boolean> {
  return local.localSoftDeleteSkillDefinition(id)
}

export async function remove(id: string): Promise<boolean> {
  return local.localRemoveSkillDefinition(id)
}

export async function existsBySkillId(skillId: string): Promise<boolean> {
  return local.localSkillDefinitionExistsBySkillId(skillId)
}

export async function count(options?: { isActive?: boolean; isPublic?: boolean }): Promise<number> {
  return local.localCountSkillDefinitions(options)
}
