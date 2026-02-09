/**
 * Skill 服务层
 *
 * 使用数据库持久化实现 Skill CRUD
 */

import { createError } from '../middleware/errorHandler'
import {
  SKILL_NOT_FOUND,
  SKILL_LIMIT_EXCEEDED,
  SKILL_BUILTIN_READONLY,
  VALIDATION_INVALID_FORMAT,
} from '../constants/errorCodes'
import {
  ANTHROPIC_SKILLS_CATALOG_URL,
  SKILL_MANIFEST_FETCH_TIMEOUT_MS,
  MAX_SKILL_KEYWORDS,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILLS_PER_ORG,
} from '../constants/config'
import * as skillRepository from '../repositories/skill.repository'
import { createLogger } from '../lib/logger'

const skillLogger = createLogger('skill')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Skill {
  id: string
  orgId: string | null
  name: string
  description?: string
  triggerKeywords: string[]
  tools: SkillTool[]
  config: SkillConfig
  isBuiltin: boolean
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface SkillTool {
  name: string
  type: 'function' | 'mcp'
  config?: Record<string, unknown>
}

export interface SkillConfig {
  maxExecutionTime?: number
  retryAttempts?: number
  requiresApproval?: boolean
  source?: 'local' | 'anthropic' | 'custom'
  anthropicSkill?: {
    type: 'anthropic' | 'custom'
    skillId: string
    version?: string
  }
  container?: {
    skills: Array<{
      type: 'anthropic' | 'custom'
      skill_id: string
      version?: string
    }>
  }
  [key: string]: unknown
}

export interface AnthropicContainerSkillRef {
  type: 'anthropic' | 'custom'
  skill_id: string
  version?: string
}

export interface CreateSkillInput {
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
}

export interface InstallAnthropicSkillInput {
  skillId: string
  version?: string
  name?: string
  description?: string
  triggerKeywords?: string[]
  requiresApproval?: boolean
}

export interface InstallAnthropicSkillFromManifestInput {
  manifestUrl: string
  skillId?: string
  version?: string
  name?: string
  description?: string
  triggerKeywords?: string[]
  requiresApproval?: boolean
}

export interface AnthropicSkillCatalogItem {
  skillId: string
  name: string
  description?: string
  version?: string
  manifestUrl?: string
  sourceUrl?: string
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
  isActive?: boolean
}

export interface ListSkillsOptions {
  page?: number
  limit?: number
  search?: string
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

const ANTHROPIC_SKILL_ID_PATTERN = /^[a-zA-Z0-9._:/-]{1,120}$/

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Skill 对象
 */
function rowToSkill(row: skillRepository.SkillRow): Skill {
  const parseJsonValue = <T>(value: unknown, fallback: T): T => {
    if (value === null || value === undefined) return fallback
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T
      } catch {
        return fallback
      }
    }
    return value as T
  }

  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    triggerKeywords: row.trigger_keywords ?? [],
    tools: parseJsonValue<SkillTool[]>(row.tools, []),
    config: parseJsonValue<SkillConfig>(row.config, {}),
    isBuiltin: row.is_builtin,
    isActive: row.is_active,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAnthropicSkillConfig(input: InstallAnthropicSkillInput): SkillConfig {
  const normalizedSkillId = input.skillId.trim()
  const normalizedVersion = input.version?.trim() || 'latest'

  if (!ANTHROPIC_SKILL_ID_PATTERN.test(normalizedSkillId)) {
    throw createError(VALIDATION_INVALID_FORMAT, 'Anthropic skillId 格式无效')
  }

  return {
    source: 'anthropic',
    anthropicSkill: {
      type: 'anthropic',
      skillId: normalizedSkillId,
      version: normalizedVersion,
    },
    container: {
      skills: [
        {
          type: 'anthropic',
          skill_id: normalizedSkillId,
          version: normalizedVersion,
        },
      ],
    },
    requiresApproval: input.requiresApproval ?? true,
  }
}

function parseSimpleFrontmatter(markdownText: string): Record<string, string> {
  const match = markdownText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return {}

  const frontmatter = match[1]
  const result: Record<string, string> = {}

  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '')
    if (key && value) {
      result[key] = value
    }
  }

  return result
}

