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
  AGENT_SYSTEM_READONLY,
  LLM_UNAVAILABLE,
} from '../constants/errorCodes'
import { MAX_AGENTS_PER_ORG } from '../constants/config'
import { SYSTEM_DEFAULT_AGENT_ID } from '../constants/config'
import { isDatabaseUnavailable, isSingleUserMode } from '../lib/local-mode'
import {
  createRuntimeAgentProfile,
  deleteRuntimeAgentProfile,
  getRuntimeAgentProfile,
  getRuntimeLlmConfig,
  listRuntimeAgentProfiles,
  updateRuntimeAgentProfile,
  type RuntimeAgentProfile,
} from '../lib/runtime-config-client'
import * as agentRepository from '../repositories/agent.repository'
import { generate, getAvailableModels } from './llm.service'
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
  orgId: string | null
  name: string
  description?: string
  systemPrompt: string
  config: AgentConfig
  skills: string[]
  subAgents: string[]
  version: number
  isActive: boolean
  isPublic: boolean
  isSystem: boolean
  runtimeType: 'semigraph'
  openclawConfig?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  model: string
  modelProviderKey?: string
  temperature: number
  maxTokens: number
  timeoutSeconds: number
  retryAttempts?: number
  fallbackModel?: string
  fallbackProviderKey?: string
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt: string
  config?: Partial<AgentConfig>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
  runtimeType?: 'semigraph'
  openclawConfig?: Record<string, unknown>
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
  runtimeType?: 'semigraph'
  openclawConfig?: Record<string, unknown>
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

export interface GenerateAgentDraftInput {
  goal: string
  model?: string
  locale?: string
}

export interface AgentDraft {
  name: string
  description: string
  systemPrompt: string
}

// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: process.env.DEFAULT_LLM_MODEL ?? '',
  modelProviderKey: process.env.DEFAULT_LLM_PROVIDER_KEY ?? '',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutSeconds: 120,
  retryAttempts: 3,
  fallbackModel: process.env.FALLBACK_LLM_MODEL ?? '',
  fallbackProviderKey: process.env.FALLBACK_LLM_PROVIDER_KEY ?? '',
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

  const rawRuntimeType = String(row.runtime_type ?? 'semigraph').toLowerCase()
  if (rawRuntimeType === 'openclaw') {
    agentLogger.warn('检测到已弃用 runtimeType=openclaw，已自动降级为 semigraph', { agentId: row.id })
  }

  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    systemPrompt: row.system_prompt,
    config: {
      model: (config.model as string) ?? DEFAULT_AGENT_CONFIG.model,
      modelProviderKey: (config.modelProviderKey as string) ?? DEFAULT_AGENT_CONFIG.modelProviderKey,
      temperature: (config.temperature as number) ?? DEFAULT_AGENT_CONFIG.temperature,
      maxTokens: (config.maxTokens as number) ?? DEFAULT_AGENT_CONFIG.maxTokens,
      timeoutSeconds: (config.timeoutSeconds as number) ?? DEFAULT_AGENT_CONFIG.timeoutSeconds,
      retryAttempts: config.retryAttempts as number | undefined,
      fallbackModel: config.fallbackModel as string | undefined,
      fallbackProviderKey: config.fallbackProviderKey as string | undefined,
    },
    skills: row.skills ?? [],
    subAgents: row.sub_agents ?? [],
    version: row.version,
    isActive: row.is_active,
    isPublic: row.is_public,
    isSystem: row.is_system,
    runtimeType: 'semigraph',
    openclawConfig: row.openclaw_config ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getLocalDefaultAgentConfig(): Promise<AgentConfig> {
  const llm = await getRuntimeLlmConfig().catch(() => null)
  return {
    ...DEFAULT_AGENT_CONFIG,
    model: llm?.default_model || DEFAULT_AGENT_CONFIG.model || 'kimi-k2.5',
    modelProviderKey: llm?.default_provider_key || DEFAULT_AGENT_CONFIG.modelProviderKey || 'kimi:kimiprovider',
    fallbackModel: llm?.fallback_model || DEFAULT_AGENT_CONFIG.fallbackModel || '',
    fallbackProviderKey: llm?.fallback_provider_key || DEFAULT_AGENT_CONFIG.fallbackProviderKey || '',
  }
}

