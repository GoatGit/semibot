/**
 * Gateway 服务层
 */

import { createError } from '../middleware/errorHandler'
import { RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as gatewayRepository from '../repositories/gateway.repository'

export type GatewayProvider = gatewayRepository.GatewayProvider
export type Gateway = gatewayRepository.GatewayRow

export interface UpdateGatewayInput {
  displayName?: string
  isDefault?: boolean
  isActive?: boolean
  mode?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  requiresApproval?: boolean
  config?: Record<string, unknown>
  addressingPolicy?: Record<string, unknown>
  proactivePolicy?: Record<string, unknown>
  contextPolicy?: Record<string, unknown>
  clearFields?: string[]
}

export interface GatewayBatchInput {
  action: 'enable' | 'disable' | 'delete'
  instanceIds: string[]
  ignoreMissing?: boolean
}

export interface GatewayBatchResult {
  action: GatewayBatchInput['action']
  requested: string[]
  targets: string[]
  changed: string[]
  unchanged: string[]
  blocked: Array<{ instanceId: string; reason: string }>
  missing: string[]
  failed: Array<{ instanceId: string; error: string }>
}

export async function listGateways(): Promise<Gateway[]> {
  return gatewayRepository.listGateways()
}

export async function listGatewayInstances(provider?: GatewayProvider): Promise<Gateway[]> {
  return gatewayRepository.listGatewayInstances(provider)
}

export async function getGateway(provider: GatewayProvider): Promise<Gateway> {
  const row = await gatewayRepository.findByProvider(provider)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway not found: ${provider}`)
  }
  return row
}

export async function getGatewayInstance(instanceId: string): Promise<Gateway> {
  const row = await gatewayRepository.findByInstanceId(instanceId)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway instance not found: ${instanceId}`)
  }
  return row
}

export async function updateGateway(
  provider: GatewayProvider,
  input: UpdateGatewayInput
): Promise<Gateway> {
  const row = await gatewayRepository.updateByProvider(provider, input)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway not found: ${provider}`)
  }
  return row
}

export async function createGatewayInstance(
  input: UpdateGatewayInput & { provider: GatewayProvider; instanceKey?: string }
): Promise<Gateway> {
  const row = await gatewayRepository.createInstance(input)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, 'Failed to create gateway instance')
  }
  return row
}

export async function updateGatewayInstance(
  instanceId: string,
  input: UpdateGatewayInput
): Promise<Gateway> {
  const row = await gatewayRepository.updateByInstanceId(instanceId, input)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway instance not found: ${instanceId}`)
  }
  return row
}

export async function deleteGatewayInstance(instanceId: string): Promise<{ deleted: boolean }> {
  const deleted = await gatewayRepository.deleteByInstanceId(instanceId)
  if (!deleted) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway instance not found: ${instanceId}`)
  }
  return { deleted: true }
}

export async function testGateway(
  provider: GatewayProvider,
  payload: Record<string, unknown>
): Promise<{ sent: boolean }> {
  return gatewayRepository.testByProvider(provider, payload)
}

export async function testGatewayInstance(
  instanceId: string,
  payload: Record<string, unknown>
): Promise<{ sent: boolean }> {
  return gatewayRepository.testByInstanceId(instanceId, payload)
}

export async function batchGatewayInstances(input: GatewayBatchInput): Promise<GatewayBatchResult> {
  const requested = Array.from(new Set(input.instanceIds.map((item) => item.trim()).filter(Boolean)))
  if (requested.length === 0) {
    return {
      action: input.action,
      requested: [],
      targets: [],
      changed: [],
      unchanged: [],
      blocked: [],
      missing: [],
      failed: [],
    }
  }

  const result = await gatewayRepository.batchByInstanceIds({
    action: input.action,
    instanceIds: requested,
    ignoreMissing: input.ignoreMissing,
  })
  if (result.missing?.length && !input.ignoreMissing) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway instance not found: ${result.missing[0]}`)
  }
  return result
}