function normalizeKeywords(rawKeywords: unknown): string[] | undefined {
  if (!Array.isArray(rawKeywords)) return undefined
  const keywords = rawKeywords
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_SKILL_KEYWORDS)
  return keywords.length > 0 ? keywords : undefined
}

function normalizeManifestSkillId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const skillId = raw.trim()
  if (!skillId || !ANTHROPIC_SKILL_ID_PATTERN.test(skillId)) return undefined
  return skillId
}

async function resolveAnthropicManifest(
  input: InstallAnthropicSkillFromManifestInput
): Promise<InstallAnthropicSkillInput> {
  const manifestUrl = input.manifestUrl.trim()
  let parsedManifestUrl: URL

  try {
    parsedManifestUrl = new URL(manifestUrl)
  } catch {
    throw createError(VALIDATION_INVALID_FORMAT, 'manifestUrl 不是合法 URL')
  }

  if (!['http:', 'https:'].includes(parsedManifestUrl.protocol)) {
    throw createError(VALIDATION_INVALID_FORMAT, 'manifestUrl 仅支持 http/https 协议')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SKILL_MANIFEST_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(parsedManifestUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/markdown,text/plain,*/*',
      },
    })

    if (!response.ok) {
      throw createError(
        VALIDATION_INVALID_FORMAT,
        `无法获取 manifest，HTTP ${response.status}`
      )
    }

    const rawText = await response.text()
    const contentType = response.headers.get('content-type') ?? ''

    let manifestSkillId = normalizeManifestSkillId(input.skillId)
    let manifestVersion = input.version?.trim()
    let manifestName = input.name?.trim()
    let manifestDescription = input.description?.trim()
    let manifestKeywords = input.triggerKeywords

    if (contentType.includes('application/json') || rawText.trim().startsWith('{')) {
      const parsed = JSON.parse(rawText) as Record<string, unknown>
      manifestSkillId = manifestSkillId ?? normalizeManifestSkillId(parsed.skill_id ?? parsed.id)
      manifestVersion = manifestVersion || (typeof parsed.version === 'string' ? parsed.version : undefined)
      manifestName = manifestName || (typeof parsed.name === 'string' ? parsed.name : undefined)
      manifestDescription =
        manifestDescription ||
        (typeof parsed.description === 'string' ? parsed.description : undefined)
      manifestKeywords = manifestKeywords ?? normalizeKeywords(parsed.trigger_keywords ?? parsed.keywords)
    } else {
      const parsed = parseSimpleFrontmatter(rawText)
      manifestSkillId = manifestSkillId ?? normalizeManifestSkillId(parsed.skill_id ?? parsed.id ?? parsed.name)
      manifestVersion = manifestVersion || parsed.version
      manifestName = manifestName || parsed.name
      manifestDescription = manifestDescription || parsed.description
    }

    if (!manifestSkillId) {
      throw createError(VALIDATION_INVALID_FORMAT, 'manifest 中缺少合法的 skill_id/id')
    }

    return {
      skillId: manifestSkillId,
      version: manifestVersion || 'latest',
      name: manifestName,
      description: manifestDescription,
      triggerKeywords: manifestKeywords,
      requiresApproval: input.requiresApproval,
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    ) {
      throw createError(VALIDATION_INVALID_FORMAT, '获取 manifest 超时')
    }

    if (error instanceof SyntaxError) {
      throw createError(VALIDATION_INVALID_FORMAT, 'manifest 解析失败，格式无效')
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeAbsoluteUrl(rawUrl: unknown, baseUrl?: string): string | undefined {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return undefined

  try {
    const resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)
    if (!['http:', 'https:'].includes(resolved.protocol)) return undefined
    return resolved.toString()
  } catch {
    return undefined
  }
}

function mapCatalogEntry(raw: unknown, baseUrl?: string): AnthropicSkillCatalogItem | null {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const skillId = normalizeManifestSkillId(record.skill_id ?? record.id ?? record.name)
  if (!skillId) return null

  const name =
    (typeof record.title === 'string' && record.title.trim()) ||
    (typeof record.name === 'string' && record.name.trim()) ||
    skillId

  const description =
    typeof record.description === 'string' && record.description.trim()
      ? record.description.trim()
      : undefined
  const version = typeof record.version === 'string' && record.version.trim()
    ? record.version.trim()
    : undefined

  const manifestUrl = normalizeAbsoluteUrl(
    record.manifest_url ?? record.manifestUrl ?? record.url,
    baseUrl
  )
  const sourceUrl = normalizeAbsoluteUrl(record.source_url ?? record.sourceUrl, baseUrl)

  return {
    skillId,
    name,
    description,
    version,
    manifestUrl,
    sourceUrl,
  }
}

function parseAnthropicCatalogPayload(
  payload: unknown,
  baseUrl?: string
): AnthropicSkillCatalogItem[] {
  const readArray = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) return raw
    if (!raw || typeof raw !== 'object') return []

    const record = raw as Record<string, unknown>
    const nested = record.skills ?? record.items ?? record.data
    return Array.isArray(nested) ? nested : []
  }

  const rawItems = readArray(payload)
  const mappedItems = rawItems
    .map((entry) => mapCatalogEntry(entry, baseUrl))
    .filter((entry): entry is AnthropicSkillCatalogItem => !!entry)

  const uniqueItems = new Map<string, AnthropicSkillCatalogItem>()
  for (const item of mappedItems) {
    if (!uniqueItems.has(item.skillId)) {
      uniqueItems.set(item.skillId, item)
    }
  }

  return Array.from(uniqueItems.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Skill
 */
export async function createSkill(
  orgId: string,
  userId: string,
  input: CreateSkillInput
): Promise<Skill> {
  // 检查配额
  const existingSkills = await skillRepository.findAll({ orgId, includeBuiltin: false })

  if (existingSkills.meta.total >= MAX_SKILLS_PER_ORG) {
    skillLogger.warn('Skill 数量已达上限', { orgId, current: existingSkills.meta.total, limit: MAX_SKILLS_PER_ORG })
    throw createError(SKILL_LIMIT_EXCEEDED)
  }

  const row = await skillRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords,
    tools: input.tools,
    config: input.config,
    isBuiltin: false,
    createdBy: userId,
  })

  return rowToSkill(row)
}

/**
 * 安装 Anthropic Skill（以本地 Skill 记录方式保存 Anthropic 标准元数据）
 */
export async function installAnthropicSkill(
  orgId: string,
  userId: string,
  input: InstallAnthropicSkillInput
): Promise<Skill> {
  const normalizedSkillId = input.skillId.trim()

  const skillName = (input.name?.trim() || `anthropic-${normalizedSkillId}`).slice(0, MAX_SKILL_NAME_LENGTH)
  const description =
    input.description?.trim() || `Installed from Anthropic Skills: ${normalizedSkillId}`
  const triggerKeywords = (input.triggerKeywords ?? [normalizedSkillId]).slice(0, MAX_SKILL_KEYWORDS)

  return createSkill(orgId, userId, {
    name: skillName,
    description,
    triggerKeywords,
    config: toAnthropicSkillConfig(input),
  })
}

/**
 * 通过 Anthropic skill manifest URL 安装 Skill
 */
export async function installAnthropicSkillFromManifest(
  orgId: string,
  userId: string,
  input: InstallAnthropicSkillFromManifestInput
): Promise<Skill> {
  const resolved = await resolveAnthropicManifest(input)
  return installAnthropicSkill(orgId, userId, resolved)
}

/**
 * 获取 Anthropic Skills 目录（用于前端安装选择）
 */
export async function listAnthropicSkillCatalog(
  catalogUrlOverride?: string
): Promise<AnthropicSkillCatalogItem[]> {
  const catalogUrl = (catalogUrlOverride ?? ANTHROPIC_SKILLS_CATALOG_URL).trim()
  if (!catalogUrl) {
    return []
  }

  let parsedCatalogUrl: URL
  try {
    parsedCatalogUrl = new URL(catalogUrl)
  } catch {
    skillLogger.warn('ANTHROPIC_SKILLS_CATALOG_URL 非法，已忽略')
    return []
  }

  if (!['http:', 'https:'].includes(parsedCatalogUrl.protocol)) {
    skillLogger.warn('ANTHROPIC_SKILLS_CATALOG_URL 协议不支持，已忽略')
    return []
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SKILL_MANIFEST_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(parsedCatalogUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json,text/plain,*/*' },
    })

    if (!response.ok) {
      skillLogger.warn('拉取 Anthropic Skills 目录失败', { status: response.status })
      return []
    }

    const rawText = await response.text()
    const payload = JSON.parse(rawText) as unknown
    return parseAnthropicCatalogPayload(payload, parsedCatalogUrl.toString())
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    ) {
      skillLogger.warn('拉取 Anthropic Skills 目录超时')
      return []
    }

    skillLogger.warn('拉取 Anthropic Skills 目录异常', { error })
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 获取 Skill
 */
export async function getSkill(orgId: string, skillId: string): Promise<Skill> {
  const row = await skillRepository.findById(skillId)

  if (!row) {
    throw createError(SKILL_NOT_FOUND)
  }

  // 检查权限：必须是该组织的 Skill 或内置 Skill
  if (row.org_id !== orgId && !row.is_builtin) {
    throw createError(SKILL_NOT_FOUND)
  }

  return rowToSkill(row)
}

/**
 * 列出 Skills
 */
export async function listSkills(
  orgId: string,
  options: ListSkillsOptions = {}
): Promise<PaginatedResult<Skill>> {
  const result = await skillRepository.findAll({
    orgId,
    includeBuiltin: options.includeBuiltin ?? true,
    page: options.page,
    limit: options.limit,
    search: options.search,
  })

  return {
    data: result.data.map(rowToSkill),
    meta: result.meta,
  }
}

/**
 * 按 ID 列表获取当前组织可访问且启用的 Skills
 */
export async function getActiveSkillsByIds(orgId: string, skillIds: string[]): Promise<Skill[]> {
  const uniqueSkillIds = Array.from(new Set(skillIds.filter(Boolean)))
  if (uniqueSkillIds.length === 0) {
    return []
  }

  // 使用批量查询（单次 SQL 查询，避免 N+1 问题）
  const rows = await skillRepository.findActiveByIdsAndOrg(uniqueSkillIds, orgId)

  return rows.map(rowToSkill)
}

/**
 * 更新 Skill
 */
export async function updateSkill(
  orgId: string,
  skillId: string,
  input: UpdateSkillInput
): Promise<Skill> {
  // 先获取现有 Skill
  const existing = await getSkill(orgId, skillId)

  // 内置 Skill 不可修改
  if (existing.isBuiltin) {
    throw createError(SKILL_BUILTIN_READONLY)
  }

  // 确保只能更新自己组织的 Skill
  if (existing.orgId !== orgId) {
    throw createError(SKILL_NOT_FOUND)
  }

  const row = await skillRepository.update(skillId, {
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords,
    tools: input.tools,
    config: input.config,
    isActive: input.isActive,
  })

  if (!row) {
    throw createError(SKILL_NOT_FOUND)
  }

  return rowToSkill(row)
}

/**
 * 删除 Skill (软删除)
 */
export async function deleteSkill(orgId: string, skillId: string): Promise<void> {
  // 先检查权限
  const existing = await getSkill(orgId, skillId)

  // 内置 Skill 不可删除
  if (existing.isBuiltin) {
    throw createError(SKILL_BUILTIN_READONLY)
  }

  // 确保只能删除自己组织的 Skill
  if (existing.orgId !== orgId) {
    throw createError(SKILL_NOT_FOUND)
  }

  const deleted = await skillRepository.softDelete(skillId)

  if (!deleted) {
    throw createError(SKILL_NOT_FOUND)
  }
}
