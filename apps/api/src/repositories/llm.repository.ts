/**
 * LLM Repository
 *
 * 处理 LLM Providers 和 Models 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface LLMProviderRow {
  id: string
  org_id: string | null
  name: string
  provider_type: string
  endpoint: string | null
  config: Record<string, unknown>
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LLMModelRow {
  id: string
  provider_id: string
  model_id: string
  display_name: string | null
  capabilities: string[]
  context_window: number | null
  max_output_tokens: number | null
  input_price_per_1k: string | null
  output_price_per_1k: string | null
  config: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LLMModelWithProvider extends LLMModelRow {
  provider_name: string
  provider_type: string
}

// ═══════════════════════════════════════════════════════════════
// Provider 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 获取组织可用的 Providers（包括系统内置）
 */
export async function findProvidersByOrg(orgId: string): Promise<LLMProviderRow[]> {
  const result = await sql`
    SELECT id, org_id, name, provider_type, endpoint, config, is_default, is_active, created_at, updated_at
    FROM llm_providers
    WHERE is_active = true AND (org_id IS NULL OR org_id = ${orgId})
    ORDER BY is_default DESC, name ASC
  `

  return result as unknown as LLMProviderRow[]
}

/**
 * 获取所有系统内置的 Providers
 */
export async function findSystemProviders(): Promise<LLMProviderRow[]> {
  const result = await sql`
    SELECT id, org_id, name, provider_type, endpoint, config, is_default, is_active, created_at, updated_at
    FROM llm_providers
    WHERE is_active = true AND org_id IS NULL
    ORDER BY is_default DESC, name ASC
  `

  return result as unknown as LLMProviderRow[]
}

/**
 * 根据 ID 获取 Provider
 */
export async function findProviderById(id: string): Promise<LLMProviderRow | null> {
  const result = await sql`
    SELECT id, org_id, name, provider_type, endpoint, config, is_default, is_active, created_at, updated_at
    FROM llm_providers
    WHERE id = ${id}
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as LLMProviderRow
}

// ═══════════════════════════════════════════════════════════════
// Model 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 获取组织可用的所有模型（包括系统内置）
 */
export async function findModelsByOrg(orgId: string): Promise<LLMModelWithProvider[]> {
  const result = await sql`
    SELECT
      m.id,
      m.provider_id,
      m.model_id,
      m.display_name,
      m.capabilities,
      m.context_window,
      m.max_output_tokens,
      m.input_price_per_1k,
      m.output_price_per_1k,
      m.config,
      m.is_active,
      m.created_at,
      m.updated_at,
      p.name as provider_name,
      p.provider_type
    FROM llm_models m
    JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.is_active = true
      AND p.is_active = true
      AND (p.org_id IS NULL OR p.org_id = ${orgId})
    ORDER BY p.name ASC, m.display_name ASC
  `

  return result as unknown as LLMModelWithProvider[]
}

/**
 * 获取所有系统内置的模型
 */
export async function findSystemModels(): Promise<LLMModelWithProvider[]> {
  const result = await sql`
    SELECT
      m.id,
      m.provider_id,
      m.model_id,
      m.display_name,
      m.capabilities,
      m.context_window,
      m.max_output_tokens,
      m.input_price_per_1k,
      m.output_price_per_1k,
      m.config,
      m.is_active,
      m.created_at,
      m.updated_at,
      p.name as provider_name,
      p.provider_type
    FROM llm_models m
    JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.is_active = true
      AND p.is_active = true
      AND p.org_id IS NULL
    ORDER BY p.name ASC, m.display_name ASC
  `

  return result as unknown as LLMModelWithProvider[]
}

/**
 * 根据 Provider ID 获取模型列表
 */
export async function findModelsByProvider(providerId: string): Promise<LLMModelRow[]> {
  const result = await sql`
    SELECT *
    FROM llm_models
    WHERE provider_id = ${providerId} AND is_active = true
    ORDER BY display_name ASC
  `

  return result as unknown as LLMModelRow[]
}

/**
 * 根据模型 ID 获取模型
 */
export async function findModelById(id: string): Promise<LLMModelWithProvider | null> {
  const result = await sql`
    SELECT
      m.*,
      p.name as provider_name,
      p.provider_type
    FROM llm_models m
    JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.id = ${id}
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as LLMModelWithProvider
}

/**
 * 根据 model_id 字符串查找模型
 */
export async function findModelByModelId(modelId: string): Promise<LLMModelWithProvider | null> {
  const result = await sql`
    SELECT
      m.*,
      p.name as provider_name,
      p.provider_type
    FROM llm_models m
    JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.model_id = ${modelId} AND m.is_active = true AND p.is_active = true
    LIMIT 1
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as LLMModelWithProvider
}

/**
 * 根据能力筛选模型
 */
export async function findModelsByCapability(
  orgId: string,
  capability: string
): Promise<LLMModelWithProvider[]> {
  const result = await sql`
    SELECT
      m.*,
      p.name as provider_name,
      p.provider_type
    FROM llm_models m
    JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.is_active = true
      AND p.is_active = true
      AND (p.org_id IS NULL OR p.org_id = ${orgId})
      AND ${capability} = ANY(m.capabilities)
    ORDER BY p.name ASC, m.display_name ASC
  `

  return result as unknown as LLMModelWithProvider[]
}
