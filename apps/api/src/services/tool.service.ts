/**
 * Tool 服务层
 *
 * 使用数据库持久化实现 Tool CRUD
 */

import { createError } from '../middleware/errorHandler'
import { TOOL_NOT_FOUND, TOOL_LIMIT_EXCEEDED } from '../constants/errorCodes'
import * as toolRepository from '../repositories/tool.repository'

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
  name?: string
  description?: string
  type?: string
  schema?: ToolSchema
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
// 常量配置
// ═══════════════════════════════════════════════════════════════

const MAX_TOOLS_PER_ORG = 100

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
    console.warn(
      `[ToolService] Tool 数量已达上限 - 组织: ${orgId}, 当前: ${existingTools.meta.total}, 限制: ${MAX_TOOLS_PER_ORG}`
    )
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

  return {
    data: result.data.map(rowToTool),
    meta: result.meta,
  }
}

/**
 * 更新 Tool
 */
export async function updateTool(
  orgId: string,
  toolId: string,
  input: UpdateToolInput
): Promise<Tool> {
  // 先获取现有 Tool
  const existing = await getTool(orgId, toolId)

  // 内置 Tool 不可修改
  if (existing.isBuiltin) {
    throw createError(TOOL_NOT_FOUND)
  }

  // 确保只能更新自己组织的 Tool
  if (existing.orgId !== orgId) {
    throw createError(TOOL_NOT_FOUND)
  }

  const row = await toolRepository.update(toolId, {
    name: input.name,
    description: input.description,
    type: input.type,
    schema: input.schema,
    config: input.config,
    isActive: input.isActive,
  })

  if (!row) {
    throw createError(TOOL_NOT_FOUND)
  }

  return rowToTool(row)
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
