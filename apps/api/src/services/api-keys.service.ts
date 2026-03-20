/**
 * API Keys 服务
 */

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { createError } from '../middleware/errorHandler'
import { apiKeysLogger as logger } from '../lib/logger'
import { API_KEY_PREFIX, API_KEY_LENGTH_BYTES, BCRYPT_ROUNDS, API_KEY_PREFIX_DISPLAY_LENGTH } from '../constants/config'
import { RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as localStore from '../lib/api-keys-local-store'

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
  userId: string
  permissions: string[]
  rateLimit: number
}

function rowToApiKey(row: localStore.LocalApiKeyRow, key?: string): ApiKey & { key?: string } {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    permissions: row.scopes,
    rateLimit: 1000,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    isActive: row.is_active,
    createdAt: row.created_at,
    ...(key ? { key } : {}),
  }
}

export async function createApiKey(
  userId: string,
  input: CreateApiKeyInput
): Promise<ApiKeyWithSecret> {
  const keyBytes = crypto.randomBytes(API_KEY_LENGTH_BYTES)
  const key = `${API_KEY_PREFIX}${keyBytes.toString('base64url')}`
  const keyPrefix = key.slice(0, API_KEY_PREFIX_DISPLAY_LENGTH)
  const keyHash = await bcrypt.hash(key, BCRYPT_ROUNDS)
  const scopes = input.permissions ?? ['*']
  const expiresAt = input.expiresAt ?? undefined

  const row = localStore.localCreateApiKey({ userId, name: input.name, keyPrefix, keyHash, scopes, expiresAt })
  return rowToApiKey(row, key) as ApiKeyWithSecret
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const rows = localStore.localFindApiKeysByOrg()
  return rows.map((k) => rowToApiKey(k))
}

export async function deleteApiKey(
  keyId: string
): Promise<void> {
  const row = localStore.localFindApiKeyById(keyId)
  if (!row) throw createError(RESOURCE_NOT_FOUND)
  localStore.localRevokeApiKey(keyId)
}

export async function validateApiKey(key: string): Promise<ValidatedApiKey | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null

  const searchPrefix = key.slice(0, API_KEY_PREFIX_DISPLAY_LENGTH)
  const rows = localStore.localFindApiKeysByOrg().filter((k) => k.key_prefix === searchPrefix)

  for (const candidate of rows) {
    const isValid = await bcrypt.compare(key, candidate.key_hash)
    if (isValid) {
      if (candidate.expires_at && new Date(candidate.expires_at) < new Date()) {
        logger.warn(`API Key ${candidate.id} 已过期`)
        return null
      }
      localStore.localUpdateApiKeyLastUsed(candidate.id)
      return { id: candidate.id, userId: 'local', permissions: candidate.scopes, rateLimit: 1000 }
    }
  }
  return null
}
