/**
 * Organization 服务
 *
 * 处理组织信息和成员管理
 * 单用户模式：数据持久化到 ~/.semibot/auth/auth.json
 */

import { AUTH_ORG_NOT_FOUND, AUTH_PERMISSION_DENIED } from '../constants/errorCodes'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import * as localStore from '../lib/auth-local-store'

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

export async function getOrgIdByUserId(userId: string): Promise<string> {
  const user = await localStore.localFindUserById(userId)
  if (!user) throw { code: AUTH_ORG_NOT_FOUND }
  return user.org_id
}

export async function getCurrentOrganization(orgId: string): Promise<Organization> {
  const org = await localStore.localFindOrgById(orgId)
  if (!org) throw { code: AUTH_ORG_NOT_FOUND }

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

export async function updateOrganization(
  orgId: string,
  _userId: string,
  userRole: string,
  input: UpdateOrgInput
): Promise<Organization> {
  if (userRole !== 'owner' && userRole !== 'admin') {
    throw { code: AUTH_PERMISSION_DENIED }
  }

  if (input.name === undefined && input.settings === undefined) {
    return getCurrentOrganization(orgId)
  }

  await localStore.localUpdateOrg(orgId, {
    name: input.name,
    settings: input.settings,
  })

  return getCurrentOrganization(orgId)
}

export async function getOrganizationMembers(
  orgId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ members: OrganizationMember[]; nextCursor?: string }> {
  const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

  let users = await localStore.localListUsersByOrg(orgId)
  users = users.sort((a, b) => a.id.localeCompare(b.id))

  if (options.cursor) {
    const idx = users.findIndex((u) => u.id === options.cursor)
    if (idx !== -1) users = users.slice(idx + 1)
  }

  const hasMore = users.length > limit
  const resultUsers = hasMore ? users.slice(0, limit) : users

  return {
    members: resultUsers.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      joinedAt: u.created_at,
      lastLoginAt: u.last_login_at,
    })),
    nextCursor: hasMore ? resultUsers[resultUsers.length - 1].id : undefined,
  }
}
