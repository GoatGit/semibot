/**
 * Agent 服务层
 *
 * 使用数据库持久化实现 Agent CRUD
 */

import { createError } from '../middleware/errorHandler'
import {
  AGENT_NOT_FOUND,
  AGENT_INACTIVE,
  AGENT_LIMIT_EXCEEDED,
  LLM_UNAVAILABLE,
} from '../constants/errorCodes'
import { MAX_AGENTS_PER_ORG } from '../constants/config'
import * as agentRepository from '../repositories/agent.repository'
import { getAvailableModels } from './llm.service'
import * as mcpService from './mcp.service'
import { buildSkillIndex } from './skill-prompt-builder'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import { createLogger } from '../lib/logger'

const agentLogger = createLogger('agent')

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
// 默认配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutSeconds: 120,
  retryAttempts: 3,
  fallbackModel: process.env.FALLBACK_LLM_MODEL ?? 'gpt-4o-mini',
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Agent 对象
 */
function rowToAgent(row: agentRepository.AgentRow): Agent {
  // 防御性解析：config 可能因 JSON.stringify + postgres.js 双重序列化而变成字符串
  const rawConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
  const config = (rawConfig ?? {}) as Record<string, unknown>

  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    systemPrompt: row.system_prompt,
    config: {
      model: (config.model as string) ?? DEFAULT_AGENT_CONFIG.model,
      temperature: (config.temperature as number) ?? DEFAULT_AGENT_CONFIG.temperature,
      maxTokens: (config.maxTokens as number) ?? DEFAULT_AGENT_CONFIG.maxTokens,
      timeoutSeconds: (config.timeoutSeconds as number) ?? DEFAULT_AGENT_CONFIG.timeoutSeconds,
      retryAttempts: config.retryAttempts as number | undefined,
      fallbackModel: config.fallbackModel as string | undefined,
    },
    skills: row.skills ?? [],
    subAgents: row.sub_agents ?? [],
    version: row.version,
    isActive: row.is_active,
    isPublic: row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Agent
 */
export async function createAgent(orgId: string, input: CreateAgentInput): Promise<Agent> {
  // 检查配额
  const count = await agentRepository.countByOrg(orgId)

  if (count >= MAX_AGENTS_PER_ORG) {
    agentLogger.warn('Agent 数量已达上限', { orgId, current: count, limit: MAX_AGENTS_PER_ORG })
    throw createError(AGENT_LIMIT_EXCEEDED)
  }

  const availableModels = await getAvailableModels().catch(() => [] as string[])
  if (availableModels.length === 0) {
    agentLogger.error('创建 Agent 失败：当前无可用模型', undefined, { orgId })
    throw createError(LLM_UNAVAILABLE, '当前没有可用模型，无法创建 Agent')
  }

  if (input.config?.model && !availableModels.includes(input.config.model)) {
    throw createError(
      LLM_UNAVAILABLE,
      `模型 ${input.config.model} 当前不可用，请选择可用模型`
    )
  }

  const primaryModel = input.config?.model || availableModels[0] || DEFAULT_AGENT_CONFIG.model
  const fallbackModel =
    input.config?.fallbackModel ||
    availableModels.find((model) => model !== primaryModel) ||
    DEFAULT_AGENT_CONFIG.fallbackModel

  const config = {
    ...DEFAULT_AGENT_CONFIG,
    ...input.config,
    model: primaryModel,
    fallbackModel,
  }
  const systemPrompt = input.systemPrompt?.trim() || 'You are a helpful AI assistant.'

  const row = await agentRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    systemPrompt,
    config,
    skills: input.skills,
    subAgents: input.subAgents,
    isPublic: input.isPublic,
  })

  return rowToAgent(row)
}

/**
 * 获取 Agent
 */
export async function getAgent(orgId: string, agentId: string): Promise<Agent> {
  const row = await agentRepository.findByIdAndOrg(agentId, orgId)

  if (!row) {
    throw createError(AGENT_NOT_FOUND)
  }

  return rowToAgent(row)
}

/**
 * 获取 Agent (允许公开访问)
 */
