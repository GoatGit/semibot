/**
 * Auth 服务
 *
 * 处理用户注册、登录、Token 刷新和登出
 */

import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { sql } from '../lib/db'
import {
  BCRYPT_ROUNDS,
  JWT_EXPIRES_IN_SECONDS,
  JWT_REFRESH_EXPIRES_IN_SECONDS,
} from '../constants/config'
import {
  AUTH_EMAIL_EXISTS,
  AUTH_USER_NOT_FOUND,
  AUTH_INVALID_PASSWORD,
  AUTH_REFRESH_TOKEN_INVALID,
  AUTH_USER_INACTIVE,
} from '../constants/errorCodes'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

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
    orgId: string
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
  orgId: string
  role: string
  permissions: string[]
  type: 'access' | 'refresh'
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('[Auth] 生产环境必须设置 JWT_SECRET 环境变量')
  }

  return secret ?? 'development-secret-change-in-production'
}

const JWT_SECRET = getJWTSecret()

/**
 * 生成 URL 友好的 slug
 */
function generateSlug(name: string): string {
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const randomSuffix = Math.random().toString(36).substring(2, 8)
  return `${baseSlug}-${randomSuffix}`
}

/**
 * 生成访问 Token
 */
function generateAccessToken(payload: Omit<JWTPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN_SECONDS,
  })
}

/**
 * 生成刷新 Token
 */
function generateRefreshToken(payload: Omit<JWTPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'refresh' }, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN_SECONDS,
  })
}

/**
 * 验证刷新 Token
 */
function verifyRefreshToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload
    if (decoded.type !== 'refresh') {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

/**
 * 根据角色获取默认权限
 */
function getPermissionsByRole(role: string): string[] {
  switch (role) {
    case 'owner':
      return ['*']
    case 'admin':
      return ['agents:*', 'sessions:*', 'chat:*', 'skills:*', 'tools:*', 'members:read']
    case 'member':
      return ['agents:read', 'sessions:*', 'chat:*']
    default:
      return ['agents:read', 'chat:*']
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 用户注册
 */
export async function register(input: RegisterInput): Promise<AuthResult> {
  const { email, password, name, orgName } = input

  // 检查邮箱是否已存在
  const existingUser = await sql`
    SELECT id FROM users WHERE email = ${email}
  `

  if (existingUser.length > 0) {
    throw { code: AUTH_EMAIL_EXISTS }
  }

  // 创建密码哈希
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

  // 生成组织 slug
  const orgSlug = generateSlug(orgName)

  // 先创建临时 UUID 作为 owner_id
  const tempOwnerId = crypto.randomUUID()

  // 创建组织
  const orgResult = await sql`
    INSERT INTO organizations (name, slug, owner_id)
    VALUES (${orgName}, ${orgSlug}, ${tempOwnerId}::uuid)
    RETURNING id, name, slug
  `
  const org = orgResult[0] as { id: string; name: string; slug: string }

  // 创建用户
  const userResult = await sql`
    INSERT INTO users (email, password_hash, name, org_id, role)
    VALUES (${email}, ${passwordHash}, ${name}, ${org.id}, 'owner')
    RETURNING id, email, name, org_id, role
  `
  const user = userResult[0] as { id: string; email: string; name: string; org_id: string; role: string }

  // 更新组织的 owner_id
  await sql`
    UPDATE organizations SET owner_id = ${user.id} WHERE id = ${org.id}
  `

  // 生成 Token
  const tokenPayload = {
    userId: user.id,
    orgId: user.org_id,
    role: user.role,
    permissions: getPermissionsByRole(user.role),
  }

  const token = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      orgId: user.org_id,
      role: user.role,
    },
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
    },
    token,
    refreshToken,
    expiresAt,
  }
}

/**
 * 用户登录
 */
export async function login(input: LoginInput): Promise<AuthResult> {
  const { email, password } = input

  // 查询用户
  const userResult = await sql`
    SELECT id, email, password_hash, name, org_id, role, is_active
    FROM users
    WHERE email = ${email}
  `

  if (userResult.length === 0) {
    throw { code: AUTH_USER_NOT_FOUND }
  }

  const user = userResult[0] as {
    id: string
    email: string
    password_hash: string
    name: string
    org_id: string
    role: string
    is_active: boolean
  }

  if (!user.is_active) {
    throw { code: AUTH_USER_INACTIVE }
  }

  // 验证密码
  const isPasswordValid = await bcrypt.compare(password, user.password_hash)

  if (!isPasswordValid) {
    throw { code: AUTH_INVALID_PASSWORD }
  }

  // 更新最后登录时间
  await sql`
    UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}
  `

  // 生成 Token
  const tokenPayload = {
    userId: user.id,
    orgId: user.org_id,
    role: user.role,
    permissions: getPermissionsByRole(user.role),
  }

  const token = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      orgId: user.org_id,
      role: user.role,
    },
    token,
    refreshToken,
    expiresAt,
  }
}

/**
 * 刷新 Token
 */
export async function refreshToken(token: string): Promise<Omit<AuthResult, 'organization'>> {
  const decoded = verifyRefreshToken(token)

  if (!decoded) {
    throw { code: AUTH_REFRESH_TOKEN_INVALID }
  }

  // 验证用户仍然存在且活跃
  const userResult = await sql`
    SELECT id, email, name, org_id, role, is_active
    FROM users
    WHERE id = ${decoded.userId}
  `

  if (userResult.length === 0) {
    throw { code: AUTH_USER_NOT_FOUND }
  }

  const user = userResult[0] as {
    id: string
    email: string
    name: string
    org_id: string
    role: string
    is_active: boolean
  }

  if (!user.is_active) {
    throw { code: AUTH_USER_INACTIVE }
  }

  // 生成新 Token
  const tokenPayload = {
    userId: user.id,
    orgId: user.org_id,
    role: user.role,
    permissions: getPermissionsByRole(user.role),
  }

  const newToken = generateAccessToken(tokenPayload)
  const newRefreshToken = generateRefreshToken(tokenPayload)
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000).toISOString()

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      orgId: user.org_id,
      role: user.role,
    },
    token: newToken,
    refreshToken: newRefreshToken,
    expiresAt,
  }
}

/**
 * 登出 (可选: 将 Token 加入黑名单)
 * 目前为简单实现，客户端直接删除 Token 即可
 */
export async function logout(userId: string): Promise<void> {
  // TODO: 如需实现 Token 黑名单，可在此处将 Token 加入 Redis 黑名单
  console.log(`[Auth] 用户 ${userId} 已登出`)
}
