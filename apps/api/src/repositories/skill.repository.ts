import { sql } from '../lib/db'
import { logPaginationLimit } from '../lib/logger'

export interface SkillRow {
  id: string
  org_id: string | null
  name: string
  description?: string | null
  trigger_keywords?: string[]
  tools?: unknown[]
  config?: Record<string, unknown>
  is_builtin?: boolean
  is_active?: boolean
  created_by?: string | null
  created_at?: string
  updated_at?: string
}

export interface CreateSkillData {
  orgId: string | null
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: unknown[]
  config?: Record<string, unknown>
  isBuiltin?: boolean
  isActive?: boolean
  createdBy?: string
}

export interface UpdateSkillData {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: unknown[]
  config?: Record<string, unknown>
  isActive?: boolean
}

export interface FindAllParams {
  orgId: string
  page?: number
  limit?: number
  search?: string
  includeBuiltin?: boolean
}

let hasDeletedAtColumn: boolean | null = null

async function supportsDeletedAt(): Promise<boolean> {
  if (hasDeletedAtColumn !== null) {
    return hasDeletedAtColumn
  }
  const rows = (await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'skills' AND column_name = 'deleted_at'
    LIMIT 1
  `) as Array<Record<string, unknown>>
  hasDeletedAtColumn = rows.length > 0
  return hasDeletedAtColumn
}

function normalizeLimit(limit?: number): number {
  const requested = Math.trunc(limit ?? 20) || 20
  const safe = Math.max(1, Math.min(100, requested))
  if (safe !== requested) {
    logPaginationLimit('skills', requested, safe, 100)
  }
  return safe
}

function normalizePage(page?: number): number {
  return Math.max(1, Math.trunc(page ?? 1) || 1)
}

export async function create(data: CreateSkillData): Promise<SkillRow> {
  const rows = (await sql`
    INSERT INTO skills (
      org_id, name, description, trigger_keywords, tools, config,
      is_builtin, is_active, created_by
    ) VALUES (
      ${data.orgId}, ${data.name}, ${data.description ?? null},
      ${sql.json(data.triggerKeywords ?? [])},
      ${sql.json(data.tools ?? [])},
      ${sql.json(data.config ?? {})},
      ${data.isBuiltin ?? false},
      ${data.isActive ?? true},
      ${data.createdBy ?? null}
    )
    RETURNING *
  `) as SkillRow[]
  return rows[0]
}

export async function findById(id: string): Promise<SkillRow | null> {
  const deletedClause = (await supportsDeletedAt()) ? sql`AND deleted_at IS NULL` : sql``
  const rows = (await sql`SELECT * FROM skills WHERE id = ${id} ${deletedClause} LIMIT 1`) as SkillRow[]
  return rows[0] ?? null
}

export async function findByIdAndOrg(id: string, orgId: string): Promise<SkillRow | null> {
  const rows = (await sql`
    SELECT *
    FROM skills
    WHERE id = ${id}
      AND ((org_id = ${orgId}) OR is_builtin = true)
      AND deleted_at IS NULL
    LIMIT 1
  `) as SkillRow[]
  return rows[0] ?? null
}

export async function findAll(params: FindAllParams): Promise<{
  data: SkillRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}> {
  const page = normalizePage(params.page)
  const limit = normalizeLimit(params.limit)
  const offset = (page - 1) * limit
  const searchClause = params.search ? sql`AND name ILIKE ${`%${params.search}%`}` : sql``
  const builtinClause = params.includeBuiltin ? sql`AND (org_id = ${params.orgId} OR is_builtin = true)` : sql`AND org_id = ${params.orgId}`
  const countRows = (await sql`
    SELECT COUNT(*) as total
    FROM skills
    WHERE deleted_at IS NULL
      ${builtinClause}
      ${searchClause}
  `) as Array<{ total: string | number }>
  const data = (await sql`
    SELECT *
    FROM skills
    WHERE deleted_at IS NULL
      ${builtinClause}
      ${searchClause}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as SkillRow[]
  const total = Number(countRows[0]?.total ?? 0)
  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  }
}

export async function update(id: string, data: UpdateSkillData): Promise<SkillRow | null> {
  const existing = await findById(id)
  if (!existing) {
    return null
  }
  const rows = (await sql`
    UPDATE skills
    SET
      name = ${data.name ?? existing.name},
      description = ${data.description ?? existing.description ?? null},
      trigger_keywords = ${sql.json(data.triggerKeywords ?? existing.trigger_keywords ?? [])},
      tools = ${sql.json(data.tools ?? existing.tools ?? [])},
      config = ${sql.json(data.config ?? existing.config ?? {})},
      is_active = ${data.isActive ?? existing.is_active ?? true},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
    RETURNING *
  `) as SkillRow[]
  return rows[0] ?? null
}

export async function softDelete(id: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE skills
    SET deleted_at = CURRENT_TIMESTAMP, is_active = false
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>
  return rows.length > 0
}
