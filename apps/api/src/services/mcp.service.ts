/**
 * MCP Server 服务层
 *
 * 使用数据库持久化实现 MCP Server CRUD
 */

import { spawn } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createError } from '../middleware/errorHandler'
import {
  MCP_SERVER_NOT_FOUND,
  MCP_SERVER_LIMIT_EXCEEDED,
  MCP_CONNECTION_FAILED,
} from '../constants/errorCodes'
import { MCP_CONNECTION_TIMEOUT_MS, MAX_MCP_SERVERS_PER_ORG } from '../constants/config'
import * as mcpRepository from '../repositories/mcp.repository'
import { mcpLogger } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface McpServer {
  id: string
  orgId: string | null
  name: string
  description?: string
  endpoint: string
  transport: 'stdio' | 'sse' | 'streamable_http'
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
  transport: 'stdio' | 'sse' | 'streamable_http'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
}

export interface UpdateMcpServerInput {
  name?: string
  description?: string
  endpoint?: string
  transport?: 'stdio' | 'sse' | 'streamable_http'
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
    authConfig: (typeof row.auth_config === 'string' ? JSON.parse(row.auth_config) : row.auth_config) as McpAuthConfig | undefined,
    tools: (typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools) as McpTool[],
    resources: (typeof row.resources === 'string' ? JSON.parse(row.resources) : row.resources) as McpResource[],
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
 * 设置 stdio 子进程的事件处理器并发送初始化请求
 */
function setupStdioHandlers(
  child: ReturnType<typeof spawn>,
  resolve: (value: { tools: McpTool[]; resources: McpResource[] }) => void,
  reject: (reason: Error) => void
): void {
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

  child.stdout!.on('data', (data: Buffer) => {
    stdout += data.toString()

    const lines = stdout.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const response = JSON.parse(line)

        if (response.id === 1 && response.result) {
          initializeDone = true
          child.stdin!.write(MCP_LIST_TOOLS_REQUEST + '\n')
          child.stdin!.write(MCP_LIST_RESOURCES_REQUEST + '\n')
        } else if (response.id === 2 && response.result?.tools) {
          toolsReceived = true
          for (const tool of response.result.tools) {
            tools.push({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })
          }
        } else if (response.id === 3) {
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

        if (initializeDone && toolsReceived && resourcesReceived) {
          clearTimeout(timeout)
          child.kill()
          resolve({ tools, resources })
        }
      } catch {
        // 不是有效的 JSON，忽略
      }
    }
    stdout = lines[lines.length - 1]
  })

  child.stderr!.on('data', (data: Buffer) => {
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

  child.stdin!.write(MCP_INITIALIZE_REQUEST + '\n')
}

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
    const trimmed = endpoint.trim()

    // 防御：用户误将 URL 填入 stdio 类型
    if (/^https?:\/\//i.test(trimmed)) {
      reject(new Error('endpoint 是一个 URL，请将传输类型改为 http'))
      return
    }

    // 防御：用户误将 JSON 配置粘贴到 endpoint
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        // 尝试从 JSON 中提取 command/args
        const mcpConfig = parsed.mcpServers
          ? Object.values(parsed.mcpServers)[0] as { command?: string; args?: string[] }
          : parsed as { command?: string; args?: string[] }
        if (mcpConfig?.command) {
          const command = mcpConfig.command
          const args = mcpConfig.args || []
          // 继续使用提取出的 command 和 args（跳过下面的 split 逻辑）
          const env = { ...process.env }
          if (authConfig?.apiKey) {
            env.MCP_API_KEY = authConfig.apiKey
          }
          const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
          })
          return setupStdioHandlers(child, resolve, reject)
        }
      } catch {
        // JSON 解析失败，给出明确提示
      }
      reject(new Error('endpoint 格式错误：检测到 JSON 内容。stdio 类型的 endpoint 应为可执行命令，如 "npx -y @modelcontextprotocol/server-filesystem"'))
      return
    }

    const parts = trimmed.split(' ')
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

    setupStdioHandlers(child, resolve, reject)
  })
}

/**
 * 使用 MCP SDK 连接服务器并获取工具和资源列表
 */
