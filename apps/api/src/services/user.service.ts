/**
 * User 服务
 *
 * 处理当前用户资料读写
 */

import { sql } from '../lib/db'
import { createError } from '../middleware/errorHandler'
import { AUTH_USER_NOT_FOUND, AUTH_INVALID_PASSWORD } from '../constants/errorCodes'
import bcrypt from 'bcryptjs'
import { BCRYPT_ROUNDS } from '../constants/config'

export interface UserProfile {
  id: string
  email: string
  name: string
  avatarUrl?: string
  orgId: string
  role: string
}

export interface UpdateUserProfileInput {
  name?: string
  avatarUrl?: string
}

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system'
  language: 'zh-CN' | 'en-US'
}

/**
 * 获取当前用户资料
 */
export async function getUserProfile(userId: string): Promise<UserProfile> {
  const result = await sql`
    SELECT id, email, name, avatar_url, org_id, role
    FROM users
    WHERE id = ${userId} AND is_active = true
    LIMIT 1
  `

  if (result.length === 0) {
    throw createError(AUTH_USER_NOT_FOUND)
  }

  const user = result[0] as {
    id: string
    email: string
    name: string
    avatar_url: string | null
    org_id: string
    role: string
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url ?? undefined,
    orgId: user.org_id,
    role: user.role,
  }
}

/**
 * 更新当前用户资料
 */
export async function updateUserProfile(
  userId: string,
  input: UpdateUserProfileInput
): Promise<UserProfile> {
  const name = input.name ?? null
  const avatarUrl = input.avatarUrl ?? null

  const result = await sql`
    UPDATE users
    SET
      name = COALESCE(${name}, name),
      avatar_url = COALESCE(${avatarUrl}, avatar_url),
      updated_at = NOW()
    WHERE id = ${userId} AND is_active = true
    RETURNING id, email, name, avatar_url, org_id, role
  `

  if (result.length === 0) {
    throw createError(AUTH_USER_NOT_FOUND)
  }

  const user = result[0] as {
    id: string
    email: string
    name: string
    avatar_url: string | null
    org_id: string
    role: string
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url ?? undefined,
    orgId: user.org_id,
    role: user.role,
  }
}

/**
 * 获取用户偏好设置（存储在组织 settings 中）
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const result = await sql`
    SELECT o.settings
    FROM users u
    JOIN organizations o ON o.id = u.org_id
    WHERE u.id = ${userId} AND u.is_active = true
    LIMIT 1
  `

  if (result.length === 0) {
    throw createError(AUTH_USER_NOT_FOUND)
  }

  const row = result[0] as { settings: Record<string, unknown> | null }
  const settings = row.settings ?? {}

  return {
    theme: (settings.theme as UserPreferences['theme']) ?? 'dark',
    language: (settings.language as UserPreferences['language']) ?? 'zh-CN',
  }
}

/**
 * 更新用户偏好设置（存储在组织 settings 中）
 */
export async function updateUserPreferences(
  userId: string,
  input: Partial<UserPreferences>
): Promise<UserPreferences> {
  const theme = input.theme ?? null
  const language = input.language ?? null

  const result = await sql`
    UPDATE organizations
    SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_strip_nulls(
      jsonb_build_object(
        'theme', ${theme}::text,
        'language', ${language}::text
      )
    )
    WHERE id = (
      SELECT org_id FROM users
      WHERE id = ${userId} AND is_active = true
      LIMIT 1
    )
    RETURNING settings
  `

  if (result.length === 0) {
    throw createError(AUTH_USER_NOT_FOUND)
  }

  const row = result[0] as { settings: Record<string, unknown> | null }
  const settings = row.settings ?? {}

  return {
    theme: (settings.theme as UserPreferences['theme']) ?? 'dark',
    language: (settings.language as UserPreferences['language']) ?? 'zh-CN',
  }
}

/**
 * 修改密码
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const result = await sql`
    SELECT id, password_hash
    FROM users
    WHERE id = ${userId} AND is_active = true
    LIMIT 1
  `

  if (result.length === 0) {
    throw createError(AUTH_USER_NOT_FOUND)
  }

  const user = result[0] as { id: string; password_hash: string }

  const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash)
  if (!isPasswordValid) {
    throw createError(AUTH_INVALID_PASSWORD)
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  await sql`
    UPDATE users
    SET password_hash = ${passwordHash}, updated_at = NOW()
    WHERE id = ${userId}
  `
}
