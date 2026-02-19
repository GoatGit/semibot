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
  org_id: string | null
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
  is_system: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateMcpServerData {
  orgId: string | null
  name: string
  description?: string
  endpoint: string
  transport: string
  authType?: string
  authConfig?: Record<string, unknown>
  tools?: unknown[]
  resources?: unknown[]
  createdBy?: string
  isSystem?: boolean
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
      auth_type, auth_config, tools, resources, created_by, is_system
    )
    VALUES (
      ${data.orgId ?? null},
      ${data.name},
      ${data.description ?? null},
      ${data.endpoint},
      ${data.transport},
      ${data.authType ?? null},
      ${data.authConfig ? sql.json(data.authConfig as any) : null},
      ${sql.json((data.tools ?? []) as any)},
      ${sql.json((data.resources ?? []) as any)},
      ${data.createdBy ?? null},
      ${data.isSystem ?? false}
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
 * 根据 ID 和组织 ID 获取 MCP Server（系统 MCP 对所有 org 可见）
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<McpServerRow | null> {
  const result = await sql`
    SELECT * FROM mcp_servers WHERE id = ${id} AND (org_id = ${orgId} OR is_system = true) AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as McpServerRow
}

/**
 * 获取所有系统级 MCP Servers
 */
export async function findSystemMcpServers(): Promise<McpServerRow[]> {
  const result = await sql`
    SELECT * FROM mcp_servers
    WHERE is_system = true AND is_active = true AND deleted_at IS NULL
    ORDER BY name
  `

  return result as unknown as McpServerRow[]
}

/**
 * 获取组织下所有活跃的 MCP Servers（用于系统 Agent 自动继承）
 */
export async function findActiveByOrg(orgId: string): Promise<McpServerRow[]> {
  const result = await sql`
    SELECT * FROM mcp_servers
    WHERE org_id = ${orgId} AND is_active = true AND deleted_at IS NULL
    ORDER BY name
  `

  return result as unknown as McpServerRow[]
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
  let whereClause = sql`(org_id = ${orgId} OR is_system = true) AND is_active = true AND deleted_at IS NULL`

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
    SELECT COUNT(*) as count FROM mcp_servers WHERE org_id = ${orgId} AND is_active = true AND deleted_at IS NULL
  `
  return parseInt((result[0] as { count: string }).count, 10)
}

/**
 * 更新 MCP Server
 */
export async function update(id: string, orgId: string, data: UpdateMcpServerData): Promise<McpServerRow | null> {
  const server = await findByIdAndOrg(id, orgId)
  if (!server) return null

  const authConfigRaw = data.authConfig ?? (typeof server.auth_config === 'string' ? JSON.parse(server.auth_config) : server.auth_config) ?? null
  const authConfig = authConfigRaw ? sql.json(authConfigRaw) : null
  const toolsRaw = data.tools ?? (Array.isArray(server.tools) ? server.tools : typeof server.tools === 'string' ? JSON.parse(server.tools) : [])
  const tools = sql.json(toolsRaw)
  const resourcesRaw = data.resources ?? (Array.isArray(server.resources) ? server.resources : typeof server.resources === 'string' ? JSON.parse(server.resources) : [])
  const resources = sql.json(resourcesRaw)

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
    WHERE id = ${id} AND ${server.is_system ? sql`is_system = true` : sql`org_id = ${orgId}`}
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
// ═══════════════════════════════════════════════════════════════
// Agent-MCP 关联查询
// ═══════════════════════════════════════════════════════════════

export interface AgentMcpServerRow {
  id: string
  agent_id: string
  mcp_server_id: string
  enabled_tools: string[]
  enabled_resources: string[]
  is_active: boolean
  created_at: string
  updated_at: string
}

/**
 * 查询 Agent 关联的 MCP Servers（含服务器详情）
 */
export async function findByAgentId(agentId: string): Promise<(McpServerRow & { enabled_tools: string[]; enabled_resources: string[] })[]> {
  const result = await sql`
    SELECT ms.*, ams.enabled_tools, ams.enabled_resources
    FROM agent_mcp_servers ams
    JOIN mcp_servers ms ON ms.id = ams.mcp_server_id
    WHERE ams.agent_id = ${agentId}
      AND ams.is_active = true
      AND ms.is_active = true
      AND ms.deleted_at IS NULL
    ORDER BY ms.name
  `

  return result as unknown as (McpServerRow & { enabled_tools: string[]; enabled_resources: string[] })[]
}

/**
 * 设置 Agent 关联的 MCP Servers（全量替换）
 */
export async function setAgentMcpServers(
  agentId: string,
  mcpServerIds: string[]
): Promise<void> {
  // 先删除旧关联
  await sql`
    DELETE FROM agent_mcp_servers WHERE agent_id = ${agentId}
  `

  // 插入新关联
  if (mcpServerIds.length > 0) {
    const values = mcpServerIds.map((serverId) => ({
      agent_id: agentId,
      mcp_server_id: serverId,
      is_active: true,
    }))

    await sql`
      INSERT INTO agent_mcp_servers ${sql(values, 'agent_id', 'mcp_server_id', 'is_active')}
    `
  }
}

/**
 * 获取 Agent 关联的 MCP Server ID 列表
 */
export async function getAgentMcpServerIds(agentId: string): Promise<string[]> {
  const result = await sql`
    SELECT mcp_server_id FROM agent_mcp_servers
    WHERE agent_id = ${agentId} AND is_active = true
  `

  return result.map((row) => (row as Record<string, string>).mcp_server_id)
}

// ═══════════════════════════════════════════════════════════════
// 软删除
// ═══════════════════════════════════════════════════════════════

export async function softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const server = await findByIdAndOrg(id, orgId)
  if (!server) return false

  const result = await sql`
    UPDATE mcp_servers
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        is_active = false,
        updated_at = NOW()
    WHERE id = ${id} AND ${server.is_system ? sql`is_system = true` : sql`org_id = ${orgId}`} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}
