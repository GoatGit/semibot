/**
 * API Keys 服务
 *
 * 处理 API Key 的创建、列表、删除和验证
 */

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { sql } from '../lib/db'
import { createError } from '../middleware/errorHandler'
import { apiKeysLogger as logger } from '../lib/logger'
import { API_KEY_PREFIX, API_KEY_LENGTH_BYTES, BCRYPT_ROUNDS, API_KEY_PREFIX_DISPLAY_LENGTH } from '../constants/config'
import { RESOURCE_NOT_FOUND, AUTH_PERMISSION_DENIED } from '../constants/errorCodes'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  permissions: string[]
  rateLimit: number
  expiresAt: string | null
  lastUsedAt: string | null
  isActive: boolean
  createdAt: string
}

export interface CreateApiKeyInput {
  name: string
  permissions?: string[]
  expiresAt?: string
}

export interface ApiKeyWithSecret extends ApiKey {
  key: string
}

export interface ValidatedApiKey {
  id: string
  orgId: string
  userId: string
  permissions: string[]
  rateLimit: number
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 API Key
 */
export async function createApiKey(
  orgId: string,
  userId: string,
  input: CreateApiKeyInput
): Promise<ApiKeyWithSecret> {
  // 生成随机 Key
  const keyBytes = crypto.randomBytes(API_KEY_LENGTH_BYTES)
  const key = `${API_KEY_PREFIX}${keyBytes.toString('base64url')}`
  const keyPrefix = key.slice(0, API_KEY_PREFIX_DISPLAY_LENGTH) // 保留前N字符作为前缀
  const keyHash = await bcrypt.hash(key, BCRYPT_ROUNDS)

  const permissions = input.permissions ?? ['*']
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null

  const result = await sql`
    INSERT INTO api_keys (org_id, user_id, name, key_prefix, key_hash, permissions, expires_at)
    VALUES (
      ${orgId},
      ${userId},
      ${input.name},
      ${keyPrefix},
      ${keyHash},
      ${sql.json(permissions as Parameters<typeof sql.json>[0])},
      ${expiresAt}
    )
    RETURNING id, name, key_prefix, permissions, rate_limit, expires_at, is_active, created_at
  `

  const apiKey = result[0] as {
    id: string
    name: string
    key_prefix: string
    permissions: string[]
    rate_limit: number
    expires_at: string | null
    is_active: boolean
    created_at: string
  }

  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.key_prefix,
    key, // 完整密钥只在创建时返回
    permissions: apiKey.permissions,
    rateLimit: apiKey.rate_limit,
    expiresAt: apiKey.expires_at,
    lastUsedAt: null,
    isActive: apiKey.is_active,
    createdAt: apiKey.created_at,
  }
}

/**
 * 列出 API Keys
 */
export async function listApiKeys(orgId: string): Promise<ApiKey[]> {
  const result = await sql`
    SELECT
      id, name, key_prefix, permissions, rate_limit,
      expires_at, last_used_at, is_active, created_at
    FROM api_keys
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY created_at DESC
  `

  const keys = result as unknown as Array<{
    id: string
    name: string
    key_prefix: string
    permissions: string[]
    rate_limit: number
    expires_at: string | null
    last_used_at: string | null
    is_active: boolean
    created_at: string
  }>

  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.key_prefix,
    permissions: k.permissions,
    rateLimit: k.rate_limit,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    isActive: k.is_active,
    createdAt: k.created_at,
  }))
}

/**
 * 删除 API Key (软删除)
 */
export async function deleteApiKey(
  orgId: string,
  userId: string,
  userRole: string,
  keyId: string
): Promise<void> {
  // 查询 API Key
  const result = await sql`
    SELECT id, user_id FROM api_keys
    WHERE id = ${keyId} AND org_id = ${orgId} AND is_active = true
  `

  if (result.length === 0) {
    throw createError(RESOURCE_NOT_FOUND)
  }

  const apiKey = result[0] as { id: string; user_id: string }

  // 只有创建者、admin 或 owner 可以删除
  if (apiKey.user_id !== userId && userRole !== 'owner' && userRole !== 'admin') {
    throw createError(AUTH_PERMISSION_DENIED)
  }

  await sql`
    UPDATE api_keys SET is_active = false, updated_at = NOW()
    WHERE id = ${keyId}
  `
}

/**
 * 验证 API Key
 */
export async function validateApiKey(key: string): Promise<ValidatedApiKey | null> {
  if (!key.startsWith(API_KEY_PREFIX)) {
    return null
  }

  // 提取前缀用于查询
  const searchPrefix = key.slice(0, API_KEY_PREFIX_DISPLAY_LENGTH)

  // 查询可能匹配的 API Keys
  const result = await sql`
    SELECT
      id, org_id, user_id, key_hash,
      permissions, rate_limit, expires_at
    FROM api_keys
    WHERE key_prefix = ${searchPrefix}
      AND is_active = true
  `

  const candidates = result as unknown as Array<{
    id: string
    org_id: string
    user_id: string
    key_hash: string
    permissions: string[]
    rate_limit: number
    expires_at: string | null
  }>

  // 验证哈希
  for (const candidate of candidates) {
    const isValid = await bcrypt.compare(key, candidate.key_hash)

    if (isValid) {
      // 检查是否过期
      if (candidate.expires_at && new Date(candidate.expires_at) < new Date()) {
        logger.warn(`API Key ${candidate.id} 已过期`)
        return null
      }

      // 更新最后使用时间
      await sql`
        UPDATE api_keys SET last_used_at = NOW()
        WHERE id = ${candidate.id}
      `

      return {
        id: candidate.id,
        orgId: candidate.org_id,
        userId: candidate.user_id,
        permissions: candidate.permissions,
        rateLimit: candidate.rate_limit,
      }
    }
  }

  return null
}
