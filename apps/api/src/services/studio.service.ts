/**
 * Studio Service — CRUD 业务逻辑
 */

import { createError } from '../middleware/errorHandler'
import * as studioRepo from '../repositories/studio.repository'
import { createLogger } from '../lib/logger'
import { RESOURCE_NOT_FOUND, RESOURCE_CONFLICT } from '../constants/errorCodes'
import type { Studio, StudioRun, CreateStudioInput, UpdateStudioInput } from '@semibot/shared-types'

const logger = createLogger('studio')

function rowToStudio(row: studioRepo.StudioRow): Studio {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    nodes: row.nodes,
    edges: row.edges,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: studioRepo.StudioRunRow): StudioRun {
  return {
    id: row.id,
    studioId: row.studio_id,
    status: row.status,
    inputs: row.inputs,
    currentNodeId: row.current_node_id ?? undefined,
    nodeResults: row.node_results,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  }
}

export async function createStudio(data: CreateStudioInput): Promise<Studio> {
  const row = await studioRepo.create(data)
  logger.info('Studio 已创建', { id: row.id })
  return rowToStudio(row)
}

export async function getStudio(id: string): Promise<Studio> {
  const row = await studioRepo.findById(id)
  if (!row) throw createError(RESOURCE_NOT_FOUND, 'Studio 不存在')
  return rowToStudio(row)
}

export async function listStudios(params: { page?: number; limit?: number; search?: string }) {
  const result = await studioRepo.findAll(params)
  return {
    data: result.data.map(rowToStudio),
    meta: result.meta,
  }
}

export async function updateStudio(id: string, data: UpdateStudioInput): Promise<Studio> {
  const row = await studioRepo.update(id, data)
  if (!row) throw createError(RESOURCE_NOT_FOUND, 'Studio 不存在')
  return rowToStudio(row)
}

export async function deleteStudio(id: string): Promise<void> {
  const deleted = await studioRepo.softDelete(id)
  if (!deleted) throw createError(RESOURCE_NOT_FOUND, 'Studio 不存在')
}

export async function getStudioRun(studioId: string, runId: string): Promise<StudioRun> {
  const row = await studioRepo.findRunById(runId)
  if (!row || row.studio_id !== studioId) throw createError(RESOURCE_NOT_FOUND, 'Run 不存在')
  return rowToRun(row)
}

export async function listStudioRuns(studioId: string, params: { page?: number; limit?: number }) {
  const result = await studioRepo.findRuns(studioId, params)
  return {
    data: result.data.map(rowToRun),
    meta: result.meta,
  }
}

export async function cancelStudioRun(studioId: string, runId: string): Promise<void> {
  const row = await studioRepo.findRunById(runId)
  if (!row || row.studio_id !== studioId) throw createError(RESOURCE_NOT_FOUND, 'Run 不存在')
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    throw createError(RESOURCE_CONFLICT, 'Run 已结束，无法取消')
  }
  await studioRepo.updateRunStatus(runId, 'cancelled')
}
