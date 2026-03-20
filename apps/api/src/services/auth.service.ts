/**
 * Auth 服务
 *
 * 处理用户注册、登录、Token 刷新和登出
 * 单用户模式：数据持久化到 ~/.semibot/auth/auth.json
 */

import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { sendPasswordResetEmail } from './email.service'
import { authLogger } from '../lib/logger'
import {
  BCRYPT_ROUNDS,
  JWT_EXPIRES_IN_SECONDS,
  JWT_REFRESH_EXPIRES_IN_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  PASSWORD_RESET_TOKEN_PREFIX,
  PASSWORD_RESET_REQUEST_PREFIX,
  PASSWORD_RESET_REQUEST_TTL_SECONDS,
} from '../constants/config'
import {
  AUTH_EMAIL_EXISTS,
  AUTH_USER_NOT_FOUND,
  AUTH_INVALID_PASSWORD,
  AUTH_REFRESH_TOKEN_INVALID,
  AUTH_RESET_TOKEN_INVALID,
  AUTH_RESET_TOKEN_EXPIRED,
  AUTH_USER_INACTIVE,
} from '../constants/errorCodes'
import * as localStore from '../lib/auth-local-store'
import { setWithExpiry, get, del, setNX } from '../lib/mem-store'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string
  password: string
  name: string
  orgName: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface AuthResult {
  user: {
    id: string
    email: string
    name: string
    role: string
  }
  organization?: {
    id: string
    name: string
    slug: string
  }
  token: string
  refreshToken: string
  expiresAt: string
}

interface JWTPayload {
  userId: string
  role: string
  permissions: string[]
  type: 'access' | 'refresh'
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('[Auth] 生产环境必须设置 JWT_SECRET 环境变量')
  }
  return secret ?? 'development-secret-change-in-production'
}

const JWT_SECRET = getJWTSecret()

function generateSlug(name: string): string {
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  return `${baseSlug}-${randomSuffix}`
}

function generateAccessToken(payload: Omit<JWTPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN_SECONDS,
  })
}

function generateRefreshToken(payload: Omit<JWTPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'refresh' }, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN_SECONDS,
  })
}

function verifyRefreshToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload
    if (decoded.type !== 'refresh') return null
    return decoded
  } catch {
    return null
  }
}

function getPermissionsByRole(role: string): string[] {
  switch (role) {
    case 'owner':
      return ['*']
    case 'admin':
      return ['agents:*', 'sessions:*', 'chat:*', 'skills:*', 'tools:*', 'mcp:*', 'members:read']
    case 'member':
      return ['agents:read', 'sessions:*', 'chat:*']
    default:
      return ['agents:read', 'chat:*']
  }
}

// ─── 服务方法 ─────────────────────────────────────────────────────────────────

export async function register(input: RegisterInput): Promise<AuthResult> {
  const { email, password, name, orgName } = input
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const orgSlug = generateSlug(orgName)

  try {
    const user = await localStore.localCreateUser({
      email,
      passwordHash,
      name,
      role: 'owner',
    })

    const tokenPayload = {
      userId: user.id,
      role: user.role,
      permissions: getPermissionsByRole(user.role),
    }

    const token = generateAccessToken(tokenPayload)
    const refreshToken = generateRefreshToken(tokenPayload)
    const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      organization: { id: 'local', name: orgName, slug: orgSlug },
      token,
      refreshToken,
      expiresAt,
    }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === '23505') {
      throw { code: AUTH_EMAIL_EXISTS }
    }
    throw error
  }
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const { email, password } = input

  const user = await localStore.localFindUserByEmail(email)
  if (!user) throw { code: AUTH_USER_NOT_FOUND }
  if (!user.is_active) throw { code: AUTH_USER_INACTIVE }

  const isPasswordValid = await bcrypt.compare(password, user.password_hash)
  if (!isPasswordValid) throw { code: AUTH_INVALID_PASSWORD }

  await localStore.localUpdateUserLastLogin(user.id)

  const tokenPayload = {
    userId: user.id,
    role: user.role,
    permissions: getPermissionsByRole(user.role),
  }

  const token = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    refreshToken,
    expiresAt,
  }
}

