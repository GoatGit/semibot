/**
 * MCP Server 服务层
 *
 * 使用数据库持久化实现 MCP Server CRUD
 */

import { spawn } from 'child_process'
import { createError } from '../middleware/errorHandler'
import {
  MCP_SERVER_NOT_FOUND,
  MCP_SERVER_LIMIT_EXCEEDED,
  MCP_CONNECTION_FAILED,
} from '../constants/errorCodes'
import { MCP_CONNECTION_TIMEOUT_MS } from '../constants/config'
import * as mcpRepository from '../repositories/mcp.repository'
import { mcpLogger } from '../lib/logger'

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
    mcpLogger.warn('MCP Server 数量已达上限', {
      orgId,
      current: count,
      limit: MAX_MCP_SERVERS_PER_ORG,
    })
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

// ═══════════════════════════════════════════════════════════════
// MCP 连接测试辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * MCP 初始化请求消息
 */
const MCP_INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'semibot',
      version: '1.0.0',
    },
  },
})

/**
 * MCP 列出工具请求消息
 */
const MCP_LIST_TOOLS_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
})

/**
 * MCP 列出资源请求消息
 */
const MCP_LIST_RESOURCES_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  method: 'resources/list',
  params: {},
})

/**
 * 测试 stdio 类型的 MCP Server 连接
 *
 * @param endpoint - 可执行文件路径 (如: npx -y @modelcontextprotocol/server-filesystem)
 * @param authConfig - 认证配置
 * @returns 连接测试结果
 */
async function testStdioConnection(
  endpoint: string,
  authConfig?: McpAuthConfig
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  return new Promise((resolve, reject) => {
    const parts = endpoint.split(' ')
    const command = parts[0]
    const args = parts.slice(1)

    // 设置环境变量
    const env = { ...process.env }
    if (authConfig?.apiKey) {
      env.MCP_API_KEY = authConfig.apiKey
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    let stdout = ''
    let stderr = ''
    let initializeDone = false
    let toolsReceived = false
    let resourcesReceived = false
    const tools: McpTool[] = []
    const resources: McpResource[] = []

    const timeout = setTimeout(() => {
      child.kill()
      mcpLogger.warn('stdio 连接超时', { timeoutMs: MCP_CONNECTION_TIMEOUT_MS })
      reject(new Error('连接超时'))
    }, MCP_CONNECTION_TIMEOUT_MS)

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()

      // 解析 JSON-RPC 响应
      const lines = stdout.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line)

          if (response.id === 1 && response.result) {
            // 初始化成功
            initializeDone = true
            // 发送列出工具请求
            child.stdin.write(MCP_LIST_TOOLS_REQUEST + '\n')
            // 发送列出资源请求
            child.stdin.write(MCP_LIST_RESOURCES_REQUEST + '\n')
          } else if (response.id === 2 && response.result?.tools) {
            // 工具列表
            toolsReceived = true
            for (const tool of response.result.tools) {
              tools.push({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })
            }
          } else if (response.id === 3) {
            // 资源列表 (可能为空)
            resourcesReceived = true
            if (response.result?.resources) {
              for (const resource of response.result.resources) {
                resources.push({
                  uri: resource.uri,
                  name: resource.name,
                  description: resource.description,
                  mimeType: resource.mimeType,
                })
              }
            }
          }

          // 所有请求都完成后关闭
          if (initializeDone && toolsReceived && resourcesReceived) {
            clearTimeout(timeout)
            child.kill()
            resolve({ tools, resources })
          }
        } catch {
          // 不是有效的 JSON，忽略
        }
      }
      // 保留未完成的行
      stdout = lines[lines.length - 1]
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      mcpLogger.error('stdio 进程错误', error)
      reject(new Error(`进程启动失败: ${error.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (!initializeDone) {
        mcpLogger.error('stdio 进程退出，未完成初始化', undefined, { stderr, code })
        reject(new Error(`进程异常退出 (code: ${code})`))
      }
    })

    // 发送初始化请求
    child.stdin.write(MCP_INITIALIZE_REQUEST + '\n')
  })
}

/**
 * 测试 HTTP/SSE 类型的 MCP Server 连接
 *
 * @param endpoint - HTTP 端点 URL
 * @param authConfig - 认证配置
 * @returns 连接测试结果
 */
async function testHttpConnection(
  endpoint: string,
  authConfig?: McpAuthConfig
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (authConfig?.apiKey) {
    headers['Authorization'] = `Bearer ${authConfig.apiKey}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MCP_CONNECTION_TIMEOUT_MS)

  try {
    // 发送初始化请求
    const initResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: MCP_INITIALIZE_REQUEST,
      signal: controller.signal,
    })

    if (!initResponse.ok) {
      throw new Error(`HTTP ${initResponse.status}: ${initResponse.statusText}`)
    }

    const initResult = await initResponse.json() as { error?: { message: string }; result?: unknown }
    if (initResult.error) {
      throw new Error(`MCP 初始化失败: ${initResult.error.message}`)
    }

    // 获取工具列表
    const toolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: MCP_LIST_TOOLS_REQUEST,
      signal: controller.signal,
    })

    const toolsResult = await toolsResponse.json() as { result?: { tools?: Record<string, unknown>[] } }
    const tools: McpTool[] = (toolsResult.result?.tools || []).map((tool: Record<string, unknown>) => ({
      name: tool.name as string,
      description: tool.description as string | undefined,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }))

    // 获取资源列表
    const resourcesResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: MCP_LIST_RESOURCES_REQUEST,
      signal: controller.signal,
    })

    const resourcesResult = await resourcesResponse.json() as { result?: { resources?: Record<string, unknown>[] } }
    const resources: McpResource[] = (resourcesResult.result?.resources || []).map((resource: Record<string, unknown>) => ({
      uri: resource.uri as string,
      name: resource.name as string,
      description: resource.description as string | undefined,
      mimeType: resource.mimeType as string | undefined,
    }))

    clearTimeout(timeout)
    return { tools, resources }
  } catch (error) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      mcpLogger.warn('HTTP 连接超时', { timeoutMs: MCP_CONNECTION_TIMEOUT_MS })
      throw new Error('连接超时')
    }
    throw error
  }
}

