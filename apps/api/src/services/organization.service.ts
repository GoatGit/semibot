/**
 * Organization 服务
 *
 * 处理组织信息和成员管理
 */

import { sql } from '../lib/db'
import { AUTH_ORG_NOT_FOUND, AUTH_PERMISSION_DENIED } from '../constants/errorCodes'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Organization {
  id: string
  name: string
  slug: string
  plan: string
  quota: Record<string, unknown>
  settings: Record<string, unknown>
  ownerId: string
  isActive: boolean
  createdAt: string
}

export interface OrganizationMember {
  id: string
  email: string
  name: string
  role: string
  joinedAt: string
  lastLoginAt: string | null
}

export interface UpdateOrgInput {
  name?: string
  settings?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 获取当前组织信息
 */
export async function getCurrentOrganization(orgId: string): Promise<Organization> {
  const result = await sql`
    SELECT
      id, name, slug, plan, quota, settings,
      owner_id, is_active, created_at
    FROM organizations
    WHERE id = ${orgId}
  `

  if (result.length === 0) {
    throw { code: AUTH_ORG_NOT_FOUND }
  }

  const org = result[0] as {
    id: string
    name: string
    slug: string
    plan: string
    quota: Record<string, unknown>
    settings: Record<string, unknown>
    owner_id: string
    is_active: boolean
    created_at: string
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    quota: org.quota,
    settings: org.settings,
    ownerId: org.owner_id,
    isActive: org.is_active,
    createdAt: org.created_at,
  }
}

/**
 * 更新组织信息
 */
export async function updateOrganization(
  orgId: string,
  _userId: string,
  userRole: string,
  input: UpdateOrgInput
): Promise<Organization> {
  // 只有 owner 和 admin 可以更新组织信息
  if (userRole !== 'owner' && userRole !== 'admin') {
    throw { code: AUTH_PERMISSION_DENIED }
  }

  if (input.name === undefined && input.settings === undefined) {
    return getCurrentOrganization(orgId)
  }

  // 分别更新字段
  if (input.name !== undefined && input.settings !== undefined) {
    await sql`
      UPDATE organizations
      SET name = ${input.name}, settings = ${JSON.stringify(input.settings)}, updated_at = NOW()
      WHERE id = ${orgId}
    `
  } else if (input.name !== undefined) {
    await sql`
      UPDATE organizations
      SET name = ${input.name}, updated_at = NOW()
      WHERE id = ${orgId}
    `
  } else if (input.settings !== undefined) {
    await sql`
      UPDATE organizations
      SET settings = ${JSON.stringify(input.settings)}, updated_at = NOW()
      WHERE id = ${orgId}
    `
  }

  return getCurrentOrganization(orgId)
}

/**
 * 获取组织成员列表
 */
export async function getOrganizationMembers(
  orgId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ members: OrganizationMember[]; nextCursor?: string }> {
  const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

  let members: Array<{
    id: string
    email: string
    name: string
    role: string
    joined_at: string
    last_login_at: string | null
  }>

  if (options.cursor) {
    const result = await sql`
      SELECT
        id, email, name, role,
        created_at as joined_at, last_login_at
      FROM users
      WHERE org_id = ${orgId} AND is_active = true
        AND id > ${options.cursor}
      ORDER BY id ASC
      LIMIT ${limit + 1}
    `
    members = result as unknown as typeof members
  } else {
    const result = await sql`
      SELECT
        id, email, name, role,
        created_at as joined_at, last_login_at
      FROM users
      WHERE org_id = ${orgId} AND is_active = true
      ORDER BY id ASC
      LIMIT ${limit + 1}
    `
    members = result as unknown as typeof members
  }

  const hasMore = members.length > limit
  const resultMembers = hasMore ? members.slice(0, limit) : members

  return {
    members: resultMembers.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      joinedAt: m.joined_at,
      lastLoginAt: m.last_login_at,
    })),
    nextCursor: hasMore ? resultMembers[resultMembers.length - 1].id : undefined,
  }
}
