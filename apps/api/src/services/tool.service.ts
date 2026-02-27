/**
 * Tool 服务层
 *
 * 使用数据库持久化实现 Tool CRUD
 */

import { createError } from '../middleware/errorHandler'
import { TOOL_NOT_FOUND, TOOL_LIMIT_EXCEEDED } from '../constants/errorCodes'
import { MAX_TOOLS_PER_ORG } from '../constants/config'
import * as toolRepository from '../repositories/tool.repository'
import { createLogger } from '../lib/logger'

const toolLogger = createLogger('tool')
const NON_TOOL_SKILL_NAMES = new Set(['xlsx', 'pdf'])

const BUILTIN_TOOL_TEMPLATES: Record<
  string,
  { description: string; type: string; config: ToolConfig }
> = {
  search: {
    description: '内建搜索工具',
    type: 'builtin',
    config: {
      timeout: 15000,
      rateLimit: 120,
      requiresApproval: false,
      riskLevel: 'low',
      approvalScope: 'session',
      approvalDedupeKeys: [],
    },
  },
  web_search: {
    description: '内建 Web 搜索工具',
    type: 'builtin',
    config: {
      timeout: 15000,
      rateLimit: 120,
      requiresApproval: false,
      riskLevel: 'low',
      approvalScope: 'session',
      approvalDedupeKeys: [],
    },
  },
  code_executor: {
    description: '内建代码执行工具',
    type: 'builtin',
    config: {
      timeout: 60000,
      rateLimit: 60,
      requiresApproval: true,
      riskLevel: 'high',
      approvalScope: 'session',
      approvalDedupeKeys: [],
    },
  },
  file_io: {
    description: '内建本地文件读写工具',
    type: 'builtin',
    config: {
      timeout: 10000,
      rateLimit: 120,
      requiresApproval: true,
      riskLevel: 'high',
      approvalScope: 'session',
      approvalDedupeKeys: [],
    },
  },
  browser_automation: {
    description: '内建浏览器自动化工具（Playwright）',
    type: 'builtin',
    config: {
      timeout: 30000,
      rateLimit: 60,
      requiresApproval: true,
      riskLevel: 'high',
      approvalScope: 'session',
      approvalDedupeKeys: [],
      headless: true,
      browserType: 'chromium',
      blockedDomains: ['localhost', '127.0.0.1', '::1'],
      allowedDomains: [],
      maxTextLength: 20000,
    },
  },
}

function getBuiltinTemplate(toolName: string): { description: string; type: string; config: ToolConfig } {
  return (
    BUILTIN_TOOL_TEMPLATES[toolName] ?? {
      description: `Builtin tool: ${toolName}`,
      type: 'builtin',
      config: {
        timeout: 15000,
        rateLimit: 100,
      },
    }
  )
}

function sanitizeToolConfig(toolName: string, config?: ToolConfig): ToolConfig | undefined {
  if (!config) return undefined
  const sanitized: ToolConfig = { ...config }
  delete sanitized.permissions
  if (toolName === 'code_executor' || toolName === 'file_io' || toolName === 'browser_automation') {
    delete sanitized.apiEndpoint
    delete sanitized.apiKey
  }
  return sanitized
}

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Tool {
  id: string
  orgId: string | null
  name: string
  description?: string
  type: string
  schema: ToolSchema
  config: ToolConfig
  isBuiltin: boolean
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface ToolSchema {
  parameters?: Record<string, unknown>
  returns?: Record<string, unknown>
  [key: string]: unknown
}

export interface ToolConfig {
  timeout?: number
  retryAttempts?: number
  requiresApproval?: boolean
  rateLimit?: number
  [key: string]: unknown
}

export interface CreateToolInput {
  name: string
  description?: string
  type: string
  schema?: ToolSchema
  config?: ToolConfig
}

export interface UpdateToolInput {
  config?: ToolConfig
  isActive?: boolean
}

export interface ListToolsOptions {
  page?: number
  limit?: number
  search?: string
  type?: string
  includeBuiltin?: boolean
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
 * 将数据库行转换为 Tool 对象
 */
function rowToTool(row: toolRepository.ToolRow): Tool {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    schema: row.schema as ToolSchema,
    config: row.config as ToolConfig,
    isBuiltin: row.is_builtin,
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
 * 创建 Tool
 */
export async function createTool(
  orgId: string,
  userId: string,
  input: CreateToolInput
): Promise<Tool> {
  // 检查配额
  const existingTools = await toolRepository.findAll({ orgId, includeBuiltin: false })

  if (existingTools.meta.total >= MAX_TOOLS_PER_ORG) {
    toolLogger.warn('Tool 数量已达上限', { orgId, current: existingTools.meta.total, limit: MAX_TOOLS_PER_ORG })
    throw createError(TOOL_LIMIT_EXCEEDED)
  }

  const row = await toolRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    type: input.type,
    schema: input.schema,
    config: input.config,
    isBuiltin: false,
    createdBy: userId,
  })

  return rowToTool(row)
}

/**
 * 获取 Tool
 */
export async function getTool(orgId: string, toolId: string): Promise<Tool> {
  const row = await toolRepository.findById(toolId)

  if (!row) {
    throw createError(TOOL_NOT_FOUND)
  }

  // 检查权限：必须是该组织的 Tool 或内置 Tool
  if (row.org_id !== orgId && !row.is_builtin) {
    throw createError(TOOL_NOT_FOUND)
  }
  if (NON_TOOL_SKILL_NAMES.has((row.name || '').toLowerCase())) {
    throw createError(TOOL_NOT_FOUND)
  }

  return rowToTool(row)
}

/**
 * 列出 Tools
 */
export async function listTools(
  orgId: string,
  options: ListToolsOptions = {}
): Promise<PaginatedResult<Tool>> {
  const result = await toolRepository.findAll({
    orgId,
    includeBuiltin: options.includeBuiltin ?? true,
    page: options.page,
    limit: options.limit,
    search: options.search,
    type: options.type,
  })

  const filtered = result.data.filter((row) => !NON_TOOL_SKILL_NAMES.has((row.name || '').toLowerCase()))
  return {
    data: filtered.map(rowToTool),
    meta: {
      ...result.meta,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / (result.meta.limit || 1))),
    },
  }
}