/**
 * 测试 WebSocket 类型的 MCP Server 连接
 *
 * @param endpoint - WebSocket 端点 URL
 * @param authConfig - 认证配置
 * @returns 连接测试结果
 */
async function testWebSocketConnection(
  endpoint: string,
  authConfig?: McpAuthConfig
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  // WebSocket 实现需要 ws 库，这里使用简化的 HTTP 回退
  // 大多数 MCP Server 同时支持 HTTP 和 WebSocket
  const httpEndpoint = endpoint.replace(/^ws/, 'http')
  mcpLogger.info('WebSocket 端点回退到 HTTP', { httpEndpoint })
  return testHttpConnection(httpEndpoint, authConfig)
}

/**
 * 测试 MCP Server 连接
 */
export async function testConnection(
  orgId: string,
  serverId: string
): Promise<{ success: boolean; tools: McpTool[]; resources: McpResource[]; message?: string }> {
  const server = await getMcpServer(orgId, serverId)

  // 更新状态为连接中
  await mcpRepository.update(serverId, orgId, {
    status: 'connecting',
  })

  try {
    let result: { tools: McpTool[]; resources: McpResource[] }

    switch (server.transport) {
      case 'stdio':
        result = await testStdioConnection(server.endpoint, server.authConfig)
        break
      case 'http':
        result = await testHttpConnection(server.endpoint, server.authConfig)
        break
      case 'websocket':
        result = await testWebSocketConnection(server.endpoint, server.authConfig)
        break
      default:
        throw new Error(`不支持的传输类型: ${server.transport}`)
    }

    // 更新状态为已连接，同步工具和资源
    await mcpRepository.update(serverId, orgId, {
      status: 'connected',
      lastConnectedAt: new Date().toISOString(),
      tools: result.tools,
      resources: result.resources,
    })

    mcpLogger.info('MCP Server 连接成功', {
      serverId,
      toolsCount: result.tools.length,
      resourcesCount: result.resources.length,
    })

    return {
      success: true,
      tools: result.tools,
      resources: result.resources,
      message: '连接成功',
    }
  } catch (error) {
    // 更新状态为错误
    await mcpRepository.update(serverId, orgId, {
      status: 'error',
    })

    const errorMessage = error instanceof Error ? error.message : '未知错误'
    mcpLogger.error('MCP Server 连接失败', error as Error, { serverId })

    throw createError(MCP_CONNECTION_FAILED, errorMessage)
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
