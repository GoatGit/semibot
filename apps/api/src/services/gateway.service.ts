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

export async function listGateways(): Promise<Gateway[]> {
  return gatewayRepository.listGateways()
}

export async function getGateway(provider: GatewayProvider): Promise<Gateway> {
  const row = await gatewayRepository.findByProvider(provider)
  if (!row) {
    throw createError(RESOURCE_NOT_FOUND, `Gateway not found: ${provider}`)
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

export async function testGateway(
  provider: GatewayProvider,
  payload: Record<string, unknown>
): Promise<{ sent: boolean }> {
  return gatewayRepository.testByProvider(provider, payload)
}
