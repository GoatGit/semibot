/**
 * MCP Server 服务层
 *
 * 使用数据库持久化实现 MCP Server CRUD
 */

import { createError } from '../middleware/errorHandler'
import {
  MCP_SERVER_NOT_FOUND,
  MCP_SERVER_LIMIT_EXCEEDED,
  MCP_CONNECTION_FAILED,
} from '../constants/errorCodes'
import * as mcpRepository from '../repositories/mcp.repository'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface McpServer {
  id: string
  orgId: string
  name: string
  description?: string
  endpoint: string
  transport: 'stdio' | 'http' | 'websocket'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
  tools: McpTool[]
  resources: McpResource[]
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastConnectedAt?: string
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface McpAuthConfig {
  apiKey?: string
  oauthClientId?: string
  oauthClientSecret?: string
  [key: string]: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface CreateMcpServerInput {
  name: string
  description?: string
  endpoint: string
  transport: 'stdio' | 'http' | 'websocket'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
}

export interface UpdateMcpServerInput {
  name?: string
  description?: string
  endpoint?: string
  transport?: 'stdio' | 'http' | 'websocket'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
  isActive?: boolean
}

export interface ListMcpServersOptions {
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
// 常量配置
// ═══════════════════════════════════════════════════════════════

const MAX_MCP_SERVERS_PER_ORG = 20

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 McpServer 对象
 */
function rowToMcpServer(row: mcpRepository.McpServerRow): McpServer {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    endpoint: row.endpoint,
    transport: row.transport as McpServer['transport'],
    authType: row.auth_type as McpServer['authType'],
    authConfig: row.auth_config as McpAuthConfig | undefined,
    tools: row.tools as McpTool[],
    resources: row.resources as McpResource[],
    status: row.status as McpServer['status'],
    lastConnectedAt: row.last_connected_at ?? undefined,
    isActive: row.is_active,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 MCP Server
 */
export async function createMcpServer(
  orgId: string,
  userId: string,
  input: CreateMcpServerInput
): Promise<McpServer> {
  // 检查配额
  const count = await mcpRepository.countByOrg(orgId)

  if (count >= MAX_MCP_SERVERS_PER_ORG) {
    console.warn(
      `[McpService] MCP Server 数量已达上限 - 组织: ${orgId}, 当前: ${count}, 限制: ${MAX_MCP_SERVERS_PER_ORG}`
    )
    throw createError(MCP_SERVER_LIMIT_EXCEEDED)
  }

  const row = await mcpRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    endpoint: input.endpoint,
    transport: input.transport,
    authType: input.authType,
    authConfig: input.authConfig,
    createdBy: userId,
  })

  return rowToMcpServer(row)
}

/**
 * 获取 MCP Server
 */
export async function getMcpServer(orgId: string, serverId: string): Promise<McpServer> {
  const row = await mcpRepository.findByIdAndOrg(serverId, orgId)

  if (!row) {
    throw createError(MCP_SERVER_NOT_FOUND)
  }

  return rowToMcpServer(row)
}

/**
 * 列出 MCP Servers
 */
export async function listMcpServers(
  orgId: string,
  options: ListMcpServersOptions = {}
): Promise<PaginatedResult<McpServer>> {
  const result = await mcpRepository.findAll({
    orgId,
    page: options.page,
    limit: options.limit,
    search: options.search,
    status: options.status,
  })

  return {
    data: result.data.map(rowToMcpServer),
    meta: result.meta,
  }
}

/**
 * 更新 MCP Server
 */
export async function updateMcpServer(
  orgId: string,
  serverId: string,
  input: UpdateMcpServerInput
): Promise<McpServer> {
  const row = await mcpRepository.update(serverId, orgId, {
    name: input.name,
    description: input.description,
    endpoint: input.endpoint,
    transport: input.transport,
    authType: input.authType,
    authConfig: input.authConfig,
    isActive: input.isActive,
  })

  if (!row) {
    throw createError(MCP_SERVER_NOT_FOUND)
  }

  return rowToMcpServer(row)
}

/**
 * 删除 MCP Server (软删除)
 */
export async function deleteMcpServer(orgId: string, serverId: string): Promise<void> {
  const deleted = await mcpRepository.softDelete(serverId, orgId)

  if (!deleted) {
    throw createError(MCP_SERVER_NOT_FOUND)
  }
}

/**
 * 测试 MCP Server 连接
 */
export async function testConnection(orgId: string, serverId: string): Promise<{ success: boolean; tools: McpTool[]; resources: McpResource[] }> {
  const server = await getMcpServer(orgId, serverId)

  try {
    // TODO: 实现实际的 MCP 连接测试
    // 这里是一个占位实现，实际应该使用 MCP SDK 进行连接测试

    // 模拟连接成功，更新状态
    await mcpRepository.update(serverId, orgId, {
      status: 'connected',
      lastConnectedAt: new Date().toISOString(),
    })

    return {
      success: true,
      tools: server.tools,
      resources: server.resources,
    }
  } catch (error) {
    // 更新状态为错误
    await mcpRepository.update(serverId, orgId, {
      status: 'error',
    })

    console.error(`[McpService] MCP Server 连接失败 - Server: ${serverId}, Error:`, error)
    throw createError(MCP_CONNECTION_FAILED)
  }
}

/**
 * 同步 MCP Server 的工具和资源
 */
export async function syncToolsAndResources(
  orgId: string,
  serverId: string,
  tools: McpTool[],
  resources: McpResource[]
): Promise<McpServer> {
  const row = await mcpRepository.update(serverId, orgId, {
    tools,
    resources,
  })

  if (!row) {
    throw createError(MCP_SERVER_NOT_FOUND)
  }

  return rowToMcpServer(row)
}