export async function refreshToken(token: string): Promise<Omit<AuthResult, 'organization'>> {
  const decoded = verifyRefreshToken(token)
  if (!decoded) throw { code: AUTH_REFRESH_TOKEN_INVALID }

  const user = await localStore.localFindUserById(decoded.userId)
  if (!user) throw { code: AUTH_USER_NOT_FOUND }
  if (!user.is_active) throw { code: AUTH_USER_INACTIVE }

  const tokenPayload = {
    userId: user.id,
    role: user.role,
    permissions: getPermissionsByRole(user.role),
  }

  const newToken = generateAccessToken(tokenPayload)
  const newRefreshToken = generateRefreshToken(tokenPayload)
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token: newToken,
    refreshToken: newRefreshToken,
    expiresAt,
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  const requestThrottleKey = `${PASSWORD_RESET_REQUEST_PREFIX}${normalizedEmail}`

  const canProceed = await setNX(requestThrottleKey, '1', PASSWORD_RESET_REQUEST_TTL_SECONDS)
  if (!canProceed) return

  const user = await localStore.localFindUserByEmail(normalizedEmail)
  if (!user) return

  const resetToken = crypto.randomBytes(32).toString('hex')
  const redisKey = `${PASSWORD_RESET_TOKEN_PREFIX}${resetToken}`
  await setWithExpiry(redisKey, user.id, PASSWORD_RESET_TTL_SECONDS)

  await sendPasswordResetEmail({ email: normalizedEmail, resetToken })
}

export async function resetPassword(resetToken: string, newPassword: string): Promise<void> {
  const redisKey = `${PASSWORD_RESET_TOKEN_PREFIX}${resetToken}`
  const userId = await get(redisKey)
  if (!userId) throw { code: AUTH_RESET_TOKEN_EXPIRED }

  const user = await localStore.localFindUserById(userId)
  if (!user) throw { code: AUTH_RESET_TOKEN_INVALID }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  await localStore.localUpdateUserPassword(userId, passwordHash)
  await del(redisKey)
}

// ─── Token 黑名单（内存 Set，进程重启后失效，单用户模式可接受）────────────────

const tokenBlacklist = new Set<string>()

const TOKEN_BLACKLIST_PREFIX = 'token:blacklist:'

export async function addToBlacklist(token: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) {
    authLogger.warn('Token 黑名单 TTL <= 0，跳过添加', { ttlSeconds })
    return
  }
  const key = `${TOKEN_BLACKLIST_PREFIX}${token}`
  tokenBlacklist.add(key)
  // 到期后自动清除
  setTimeout(() => tokenBlacklist.delete(key), ttlSeconds * 1000)
  authLogger.info('Token 已加入黑名单', { ttlSeconds })
}

export async function isBlacklisted(token: string): Promise<boolean> {
  return tokenBlacklist.has(`${TOKEN_BLACKLIST_PREFIX}${token}`)
}

function getTokenRemainingTTL(token: string): number {
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null
    if (!decoded?.exp) return 0
    const remaining = decoded.exp - Math.floor(Date.now() / 1000)
    return remaining > 0 ? remaining : 0
  } catch {
    return 0
  }
}

export async function logout(
  userId: string,
  token?: string,
  refreshTokenValue?: string
): Promise<void> {
  if (token) {
    const accessTTL = getTokenRemainingTTL(token)
    if (accessTTL > 0) await addToBlacklist(token, accessTTL)
  }
  if (refreshTokenValue) {
    const refreshTTL = getTokenRemainingTTL(refreshTokenValue)
    if (refreshTTL > 0) await addToBlacklist(refreshTokenValue, refreshTTL)
  }
  authLogger.info('用户已登出', { userId })
}
