/**
 * User 服务
 *
 * 处理当前用户资料读写
 * 单用户模式：数据持久化到 ~/.semibot/auth/auth.json
 */

import { createError } from '../middleware/errorHandler'
import { AUTH_USER_NOT_FOUND, AUTH_INVALID_PASSWORD } from '../constants/errorCodes'
import bcrypt from 'bcryptjs'
import { BCRYPT_ROUNDS } from '../constants/config'
import * as localStore from '../lib/auth-local-store'

export interface UserProfile {
  id: string
  email: string
  name: string
  avatarUrl?: string
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

// In-memory preferences fallback for single-user mode (org functions removed)
let _cachedPreferences: Record<string, unknown> = {}

function normalizePreferences(settings: Record<string, unknown> | null | undefined): UserPreferences {
  const safe = settings ?? {}
  return {
    theme: (safe.theme as UserPreferences['theme']) ?? 'dark',
    language: (safe.language as UserPreferences['language']) ?? 'zh-CN',
  }
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const user = await localStore.localFindUserById(userId)
  if (!user) throw createError(AUTH_USER_NOT_FOUND)

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url ?? undefined,
    role: user.role,
  }
}

export async function updateUserProfile(
  userId: string,
  input: UpdateUserProfileInput
): Promise<UserProfile> {
  const updated = await localStore.localUpdateUserProfile(userId, {
    name: input.name,
    avatarUrl: input.avatarUrl,
  })
  if (!updated) throw createError(AUTH_USER_NOT_FOUND)

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    avatarUrl: updated.avatar_url ?? undefined,
    role: updated.role,
  }
}

export async function getUserPreferences(_userId: string): Promise<UserPreferences> {
  return normalizePreferences(_cachedPreferences)
}

export async function updateUserPreferences(
  _userId: string,
  input: Partial<UserPreferences>
): Promise<UserPreferences> {
  if (input.theme !== undefined) _cachedPreferences.theme = input.theme
  if (input.language !== undefined) _cachedPreferences.language = input.language
  return normalizePreferences(_cachedPreferences)
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await localStore.localFindUserById(userId)
  if (!user) throw createError(AUTH_USER_NOT_FOUND)

  const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash)
  if (!isPasswordValid) throw createError(AUTH_INVALID_PASSWORD)

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  await localStore.localUpdateUserPassword(userId, passwordHash)
}
