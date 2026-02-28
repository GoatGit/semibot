/**
 * Gateway Repository (runtime-backed)
 *
 * V2 single-machine mode:
 * - Gateway config is persisted by runtime in ~/.semibot/semibot.db
 * - API repository proxies CRUD to runtime /v1/config/gateways
 */

import { runtimeRequest } from '../lib/runtime-client'

export type GatewayProvider = 'feishu' | 'telegram'

export interface GatewayRow {
  id: string
  provider: GatewayProvider
  displayName: string
  isActive: boolean
  mode: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  requiresApproval: boolean
  status: 'ready' | 'disabled' | 'not_configured'
  config: Record<string, unknown>
  addressingPolicy?: Record<string, unknown>
  proactivePolicy?: Record<string, unknown>
  contextPolicy?: Record<string, unknown>
  updatedAt: string
}

export interface UpdateGatewayData {
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

type RuntimeGatewayRow = {
  id?: string
  provider?: string
  displayName?: string
  isActive?: boolean
  mode?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  requiresApproval?: boolean
  status?: 'ready' | 'disabled' | 'not_configured'
  config?: Record<string, unknown>
  addressingPolicy?: Record<string, unknown>
  proactivePolicy?: Record<string, unknown>
  contextPolicy?: Record<string, unknown>
  updatedAt?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function toGatewayRow(item: RuntimeGatewayRow): GatewayRow {
  const provider = String(item.provider || 'feishu') as GatewayProvider
  return {
    id: String(item.id || `gateway:${provider}`),
    provider,
    displayName: String(item.displayName || provider),
    isActive: item.isActive === true,
    mode: String(item.mode || 'webhook'),
    riskLevel: item.riskLevel || 'high',
    requiresApproval: item.requiresApproval === true,
    status: item.status || 'not_configured',
    config: item.config || {},
    addressingPolicy:
      item.addressingPolicy && typeof item.addressingPolicy === 'object' ? item.addressingPolicy : undefined,
    proactivePolicy:
      item.proactivePolicy && typeof item.proactivePolicy === 'object' ? item.proactivePolicy : undefined,
    contextPolicy: item.contextPolicy && typeof item.contextPolicy === 'object' ? item.contextPolicy : undefined,
    updatedAt: item.updatedAt || nowIso(),
  }
}

export async function listGateways(): Promise<GatewayRow[]> {
  const response = await runtimeRequest<{ data: RuntimeGatewayRow[] }>('/v1/config/gateways', {
    method: 'GET',
    timeoutMs: 2500,
  })
  return (response.data || []).map(toGatewayRow)
}

export async function findByProvider(provider: GatewayProvider): Promise<GatewayRow | null> {
  try {
    const item = await runtimeRequest<RuntimeGatewayRow>(`/v1/config/gateways/${provider}`, {
      method: 'GET',
      timeoutMs: 2500,
    })
    return toGatewayRow(item)
  } catch {
    return null
  }
}

export async function updateByProvider(
  provider: GatewayProvider,
  data: UpdateGatewayData
): Promise<GatewayRow | null> {
  try {
    const item = await runtimeRequest<RuntimeGatewayRow>(`/v1/config/gateways/${provider}`, {
      method: 'PUT',
      body: {
        displayName: data.displayName,
        isActive: data.isActive,
        mode: data.mode,
        riskLevel: data.riskLevel,
        requiresApproval: data.requiresApproval,
        config: data.config,
        addressingPolicy: data.addressingPolicy,
        proactivePolicy: data.proactivePolicy,
        contextPolicy: data.contextPolicy,
        clearFields: data.clearFields,
      },
      timeoutMs: 3000,
    })
    return toGatewayRow(item)
  } catch {
    return null
  }
}

export async function testByProvider(
  provider: GatewayProvider,
  payload: Record<string, unknown>
): Promise<{ sent: boolean }> {
  return runtimeRequest<{ sent: boolean }>(`/v1/config/gateways/${provider}/test`, {
    method: 'POST',
    body: payload,
    timeoutMs: 5000,
  })
}