async function buildLocalSystemAgent(): Promise<Agent> {
  const config = await getLocalDefaultAgentConfig()
  return {
    id: SYSTEM_DEFAULT_AGENT_ID,
    orgId: null,
    name: '系统助手',
    description: '系统默认 AI 助手，可使用所有系统预装能力',
    systemPrompt: 'You are a helpful AI assistant with access to system tools and capabilities.',
    config: {
      ...config,
    },
    skills: [],
    subAgents: [],
    version: 1,
    isActive: true,
    isPublic: true,
    isSystem: true,
    runtimeType: 'semigraph',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function runtimeProfileToAgent(profile: RuntimeAgentProfile, orgId: string | null): Agent {
  const metadata = (profile.metadata && typeof profile.metadata === 'object'
    ? profile.metadata
    : {}) as Record<string, unknown>
  const configExtra = (metadata.config && typeof metadata.config === 'object'
    ? metadata.config
    : {}) as Record<string, unknown>
  return {
    id: profile.id,
    orgId: (metadata.orgId as string | null | undefined) ?? orgId,
    name: profile.name,
    description: profile.description ?? undefined,
    systemPrompt: profile.system_prompt || 'You are a helpful AI assistant.',
    config: {
      model: profile.model || DEFAULT_AGENT_CONFIG.model,
      modelProviderKey: String(configExtra.modelProviderKey || DEFAULT_AGENT_CONFIG.modelProviderKey || ''),
      temperature: Number(profile.temperature ?? DEFAULT_AGENT_CONFIG.temperature),
      maxTokens: Number(profile.max_tokens ?? DEFAULT_AGENT_CONFIG.maxTokens),
      timeoutSeconds: Number(configExtra.timeoutSeconds ?? DEFAULT_AGENT_CONFIG.timeoutSeconds),
      retryAttempts: Number(configExtra.retryAttempts ?? DEFAULT_AGENT_CONFIG.retryAttempts ?? 3),
      fallbackModel: String(configExtra.fallbackModel || DEFAULT_AGENT_CONFIG.fallbackModel || ''),
      fallbackProviderKey: String(configExtra.fallbackProviderKey || DEFAULT_AGENT_CONFIG.fallbackProviderKey || ''),
    },
    skills: Array.isArray(metadata.skills) ? metadata.skills.map(String) : [],
    subAgents: Array.isArray(metadata.subAgents) ? metadata.subAgents.map(String) : [],
    version: Number(metadata.version ?? 1),
    isActive: Boolean(profile.is_active),
    isPublic: Boolean(metadata.isPublic ?? false),
    isSystem: Boolean(metadata.isSystem ?? false),
    runtimeType: 'semigraph',
    openclawConfig:
      metadata.openclawConfig && typeof metadata.openclawConfig === 'object'
        ? (metadata.openclawConfig as Record<string, unknown>)
        : undefined,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  }
}

function agentToRuntimeProfilePayload(orgId: string, input: CreateAgentInput | UpdateAgentInput, existing?: Agent): Record<string, unknown> {
  const mergedConfig = input.config ? { ...(existing?.config || DEFAULT_AGENT_CONFIG), ...input.config } : existing?.config || DEFAULT_AGENT_CONFIG
  const nextIsActive =
    'isActive' in input && typeof input.isActive === 'boolean'
      ? input.isActive
      : existing?.isActive
  return {
    ...(existing ? {} : { name: (input as CreateAgentInput).name }),
    ...(input.description !== undefined ? { description: input.description } : existing ? { description: existing.description } : {}),
    ...(input.systemPrompt !== undefined ? { system_prompt: input.systemPrompt } : existing ? { system_prompt: existing.systemPrompt } : {}),
    model: mergedConfig.model,
    temperature: mergedConfig.temperature,
    max_tokens: mergedConfig.maxTokens,
    ...(typeof nextIsActive === 'boolean' ? { is_active: nextIsActive } : {}),
    metadata: {
      orgId,
      skills: input.skills ?? existing?.skills ?? [],
      subAgents: input.subAgents ?? existing?.subAgents ?? [],
      version: existing?.version ?? 1,
      isPublic: input.isPublic ?? existing?.isPublic ?? false,
      isSystem: existing?.isSystem ?? false,
      runtimeType: 'semigraph',
      openclawConfig: input.openclawConfig ?? existing?.openclawConfig ?? {},
      config: {
        modelProviderKey: mergedConfig.modelProviderKey || '',
        timeoutSeconds: mergedConfig.timeoutSeconds,
        retryAttempts: mergedConfig.retryAttempts,
        fallbackModel: mergedConfig.fallbackModel || '',
        fallbackProviderKey: mergedConfig.fallbackProviderKey || '',
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Agent
 */
export async function createAgent(orgId: string, input: CreateAgentInput): Promise<Agent> {
  if (isSingleUserMode()) {
    const availableModels = await getAvailableModels().catch(() => [] as string[])
    if (availableModels.length === 0) {
      throw createError(LLM_UNAVAILABLE, '当前没有可用模型，无法创建 Agent')
    }
    const primaryModel = input.config?.model || availableModels[0] || (await getLocalDefaultAgentConfig()).model
    const fallbackModel =
      input.config?.fallbackModel ||
      availableModels.find((model) => model !== primaryModel) ||
      (await getLocalDefaultAgentConfig()).fallbackModel
    const payload = agentToRuntimeProfilePayload(orgId, {
      ...input,
      config: {
        ...(input.config || {}),
        model: primaryModel,
        fallbackModel,
      },
      systemPrompt: input.systemPrompt?.trim() || 'You are a helpful AI assistant.',
    })
    const item = await createRuntimeAgentProfile(payload)
    return runtimeProfileToAgent(item, orgId)
  }
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

  if ((input as { runtimeType?: string }).runtimeType === 'openclaw') {
    agentLogger.warn('创建 Agent 请求使用已弃用 runtimeType=openclaw，已强制使用 semigraph', { orgId })
  }

  const row = await agentRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    systemPrompt,
    config,
    skills: input.skills,
    subAgents: input.subAgents,
    isPublic: input.isPublic,
    runtimeType: 'semigraph',
    openclawConfig: input.openclawConfig,
  })

  return rowToAgent(row)
}

/**
 * 获取 Agent
 */
export async function getAgent(orgId: string, agentId: string): Promise<Agent> {
  if (isSingleUserMode()) {
    if (agentId === SYSTEM_DEFAULT_AGENT_ID) {
      return buildLocalSystemAgent()
    }
    const item = await getRuntimeAgentProfile(agentId)
    if (!item) throw createError(AGENT_NOT_FOUND)
    return runtimeProfileToAgent(item, orgId)
  }
  try {
    const row = await agentRepository.findByIdAndOrg(agentId, orgId)

    if (!row) {
      throw createError(AGENT_NOT_FOUND)
    }

    return rowToAgent(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error) && agentId === SYSTEM_DEFAULT_AGENT_ID) {
      return buildLocalSystemAgent()
    }
    throw error
  }
}

/**
 * 获取系统默认 Agent
 */
export async function getSystemDefaultAgent(): Promise<Agent> {
  if (isSingleUserMode()) {
    return buildLocalSystemAgent()
  }
  try {
    let row = await agentRepository.findSystemDefault()
    if (!row) {
      row = await agentRepository.ensureSystemDefault()
    }
    return rowToAgent(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      return buildLocalSystemAgent()
    }
    throw error
  }
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
  if (isSingleUserMode()) {
    const items = await listRuntimeAgentProfiles(true)
    const mapped = items.map((item) => runtimeProfileToAgent(item, orgId))
    const systemAgent = await buildLocalSystemAgent()
    const withSystem = mapped.some((item) => item.id === SYSTEM_DEFAULT_AGENT_ID) ? mapped : [systemAgent, ...mapped]
    const filtered = withSystem.filter((item) => {
      if (options.isActive !== undefined && item.isActive !== options.isActive) return false
      if (options.search) {
        const keyword = options.search.toLowerCase()
        const haystack = `${item.name} ${item.description || ''}`.toLowerCase()
        if (!haystack.includes(keyword)) return false
      }
      return true
    })
    filtered.sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    const page = options.page || 1
    const limit = options.limit || 20
    const start = (page - 1) * limit
    const data = filtered.slice(start, start + limit)
    return {
      data,
      meta: {
        total: filtered.length,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
      },
    }
  }
  try {
    const shouldEnsureSystemDefault =
      !options.search &&
      options.isActive !== false &&
      (options.page === undefined || options.page === 1)
    if (shouldEnsureSystemDefault) {
      await agentRepository.ensureSystemDefault()
    }

    let result = await agentRepository.findByOrg({
      orgId,
      page: options.page,
      limit: options.limit,
      isActive: options.isActive,
      search: options.search,
    })

    const hasFilter = Boolean(options.search) || options.isActive === false
    if (result.data.length === 0 && !hasFilter) {
      await agentRepository.ensureSystemDefault()
      result = await agentRepository.findByOrg({
        orgId,
        page: options.page,
        limit: options.limit,
        isActive: options.isActive,
        search: options.search,
      })
    }

    return {
      data: result.data.map(rowToAgent),
      meta: result.meta,
    }
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const fallback = await buildLocalSystemAgent()
      return {
        data: [fallback],
        meta: {
          total: 1,
          page: options.page || 1,
          limit: options.limit || 20,
          totalPages: 1,
        },
      }
    }
    throw error
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

  // 系统 Agent 不可修改
  if (existing.isSystem) {
    throw createError(AGENT_SYSTEM_READONLY)
  }

  if (isSingleUserMode()) {
    const payload = agentToRuntimeProfilePayload(orgId, input, existing)
    const item = await updateRuntimeAgentProfile(agentId, payload)
    if (!item) throw createError(AGENT_NOT_FOUND)
    return runtimeProfileToAgent(item, orgId)
  }

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
    runtimeType: 'semigraph',
    openclawConfig: input.openclawConfig,
  })

  if (!row) {
    throw createError(AGENT_NOT_FOUND)
  }

  return rowToAgent(row)
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) {
    return raw.slice(first, last + 1)
  }
  return raw.trim()
}

