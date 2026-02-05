/**
 * Agent 服务层
 */

import { v4 as uuidv4 } from 'uuid'
import { createError } from '../middleware/errorHandler.js'
import {
  AGENT_NOT_FOUND,
  AGENT_INACTIVE,
  AGENT_LIMIT_EXCEEDED,
} from '../constants/errorCodes.js'
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../constants/config.js'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Agent {
  id: string
  orgId: string
  name: string
  description?: string
  systemPrompt: string
  config: AgentConfig
  skills: string[]
  subAgents: string[]
  version: number
  isActive: boolean
  isPublic: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  model: string
  temperature: number
  maxTokens: number
  timeoutSeconds: number
  retryAttempts?: number
  fallbackModel?: string
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt: string
  config?: Partial<AgentConfig>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}

export interface UpdateAgentInput {
  name?: string
  description?: string
  systemPrompt?: string
  config?: Partial<AgentConfig>
  skills?: string[]
  subAgents?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface ListAgentsOptions {
  page?: number
  limit?: number
  isActive?: boolean
  search?: string
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
// 模拟数据存储 (开发用，生产环境使用数据库)
// ═══════════════════════════════════════════════════════════════

const agentsStore = new Map<string, Agent>()

// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'gpt-4o',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutSeconds: 120,
  retryAttempts: 3,
  fallbackModel: 'gpt-4o-mini',
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Agent
 */
export async function createAgent(orgId: string, input: CreateAgentInput): Promise<Agent> {
  // 检查配额 (模拟)
  const orgAgents = Array.from(agentsStore.values()).filter((a) => a.orgId === orgId)
  const maxAgents = 100 // 从组织配额获取

  if (orgAgents.length >= maxAgents) {
    console.warn(
      `[AgentService] Agent 数量已达上限 - 组织: ${orgId}, 当前: ${orgAgents.length}, 限制: ${maxAgents}`
    )
    throw createError(AGENT_LIMIT_EXCEEDED)
  }

  const now = new Date().toISOString()
  const agent: Agent = {
    id: uuidv4(),
    orgId,
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    config: { ...DEFAULT_AGENT_CONFIG, ...input.config },
    skills: input.skills ?? [],
    subAgents: input.subAgents ?? [],
    version: 1,
    isActive: true,
    isPublic: input.isPublic ?? false,
    createdAt: now,
    updatedAt: now,
  }

  agentsStore.set(agent.id, agent)

  return agent
}

/**
 * 获取 Agent
 */
export async function getAgent(orgId: string, agentId: string): Promise<Agent> {
  const agent = agentsStore.get(agentId)

  if (!agent || agent.orgId !== orgId) {
    throw createError(AGENT_NOT_FOUND)
  }

  return agent
}

/**
 * 获取 Agent (允许公开访问)
 */
export async function getAgentPublic(agentId: string): Promise<Agent> {
  const agent = agentsStore.get(agentId)

  if (!agent) {
    throw createError(AGENT_NOT_FOUND)
  }

  if (!agent.isPublic && !agent.isActive) {
    throw createError(AGENT_NOT_FOUND)
  }

  return agent
}

/**
 * 列出 Agents
 */
export async function listAgents(
  orgId: string,
  options: ListAgentsOptions = {}
): Promise<PaginatedResult<Agent>> {
  const {
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
    isActive,
    search,
  } = options

  // 限制分页大小
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  if (limit > MAX_PAGE_SIZE) {
    console.warn(
      `[AgentService] 分页大小超出限制，已截断 - 请求: ${limit}, 限制: ${MAX_PAGE_SIZE}`
    )
  }

  let agents = Array.from(agentsStore.values()).filter((a) => a.orgId === orgId)

  // 筛选活跃状态
  if (isActive !== undefined) {
    agents = agents.filter((a) => a.isActive === isActive)
  }

  // 搜索
  if (search) {
    const searchLower = search.toLowerCase()
    agents = agents.filter(
      (a) =>
        a.name.toLowerCase().includes(searchLower) ||
        a.description?.toLowerCase().includes(searchLower)
    )
  }

  // 排序 (按更新时间倒序)
  agents.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  // 分页
  const total = agents.length
  const totalPages = Math.ceil(total / actualLimit)
  const offset = (page - 1) * actualLimit
  const data = agents.slice(offset, offset + actualLimit)

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages,
    },
  }
}

/**
 * 更新 Agent
 */
export async function updateAgent(
  orgId: string,
  agentId: string,
  input: UpdateAgentInput
): Promise<Agent> {
  const agent = await getAgent(orgId, agentId)

  const updatedAgent: Agent = {
    ...agent,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
    ...(input.config !== undefined && { config: { ...agent.config, ...input.config } }),
    ...(input.skills !== undefined && { skills: input.skills }),
    ...(input.subAgents !== undefined && { subAgents: input.subAgents }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
    ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
    version: agent.version + 1,
    updatedAt: new Date().toISOString(),
  }

  agentsStore.set(agentId, updatedAgent)

  return updatedAgent
}

/**
 * 删除 Agent (软删除)
 */
export async function deleteAgent(orgId: string, agentId: string): Promise<void> {
  const agent = await getAgent(orgId, agentId)

  // 软删除 - 标记为不活跃
  agentsStore.set(agentId, {
    ...agent,
    isActive: false,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * 验证 Agent 可用性 (用于会话创建)
 */
export async function validateAgentForSession(
  orgId: string,
  agentId: string
): Promise<Agent> {
  const agent = await getAgent(orgId, agentId)

  if (!agent.isActive) {
    throw createError(AGENT_INACTIVE)
  }

  return agent
}
