/**
 * Tool Repository (runtime-backed)
 *
 * V2 single-machine mode:
 * - Tool config is persisted by runtime in ~/.semibot/semibot.db
 * - API repository proxies CRUD to runtime /v1/config/tools
 */

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit, createLogger } from '../lib/logger'
import { runtimeRequest } from '../lib/runtime-client'

const toolLogger = createLogger('tool-repository')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ToolRow {
  id: string
  org_id: string | null
  name: string
  description: string | null
  type: string
  schema: Record<string, unknown>
  config: Record<string, unknown>
  is_builtin: boolean
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateToolData {
  orgId: string | null
  name: string
  description?: string
  type: string
  schema?: Record<string, unknown>
  config?: Record<string, unknown>
  isBuiltin?: boolean
  createdBy?: string
}

export interface UpdateToolData {
  name?: string
  description?: string
  type?: string
  schema?: Record<string, unknown>
  config?: Record<string, unknown>
  isActive?: boolean
}

export interface ListToolsParams {
  orgId?: string | null
  includeBuiltin?: boolean
  page?: number
  limit?: number
  search?: string
  type?: string
}

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

type RuntimeToolRecord = {
  id: string
  org_id?: string | null
  name: string
  description?: string | null
  type?: string
  schema?: Record<string, unknown>
  config?: Record<string, unknown>
  is_builtin?: boolean
  is_active?: boolean
  created_by?: string | null
  created_at?: string
  updated_at?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function toToolRow(item: RuntimeToolRecord): ToolRow {
  return {
    id: item.id,
    org_id: item.org_id ?? null,
    name: item.name,
    description: item.description ?? null,
    type: item.type ?? 'builtin',
    schema: item.schema ?? {},
    config: item.config ?? {},
    is_builtin: Boolean(item.is_builtin),
    is_active: item.is_active !== false,
    created_by: item.created_by ?? null,
    created_at: item.created_at ?? nowIso(),
    updated_at: item.updated_at ?? nowIso(),
  }
}

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Tool
 */
export async function create(data: CreateToolData): Promise<ToolRow> {
  const item = await runtimeRequest<RuntimeToolRecord>('/v1/config/tools', {
    method: 'POST',
    body: {
      org_id: data.orgId,
      name: data.name,
      description: data.description,
      type: data.type,
      schema: data.schema ?? {},
      config: data.config ?? {},
      is_builtin: data.isBuiltin ?? false,
      is_active: true,
      created_by: data.createdBy ?? null,
    },
    timeoutMs: 2500,
  })

  return toToolRow(item)
}

/**
 * 根据 ID 获取 Tool
 */
export async function findById(id: string): Promise<ToolRow | null> {
  try {
    const item = await runtimeRequest<RuntimeToolRecord>(`/v1/config/tools/${id}`, {
      method: 'GET',
      timeoutMs: 1800,
    })
    return toToolRow(item)
  } catch {
    return null
  }
}

/**
 * 根据 ID 和组织 ID 获取 Tool（支持内置工具跨组织访问）
 */
export async function findByIdAndOrg(id: string, _orgId: string): Promise<ToolRow | null> {
  return findById(id)
}

/**
 * 根据名称和组织获取 Tool（支持内置工具跨组织访问）
 */
export async function findByNameAndOrg(name: string, _orgId: string): Promise<ToolRow | null> {
  try {
    const item = await runtimeRequest<RuntimeToolRecord>(`/v1/config/tools/by-name/${encodeURIComponent(name)}`, {
      method: 'GET',
      timeoutMs: 1800,
    })
    return toToolRow(item)
  } catch {
    return null
  }
}

/**
 * 列出 Tools（分页）
 */
export async function findAll(params: ListToolsParams): Promise<PaginatedResult<ToolRow>> {
  const { includeBuiltin = true, page = 1, limit = DEFAULT_PAGE_SIZE, search, type } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)

  logPaginationLimit('ToolRepository', limit, actualLimit, MAX_PAGE_SIZE)

  const result = await runtimeRequest<{
    data: RuntimeToolRecord[]
    meta: { total: number; page: number; limit: number; totalPages: number }
  }>('/v1/config/tools', {
    method: 'GET',
    query: {
      includeBuiltin,
      page,
      limit: actualLimit,
      search,
      type,
    },
    timeoutMs: 2500,
  })

  return {
    data: (result.data || []).map(toToolRow),
    meta: {
      total: result.meta?.total ?? 0,
      page: result.meta?.page ?? page,
      limit: result.meta?.limit ?? actualLimit,
      totalPages: result.meta?.totalPages ?? 1,
    },
  }
}

/**
 * 更新 Tool（带审计字段和租户隔离）
 */
export async function updateByOrg(
  id: string,
  orgId: string,
  data: UpdateToolData,
  updatedBy?: string
): Promise<ToolRow | null> {
  const tool = await findByIdAndOrg(id, orgId)
  if (!tool) return null

  if (tool.is_builtin) {
    toolLogger.warn('[Security] 尝试修改内置 Tool', { id, orgId })
    return null
  }

  return update(id, data, updatedBy)
}

/**
 * 更新 Tool（带审计字段）
 */
export async function update(id: string, data: UpdateToolData, updatedBy?: string): Promise<ToolRow | null> {
  const existing = await findById(id)
  if (!existing) {
    return null
  }

  try {
    const item = await runtimeRequest<RuntimeToolRecord>(`/v1/config/tools/${id}`, {
      method: 'PUT',
      body: {
        name: data.name,
        description: data.description,
        type: data.type,
        schema: data.schema,
        config: data.config,
        is_active: data.isActive,
        updated_by: updatedBy,
      },
      timeoutMs: 2500,
    })
    return toToolRow(item)
  } catch {
    return null
  }
}

/**
 * 软删除 Tool
 */
export async function softDelete(id: string): Promise<boolean> {
  try {
    const result = await runtimeRequest<{ deleted?: boolean }>(`/v1/config/tools/${id}`, {
      method: 'DELETE',
      timeoutMs: 2000,
    })
    return result.deleted === true
  } catch {
    return false
  }
}
