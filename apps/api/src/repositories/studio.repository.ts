/**
 * Studio Repository
 */

import * as store from '../lib/studio-local-store'
import type { AgentNode, StudioEdge, StudioStatus, NodeResult } from '@semibot/shared-types'

export type { LocalStudioRow as StudioRow, LocalStudioRunRow as StudioRunRow } from '../lib/studio-local-store'

export interface CreateStudioData {
  name: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
}

export interface UpdateStudioData {
  name?: string
  description?: string
  nodes?: AgentNode[]
  edges?: StudioEdge[]
  isActive?: boolean
}

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export async function create(data: CreateStudioData): Promise<store.LocalStudioRow> {
  return store.localCreateStudio(data)
}

export async function findById(id: string): Promise<store.LocalStudioRow | null> {
  return store.localFindStudioById(id)
}

export async function findAll(params: { page?: number; limit?: number; search?: string }): Promise<PaginatedResult<store.LocalStudioRow>> {
  return store.localFindStudios(params)
}

export async function update(id: string, data: UpdateStudioData): Promise<store.LocalStudioRow | null> {
  return store.localUpdateStudio(id, data)
}

export async function softDelete(id: string): Promise<boolean> {
  return store.localSoftDeleteStudio(id)
}

// ─── Run ──────────────────────────────────────────────────────

export async function createRun(studioId: string, inputs: Record<string, unknown>): Promise<store.LocalStudioRunRow> {
  return store.localCreateStudioRun(studioId, inputs)
}

export async function findRunById(id: string): Promise<store.LocalStudioRunRow | null> {
  return store.localFindStudioRunById(id)
}

export async function findRuns(studioId: string, params: { page?: number; limit?: number }): Promise<PaginatedResult<store.LocalStudioRunRow>> {
  return store.localFindStudioRuns(studioId, params)
}

export async function updateRunStatus(id: string, status: StudioStatus, error?: string): Promise<void> {
  store.localUpdateStudioRunStatus(id, status, error)
}

export async function updateRunCurrentNode(id: string, nodeId: string): Promise<void> {
  store.localUpdateStudioRunCurrentNode(id, nodeId)
}

export async function saveNodeResult(runId: string, nodeId: string, result: NodeResult): Promise<void> {
  store.localSaveNodeResult(runId, nodeId, result)
}
