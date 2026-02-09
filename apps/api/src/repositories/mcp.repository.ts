/**
 * MCP Server Repository
 *
 * 处理 MCP Server 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface McpServerRow {
  id: string
  org_id: string
  name: string
  description: string | null
  endpoint: string
  transport: string
  auth_type: string | null
  auth_config: Record<string, unknown> | null
  tools: unknown[]
  resources: unknown[]
  status: string
  last_connected_at: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateMcpServerData {
  orgId: string
  name: string
  description?: string
  endpoint: string
  transport: string
  authType?: string
  authConfig?: Record<string, unknown>
  tools?: unknown[]
  resources?: unknown[]
  createdBy?: string
}

export interface UpdateMcpServerData {
  name?: string
  description?: string
  endpoint?: string
  transport?: string
  authType?: string
  authConfig?: Record<string, unknown>
  tools?: unknown[]
  resources?: unknown[]
  status?: string
  lastConnectedAt?: string
  isActive?: boolean
}

export interface ListMcpServersParams {
  orgId: string
  page?: number
  limit?: number
  search?: string
  status?: string
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

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 MCP Server
 */
export async function create(data: CreateMcpServerData): Promise<McpServerRow> {
  const result = await sql`
    INSERT INTO mcp_servers (
      org_id, name, description, endpoint, transport,
      auth_type, auth_config, tools, resources, created_by
    )
    VALUES (
      ${data.orgId},
      ${data.name},
      ${data.description ?? null},
      ${data.endpoint},
      ${data.transport},
      ${data.authType ?? null},
      ${data.authConfig ? JSON.stringify(data.authConfig) : null},
      ${JSON.stringify(data.tools ?? [])},
      ${JSON.stringify(data.resources ?? [])},
      ${data.createdBy ?? null}
    )
    RETURNING *
  `

  return result[0] as unknown as McpServerRow
}

/**
 * 根据 ID 获取 MCP Server
 */
export async function findById(id: string): Promise<McpServerRow | null> {
  const result = await sql`
    SELECT * FROM mcp_servers WHERE id = ${id} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as McpServerRow
}

/**
 * 根据 ID 和组织 ID 获取 MCP Server
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<McpServerRow | null> {
  const result = await sql`
    SELECT * FROM mcp_servers WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as McpServerRow
}

/**
 * 列出 MCP Servers（分页）
 */
export async function findAll(params: ListMcpServersParams): Promise<PaginatedResult<McpServerRow>> {
  const { orgId, page = 1, limit = DEFAULT_PAGE_SIZE, search, status } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 记录分页限制日志
  logPaginationLimit('McpRepository', limit, actualLimit, MAX_PAGE_SIZE)

  // 构建 WHERE 条件
  let whereClause = sql`org_id = ${orgId} AND is_active = true`

  if (search) {
    const searchPattern = `%${search}%`
    whereClause = sql`${whereClause} AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})`
  }

  if (status) {
    whereClause = sql`${whereClause} AND status = ${status}`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM mcp_servers WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM mcp_servers
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as McpServerRow[]

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

/**
 * 统计组织的 MCP Server 数量
 */
export async function countByOrg(orgId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM mcp_servers WHERE org_id = ${orgId} AND is_active = true
  `
  return parseInt((result[0] as { count: string }).count, 10)
}

/**
 * 更新 MCP Server
 */
export async function update(id: string, orgId: string, data: UpdateMcpServerData): Promise<McpServerRow | null> {
  const server = await findByIdAndOrg(id, orgId)
  if (!server) return null

  const authConfig = data.authConfig ? JSON.stringify(data.authConfig) : (server.auth_config ? JSON.stringify(server.auth_config) : null)
  const tools = data.tools ? JSON.stringify(data.tools) : JSON.stringify(server.tools)
  const resources = data.resources ? JSON.stringify(data.resources) : JSON.stringify(server.resources)

  const result = await sql`
    UPDATE mcp_servers
    SET name = ${data.name ?? server.name},
        description = ${data.description ?? server.description},
        endpoint = ${data.endpoint ?? server.endpoint},
        transport = ${data.transport ?? server.transport},
        auth_type = ${data.authType ?? server.auth_type},
        auth_config = ${authConfig},
        tools = ${tools},
        resources = ${resources},
        status = ${data.status ?? server.status},
        last_connected_at = ${data.lastConnectedAt ?? server.last_connected_at},
        is_active = ${data.isActive ?? server.is_active},
        updated_at = NOW()
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as McpServerRow
}

/**
 * 软删除 MCP Server
 */
export async function softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const result = await sql`
    UPDATE mcp_servers
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        is_active = false,
        updated_at = NOW()
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}