export async function getAgentPublic(agentId: string): Promise<Agent> {
  const row = await agentRepository.findById(agentId)

  if (!row) {
    throw createError(AGENT_NOT_FOUND)
  }

  if (!row.is_public && !row.is_active) {
    throw createError(AGENT_NOT_FOUND)
  }

  return rowToAgent(row)
}

/**
 * 列出 Agents
 */
export async function listAgents(
  orgId: string,
  options: ListAgentsOptions = {}
): Promise<PaginatedResult<Agent>> {
  const result = await agentRepository.findByOrg({
    orgId,
    page: options.page,
    limit: options.limit,
    isActive: options.isActive,
    search: options.search,
  })

  return {
    data: result.data.map(rowToAgent),
    meta: result.meta,
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
  // 先获取现有 Agent
  const existing = await getAgent(orgId, agentId)

  // 合并配置
  const config = input.config
    ? { ...existing.config, ...input.config }
    : undefined

  const row = await agentRepository.update(agentId, orgId, {
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    config,
    skills: input.skills,
    subAgents: input.subAgents,
    isActive: input.isActive,
    isPublic: input.isPublic,
  })

  if (!row) {
    throw createError(AGENT_NOT_FOUND)
  }

  return rowToAgent(row)
}

/**
 * 删除 Agent (软删除)
 */
export async function deleteAgent(orgId: string, agentId: string): Promise<void> {
  const deleted = await agentRepository.softDelete(agentId, orgId)

  if (!deleted) {
    throw createError(AGENT_NOT_FOUND)
  }
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

// ═══════════════════════════════════════════════════════════════
// SubAgent 委派候选池
// ═══════════════════════════════════════════════════════════════

export interface SubAgentConfigForRuntime {
  id: string
  name: string
  description: string
  system_prompt: string
  model?: string
  temperature: number
  max_tokens: number
  skills: string[]
  mcp_servers: Array<{
    id: string
    name: string
    endpoint: string
    transport: string
    is_connected: boolean
    available_tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  }>
}

/**
 * 获取同组织下其他活跃 Agent 作为委派候选池
 * 为每个候选 Agent 加载其独立的 Skills 和 MCP Servers
 */
export async function getCandidateSubAgents(
  orgId: string,
  currentAgentId: string
): Promise<SubAgentConfigForRuntime[]> {
  const candidates = await agentRepository.findOtherActiveByOrg(orgId, currentAgentId)
  const results: SubAgentConfigForRuntime[] = []

  for (const row of candidates) {
    const a = rowToAgent(row)

    // 加载候选 Agent 自己的 Skill 索引（注入 system_prompt）
    let systemPrompt = a.systemPrompt || `你是 ${a.name}，一个有帮助的 AI 助手。`
    if (a.skills && a.skills.length > 0) {
      try {
        const skillPairs: Array<{ definition: skillDefinitionRepo.SkillDefinition; package: skillPackageRepo.SkillPackage }> = []
        for (const skillDefId of a.skills) {
          const def = await skillDefinitionRepo.findById(skillDefId)
          if (!def || !def.isActive) continue
          const pkg = await skillPackageRepo.findByDefinition(skillDefId)
          if (!pkg) continue
          skillPairs.push({ definition: def, package: pkg })
        }
        if (skillPairs.length > 0) {
          const skillIndexXml = await buildSkillIndex(skillPairs)
          if (skillIndexXml) {
            systemPrompt += '\n\n' + skillIndexXml
          }
        }
      } catch (err) {
        agentLogger.warn('加载候选 Agent Skills 失败', {
          agentId: a.id, error: (err as Error).message,
        })
      }
    }

    // 加载候选 Agent 自己的 MCP Servers
    let mcpServers: SubAgentConfigForRuntime['mcp_servers'] = []
    try {
      mcpServers = await mcpService.getMcpServersForRuntime(a.id)
    } catch (err) {
      agentLogger.warn('加载候选 Agent MCP Servers 失败', {
        agentId: a.id, error: (err as Error).message,
      })
    }

    results.push({
      id: a.id,
      name: a.name,
      description: a.description || '',
      system_prompt: systemPrompt,
      model: a.config?.model,
      temperature: a.config?.temperature ?? 0.7,
      max_tokens: a.config?.maxTokens ?? 4096,
      skills: a.skills || [],
      mcp_servers: mcpServers,
    })
  }

  return results
}
