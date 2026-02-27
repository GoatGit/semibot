/**
 * MCP Server Repository (runtime-backed)
 *
 * V2 single-machine mode:
 * - MCP server data is persisted by runtime in ~/.semibot/semibot.db
 * - API repository proxies CRUD to runtime /v1/config/mcp
 */

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'
import { runtimeRequest } from '../lib/runtime-client'

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

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

type RuntimeMcpRecord = {
  id: string
  org_id?: string | null
  name: string
  description?: string | null
  endpoint: string
  transport: string
  auth_type?: string | null
  auth_config?: Record<string, unknown> | null
  tools?: unknown[]
  resources?: unknown[]
  status?: string
  last_connected_at?: string | null
  is_active?: boolean
  is_system?: boolean
  created_by?: string | null
  created_at?: string
  updated_at?: string
  enabled_tools?: string[]
  enabled_resources?: string[]
}

export class McpRepositoryImpl {
  async findByIdAndOrg(id: string, orgId: string): Promise<McpServerRow | null> {
    return findByIdAndOrg(id, orgId)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function toMcpRow(item: RuntimeMcpRecord): McpServerRow {
  return {
    id: item.id,
    org_id: item.org_id ?? null,
    name: item.name,
    description: item.description ?? null,
    endpoint: item.endpoint,
    transport: item.transport,
    auth_type: item.auth_type ?? null,
    auth_config: item.auth_config ?? null,
    tools: item.tools ?? [],
    resources: item.resources ?? [],
    status: item.status ?? 'disconnected',
    last_connected_at: item.last_connected_at ?? null,
    is_active: item.is_active !== false,
    is_system: Boolean(item.is_system),
    created_by: item.created_by ?? null,
    created_at: item.created_at ?? nowIso(),
    updated_at: item.updated_at ?? nowIso(),
  }
}

/**
 * 创建 MCP Server
 */
export async function create(data: CreateMcpServerData): Promise<McpServerRow> {
  const item = await runtimeRequest<RuntimeMcpRecord>('/v1/config/mcp', {
    method: 'POST',
    body: {
      org_id: data.orgId,
      name: data.name,
      description: data.description,
      endpoint: data.endpoint,
      transport: data.transport,
      auth_type: data.authType,
      auth_config: data.authConfig,
      tools: data.tools ?? [],
      resources: data.resources ?? [],
      created_by: data.createdBy,
      is_system: data.isSystem ?? false,
      is_active: true,
    },
    timeoutMs: 3000,
  })

  return toMcpRow(item)
}

/**
 * 根据 ID 获取 MCP Server
 */
export async function findById(id: string): Promise<McpServerRow | null> {
  try {
    const item = await runtimeRequest<RuntimeMcpRecord>(`/v1/config/mcp/${id}`, {
      method: 'GET',
      timeoutMs: 2000,
    })
    return toMcpRow(item)
  } catch {
    return null
  }
}

/**
 * 根据 ID 和组织 ID 获取 MCP Server（系统 MCP 对所有 org 可见）
 */
export async function findByIdAndOrg(id: string, _orgId: string): Promise<McpServerRow | null> {
  return findById(id)
}

/**
 * 获取所有系统级 MCP Servers
 */
export async function findSystemMcpServers(): Promise<McpServerRow[]> {
  const response = await runtimeRequest<{ data: RuntimeMcpRecord[] }>('/v1/config/mcp/system', {
    method: 'GET',
    timeoutMs: 2500,
  })

  return (response.data || []).map(toMcpRow)
}

/**
 * 获取组织下所有活跃的 MCP Servers（用于系统 Agent 自动继承）
 */
export async function findActiveByOrg(_orgId: string): Promise<McpServerRow[]> {
  const response = await runtimeRequest<{ data: RuntimeMcpRecord[] }>('/v1/config/mcp/active', {
    method: 'GET',
    timeoutMs: 2500,
  })

  return (response.data || []).map(toMcpRow).filter((row) => !row.is_system)
}

/**
 * 列出 MCP Servers（分页）
 */
export async function findAll(params: ListMcpServersParams): Promise<PaginatedResult<McpServerRow>> {
  const { page = 1, limit = DEFAULT_PAGE_SIZE, search, status } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)

  logPaginationLimit('McpRepository', limit, actualLimit, MAX_PAGE_SIZE)

  const result = await runtimeRequest<{
    data: RuntimeMcpRecord[]
    meta: { total: number; page: number; limit: number; totalPages: number }
  }>('/v1/config/mcp', {
    method: 'GET',
    query: {
      page,
      limit: actualLimit,
      search,
      status,
    },
    timeoutMs: 3000,
  })

  return {
    data: (result.data || []).map(toMcpRow),
    meta: {
      total: result.meta?.total ?? 0,
      page: result.meta?.page ?? page,
      limit: result.meta?.limit ?? actualLimit,
      totalPages: result.meta?.totalPages ?? 1,
    },
  }
}

/**
 * 统计组织的 MCP Server 数量
 */
export async function countByOrg(_orgId: string): Promise<number> {
  const response = await runtimeRequest<{ data: RuntimeMcpRecord[] }>('/v1/config/mcp/active', {
    method: 'GET',
    timeoutMs: 2500,
  })

  const rows = (response.data || []).map(toMcpRow)
  return rows.filter((row) => row.is_active && !row.is_system).length
}

/**
 * 更新 MCP Server
 */
export async function update(id: string, _orgId: string, data: UpdateMcpServerData): Promise<McpServerRow | null> {
  try {
    const item = await runtimeRequest<RuntimeMcpRecord>(`/v1/config/mcp/${id}`, {
      method: 'PUT',
      body: {
        name: data.name,
        description: data.description,
        endpoint: data.endpoint,
        transport: data.transport,
        auth_type: data.authType,
        auth_config: data.authConfig,
        tools: data.tools,
        resources: data.resources,
        status: data.status,
        last_connected_at: data.lastConnectedAt,
        is_active: data.isActive,
      },
      timeoutMs: 3000,
    })
    return toMcpRow(item)
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════
// Agent-MCP 关联查询
// ═══════════════════════════════════════════════════════════════

/**
 * 查询 Agent 关联的 MCP Servers（含服务器详情）
 */
export async function findByAgentId(agentId: string): Promise<(McpServerRow & { enabled_tools: string[]; enabled_resources: string[] })[]> {
  const response = await runtimeRequest<{ data: RuntimeMcpRecord[] }>(`/v1/config/mcp/agent/${encodeURIComponent(agentId)}`, {
    method: 'GET',
    timeoutMs: 3000,
  })

  return (response.data || []).map((item) => ({
    ...toMcpRow(item),
    enabled_tools: Array.isArray(item.enabled_tools) ? item.enabled_tools : [],
    enabled_resources: Array.isArray(item.enabled_resources) ? item.enabled_resources : [],
  }))
}

/**
 * 设置 Agent 关联的 MCP Servers（全量替换）
 */
export async function setAgentMcpServers(
  agentId: string,
  mcpServerIds: string[]
): Promise<void> {
  await runtimeRequest(`/v1/config/mcp/agent/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    body: {
      mcp_server_ids: mcpServerIds,
    },
    timeoutMs: 3000,
  })
}

/**
 * 获取 Agent 关联的 MCP Server ID 列表
 */
export async function getAgentMcpServerIds(agentId: string): Promise<string[]> {
  const response = await runtimeRequest<{ data: string[] }>(`/v1/config/mcp/agent/${encodeURIComponent(agentId)}/ids`, {
    method: 'GET',
    timeoutMs: 2500,
  })
  return Array.isArray(response.data) ? response.data : []
}

// ═══════════════════════════════════════════════════════════════
// 软删除
// ═══════════════════════════════════════════════════════════════

export async function softDelete(id: string, _orgId: string, _deletedBy?: string): Promise<boolean> {
  try {
    const response = await runtimeRequest<{ deleted?: boolean }>(`/v1/config/mcp/${id}`, {
      method: 'DELETE',
      timeoutMs: 2500,
    })
    return response.deleted === true
  } catch {
    return false
  }
}