async function connectWithSdk(
  transport: Transport,
  label: string
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  const client = new Client({ name: 'semibot', version: '1.0.0' })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label}连接超时`)), MCP_CONNECTION_TIMEOUT_MS)
  })

  try {
    await Promise.race([client.connect(transport), timeoutPromise])
    mcpLogger.info(`${label}连接成功`)

    const [toolsResult, resourcesResult] = await Promise.race([
      Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
      ]),
      timeoutPromise,
    ])

    const tools: McpTool[] = (toolsResult.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }))

    const resources: McpResource[] = (resourcesResult.resources || []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }))

    return { tools, resources }
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * 构建认证请求头
 */
function buildAuthHeaders(authConfig?: McpAuthConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (authConfig?.apiKey) {
    headers['Authorization'] = `Bearer ${authConfig.apiKey}`
  }
  return headers
}

/**
 * 测试 SSE 类型的 MCP Server 连接（使用 MCP SDK）
 */
async function testSseConnection(
  endpoint: string,
  authConfig?: McpAuthConfig
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  mcpLogger.info('使用 SSE 传输连接', { endpoint })
  const headers = buildAuthHeaders(authConfig)
  const transport = new SSEClientTransport(new URL(endpoint), {
    eventSourceInit: {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        fetch(url, { ...init, headers: { ...init?.headers, ...headers } }),
    },
    requestInit: { headers },
  })
  return connectWithSdk(transport, 'SSE')
}

/**
 * 测试 HTTP (Streamable HTTP) 类型的 MCP Server 连接（使用 MCP SDK）
 */
async function testHttpConnection(
  endpoint: string,
  authConfig?: McpAuthConfig
): Promise<{ tools: McpTool[]; resources: McpResource[] }> {
  // 检测 SSE 端点，自动切换到 SSE 模式
  if (endpoint.endsWith('/sse') || endpoint.endsWith('/sse/')) {
    mcpLogger.info('检测到 SSE 端点，切换到 SSE 模式', { endpoint })
    return testSseConnection(endpoint, authConfig)
  }

  mcpLogger.info('使用 Streamable HTTP 传输连接', { endpoint })
  const headers = buildAuthHeaders(authConfig)
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers },
  })

  try {
    return await connectWithSdk(transport, 'HTTP')
  } catch (error) {
    // Streamable HTTP 失败时，尝试回退到 SSE（某些旧服务器只支持 SSE）
    const errMsg = error instanceof Error ? error.message : String(error)
    mcpLogger.info('Streamable HTTP 连接失败，尝试回退到 SSE', { error: errMsg })

    // 尝试将 endpoint 转换为 SSE 端点
    const sseEndpoint = endpoint.endsWith('/') ? `${endpoint}sse` : `${endpoint}/sse`
    try {
      return await testSseConnection(sseEndpoint, authConfig)
    } catch {
      // SSE 回退也失败，抛出原始错误
      throw error
    }
  }
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
      case 'sse':
        result = await testSseConnection(server.endpoint, server.authConfig)
        break
      case 'streamable_http':
        result = await testHttpConnection(server.endpoint, server.authConfig)
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

// ═══════════════════════════════════════════════════════════════
// Agent-MCP 集成
// ═══════════════════════════════════════════════════════════════

export interface McpToolForLLM {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  _mcpMeta: {
    serverId: string
    serverName: string
    originalToolName: string
  }
}

/**
 * 获取 Agent 关联的 MCP 工具（转换为 LLM function calling 格式）
 * 使用数据库中缓存的工具列表，不实时连接 MCP Server
 */
export async function getMcpToolsForAgent(agentId: string): Promise<McpToolForLLM[]> {
  const servers = await mcpRepository.findByAgentId(agentId)

  const tools: McpToolForLLM[] = []

  for (const server of servers) {
    const serverTools: McpTool[] = parseJsonField(server.tools) || []
    const enabledTools: string[] = parseJsonField(server.enabled_tools) || []

    for (const tool of serverTools) {
      // 如果设置了 enabled_tools 过滤，只包含启用的工具
      if (enabledTools.length > 0 && !enabledTools.includes(tool.name)) {
        continue
      }

      // 工具名加上服务器前缀避免冲突: mcp_serverName__toolName
      const prefixedName = `mcp_${server.name}__${tool.name}`

      tools.push({
        type: 'function',
        function: {
          name: prefixedName,
          description: tool.description || '',
          parameters: tool.inputSchema || {},
        },
        _mcpMeta: {
          serverId: server.id,
          serverName: server.name,
          originalToolName: tool.name,
        },
      })
    }
  }

  mcpLogger.info('加载 Agent MCP 工具', {
    agentId,
    serverCount: servers.length,
    toolCount: tools.length,
  })

  return tools
}

/**
 * 调用 MCP 工具（实时连接 MCP Server 执行）
 */
export async function callMcpTool(
  serverId: string,
  orgId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const server = await getMcpServer(orgId, serverId)

  mcpLogger.info('调用 MCP 工具', { serverId, toolName, serverName: server.name })

  const headers = buildAuthHeaders(server.authConfig)

  let transport: Transport

  switch (server.transport) {
    case 'stdio': {
      const parts = server.endpoint.split(/\s+/)
      const command = parts[0]
      const cmdArgs = parts.slice(1)
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      transport = new StdioClientTransport({ command, args: cmdArgs })
      break
    }
    case 'sse':
      transport = new SSEClientTransport(new URL(server.endpoint), {
        eventSourceInit: { fetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init as RequestInit, headers: { ...(init as RequestInit)?.headers, ...headers } }) },
        requestInit: { headers },
      })
      break
    case 'streamable_http':
      transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
        requestInit: { headers },
      })
      break
    default:
      throw new Error(`不支持的传输类型: ${server.transport}`)
  }

  const client = new Client({ name: 'semibot', version: '1.0.0' })

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MCP 工具调用超时')), MCP_CONNECTION_TIMEOUT_MS)
    })

    await Promise.race([client.connect(transport), timeoutPromise])

    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: args }),
      timeoutPromise,
    ])

    mcpLogger.info('MCP 工具调用成功', { serverId, toolName })

    return result
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * 获取 Agent 关联的 MCP Server ID 列表
 */
export async function getAgentMcpServerIds(agentId: string): Promise<string[]> {
  return mcpRepository.getAgentMcpServerIds(agentId)
}

/**
 * 设置 Agent 关联的 MCP Servers
 */
export async function setAgentMcpServers(agentId: string, mcpServerIds: string[]): Promise<void> {
  return mcpRepository.setAgentMcpServers(agentId, mcpServerIds)
}

/**
 * 获取 Agent 关联的 MCP Servers（转换为 Runtime McpServerDefinition 格式）
 */
export async function getMcpServersForRuntime(agentId: string): Promise<Array<{
  id: string
  name: string
  endpoint: string
  transport: string
  is_connected: boolean
  available_tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}>> {
  const servers = await mcpRepository.findByAgentId(agentId)

  return servers.map((server) => {
    const serverTools: McpTool[] = parseJsonField(server.tools) || []
    const enabledTools: string[] = parseJsonField(server.enabled_tools) || []

    const filteredTools = serverTools
      .filter((tool) => enabledTools.length === 0 || enabledTools.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || {},
      }))

    return {
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      transport: server.transport,
      is_connected: true,
      auth_config: parseJsonField(server.auth_config) || null,
      available_tools: filteredTools,
    }
  })
}

function parseJsonField(value: unknown): any {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return null
}

/**
 * 获取系统预装 MCP Servers（Runtime 格式）
 * 用于合并到所有 Agent 的能力列表中
 */
export async function getSystemMcpServersForRuntime(): Promise<Array<{
  id: string
  name: string
  endpoint: string
  transport: string
  is_connected: boolean
  auth_config: McpAuthConfig | null
  available_tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}>> {
  const servers = await mcpRepository.findSystemMcpServers()

  return servers.map((server) => {
    const serverTools: McpTool[] = parseJsonField(server.tools) || []

    return {
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      transport: server.transport,
      is_connected: true,
      auth_config: parseJsonField(server.auth_config) || null,
      available_tools: serverTools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || {},
      })),
    }
  })
}
