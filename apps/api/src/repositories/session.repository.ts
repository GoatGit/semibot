/**
 * Session Repository — 本地文件存储代理
 */

import * as local from '../lib/session-local-store'

export type { SessionStatus, LocalSessionRow as SessionRow } from '../lib/session-local-store'

export interface CreateSessionData {
  agentId: string
  userId: string
  title?: string
  metadata?: Record<string, unknown>
}

export interface ListSessionsParams {
  userId: string
  page?: number
  limit?: number
  agentId?: string
  status?: local.SessionStatus
}

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export async function create(data: CreateSessionData): Promise<local.LocalSessionRow> {
  return local.localCreateSession(data)
}

export async function findById(id: string): Promise<local.LocalSessionRow | null> {
  return local.localFindSessionById(id)
}

export async function findByIdAndOrg(id: string): Promise<local.LocalSessionRow | null> {
  return local.localFindSessionByIdAndOrg(id)
}

export async function findByUserAndOrg(params: ListSessionsParams): Promise<PaginatedResult<local.LocalSessionRow>> {
  return local.localFindSessionsByUserAndOrg(params)
}

export async function updateStatus(id: string, status: local.SessionStatus): Promise<local.LocalSessionRow | null> {
  return local.localUpdateSessionStatus(id, status)
}

export async function updateStatusIfActive(
  id: string,
  status: local.SessionStatus
): Promise<{ row: local.LocalSessionRow | null; alreadyEnded: boolean }> {
  return local.localUpdateSessionStatusIfActive(id, status)
}

export async function updateTitle(id: string, title: string): Promise<local.LocalSessionRow | null> {
  return local.localUpdateSessionTitle(id, title)
}

export async function updateFields(
  id: string,
  fields: { title?: string; status?: local.SessionStatus }
): Promise<local.LocalSessionRow | null> {
  return local.localUpdateSessionFields(id, fields)
}

export async function softDelete(id: string, deletedBy?: string): Promise<boolean> {
  return local.localSoftDeleteSession(id, deletedBy)
}