function sanitizeDraft(input: Partial<AgentDraft>, goal: string): AgentDraft {
  const normalizedName = String(input.name || '').trim().slice(0, 100)
  const normalizedDescription = String(input.description || '').trim().slice(0, 1000)
  const normalizedSystemPrompt = String(input.systemPrompt || '').trim().slice(0, 10000)

  const fallbackName = `Agent - ${goal.trim().slice(0, 30) || 'Assistant'}`
  const fallbackDescription = `负责完成目标：${goal.trim().slice(0, 200)}`
  const fallbackPrompt = `你是一个专注的 AI 代理。\n你的目标：${goal.trim()}\n请优先给出可执行、清晰、稳健的结果。`

  return {
    name: normalizedName || fallbackName,
    description: normalizedDescription || fallbackDescription,
    systemPrompt: normalizedSystemPrompt || fallbackPrompt,
  }
}

export async function generateAgentDraft(input: GenerateAgentDraftInput): Promise<AgentDraft> {
  const goal = input.goal.trim()
  if (!goal) {
    throw new Error('goal is required')
  }

  const localeHint = input.locale || 'zh-CN'
  try {
    const response = await generate(
      [
        {
          role: 'system',
          content: [
            'You are an expert AI agent designer.',
            'Generate a compact draft for a new agent.',
            'Return JSON only, no markdown, no extra text.',
            'JSON schema:',
            '{"name":"string","description":"string","systemPrompt":"string"}',
            'Constraints:',
            '- name <= 100 chars',
            '- description <= 300 chars',
            '- systemPrompt <= 2000 chars',
            '- practical, action-oriented, and safe',
            `- prefer language consistent with locale: ${localeHint}`,
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Goal:\n${goal}`,
        },
      ],
      {
        model: input.model || DEFAULT_AGENT_CONFIG.model,
        temperature: 0.4,
        maxTokens: 900,
      }
    )

    const raw = extractJsonObject(response.content || '')
    const parsed = JSON.parse(raw) as Partial<AgentDraft>
    return sanitizeDraft(parsed, goal)
  } catch (error) {
    agentLogger.warn('Agent draft generation failed, using fallback', {
      model: input.model || DEFAULT_AGENT_CONFIG.model,
      error: error instanceof Error ? error.message : String(error),
    })
    return sanitizeDraft({}, goal)
  }
}

/**
 * 删除 Agent (软删除)
 */
export async function deleteAgent(orgId: string, agentId: string): Promise<void> {
  // 系统 Agent 不可删除
  const agent = await getAgent(orgId, agentId)
  if (agent.isSystem) {
    throw createError(AGENT_SYSTEM_READONLY)
  }

  if (isSingleUserMode()) {
    const deleted = await deleteRuntimeAgentProfile(agentId)
    if (!deleted) throw createError(AGENT_NOT_FOUND)
    return
  }

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

  const results = await Promise.all(candidates.map(async (row) => {
    const a = rowToAgent(row)

    // 加载候选 Agent 自己的 Skill 索引（注入 system_prompt）
    let systemPrompt = a.systemPrompt || `你是 ${a.name}，一个有帮助的 AI 助手。`
    if (a.skills && a.skills.length > 0) {
      try {
        const pairResults = await Promise.all(a.skills.map(async (skillDefId) => {
          const def = await skillDefinitionRepo.findById(skillDefId)
          if (!def || !def.isActive) return null
          const pkg = await skillPackageRepo.findByDefinition(skillDefId)
          if (!pkg) return null
          return { definition: def, package: pkg }
        }))
        const skillPairs = pairResults.filter(
          (p): p is { definition: skillDefinitionRepo.SkillDefinition; package: skillPackageRepo.SkillPackage } => p !== null
        )
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

    return {
      id: a.id,
      name: a.name,
      description: a.description || '',
      system_prompt: systemPrompt,
      model: a.config?.model,
      temperature: a.config?.temperature ?? 0.7,
      max_tokens: a.config?.maxTokens ?? 4096,
      skills: a.skills || [],
      mcp_servers: mcpServers,
    }
  }))

  return results
}