/**
 * 更新 Tool
 */
export async function updateTool(
  orgId: string,
  toolId: string,
  input: UpdateToolInput,
  userId?: string
): Promise<Tool> {
  // 先获取现有 Tool
  const existing = await getTool(orgId, toolId)

  // 只允许更新当前组织 Tool 或内建 Tool 的配置/状态
  if (existing.orgId !== orgId && !existing.isBuiltin) {
    throw createError(TOOL_NOT_FOUND)
  }
  if (NON_TOOL_SKILL_NAMES.has(existing.name.toLowerCase())) {
    throw createError(TOOL_NOT_FOUND)
  }
  const template = existing.isBuiltin ? getBuiltinTemplate(existing.name.toLowerCase()) : null
  const sanitizedInputConfig = sanitizeToolConfig(existing.name.toLowerCase(), input.config)

  const mergedConfig =
    sanitizedInputConfig !== undefined
      ? ({
          ...(template?.config ?? {}),
          ...(existing.config || {}),
          ...sanitizedInputConfig,
        } as ToolConfig)
      : undefined

  const row = await toolRepository.update(toolId, {
    config: mergedConfig,
    isActive: input.isActive,
  }, userId)

  if (!row) {
    throw createError(TOOL_NOT_FOUND)
  }

  return rowToTool(row)
}

/**
 * 按内建工具名创建/更新配置（若不存在则自动创建配置记录）
 */
export async function upsertBuiltinToolConfig(
  orgId: string,
  userId: string,
  toolName: string,
  input: UpdateToolInput
): Promise<Tool> {
  const normalizedName = toolName.trim().toLowerCase()
  if (!normalizedName) {
    throw createError(TOOL_NOT_FOUND)
  }
  if (NON_TOOL_SKILL_NAMES.has(normalizedName)) {
    throw createError(TOOL_NOT_FOUND)
  }
  const template = getBuiltinTemplate(normalizedName)
  const sanitizedInputConfig = sanitizeToolConfig(normalizedName, input.config)

  const existing = await toolRepository.findByNameAndOrg(normalizedName, orgId)

  if (!existing) {
    const config = {
      ...template.config,
      ...(sanitizedInputConfig ?? {}),
    }
    const created = await toolRepository.create({
      orgId,
      name: normalizedName,
      description: template.description,
      type: template.type,
      schema: {},
      config,
      isBuiltin: true,
      createdBy: userId,
    })

    // 新建后允许显式设置 isActive
    if (input.isActive === false) {
      const updated = await toolRepository.update(created.id, { isActive: false }, userId)
      return rowToTool(updated ?? created)
    }
    return rowToTool(created)
  }

  if (existing.org_id !== orgId && !existing.is_builtin) {
    throw createError(TOOL_NOT_FOUND)
  }

  const mergedConfig =
    sanitizedInputConfig !== undefined
      ? ({
          ...template.config,
          ...(existing.config as ToolConfig),
          ...sanitizedInputConfig,
        } as ToolConfig)
      : ({
          ...template.config,
          ...(existing.config as ToolConfig),
        } as ToolConfig)

  const updated = await toolRepository.update(
    existing.id,
    {
      config: mergedConfig,
      isActive: input.isActive,
    },
    userId
  )

  if (!updated) {
    throw createError(TOOL_NOT_FOUND)
  }
  return rowToTool(updated)
}

/**
 * 删除 Tool (软删除)
 */
export async function deleteTool(orgId: string, toolId: string): Promise<void> {
  // 先检查权限
  const existing = await getTool(orgId, toolId)

  // 内置 Tool 不可删除
  if (existing.isBuiltin) {
    throw createError(TOOL_NOT_FOUND)
  }

  // 确保只能删除自己组织的 Tool
  if (existing.orgId !== orgId) {
    throw createError(TOOL_NOT_FOUND)
  }

  const deleted = await toolRepository.softDelete(toolId)

  if (!deleted) {
    throw createError(TOOL_NOT_FOUND)
  }
}
