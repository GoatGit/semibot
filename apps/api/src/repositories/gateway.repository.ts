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
  instanceKey?: string
  provider: GatewayProvider
  displayName: string
  isDefault?: boolean
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

type RuntimeGatewayRow = {
  id?: string
  instanceKey?: string
  provider?: string
  displayName?: string
  isDefault?: boolean
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
    instanceKey: item.instanceKey ? String(item.instanceKey) : undefined,
    provider,
    displayName: String(item.displayName || provider),
    isDefault: item.isDefault === true,
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

export async function listGatewayInstances(provider?: GatewayProvider): Promise<GatewayRow[]> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  const response = await runtimeRequest<{ data: RuntimeGatewayRow[] }>(`/v1/config/gateway-instances${query}`, {
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

export async function findByInstanceId(instanceId: string): Promise<GatewayRow | null> {
  try {
    const item = await runtimeRequest<RuntimeGatewayRow>(`/v1/config/gateway-instances/${instanceId}`, {
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

export async function createInstance(
  data: UpdateGatewayData & { provider: GatewayProvider; instanceKey?: string; isDefault?: boolean }
): Promise<GatewayRow | null> {
  try {
    const item = await runtimeRequest<RuntimeGatewayRow>('/v1/config/gateway-instances', {
      method: 'POST',
      body: {
        provider: data.provider,
        instanceKey: data.instanceKey,
        isDefault: data.isDefault,
        displayName: data.displayName,
        isActive: data.isActive,
        mode: data.mode,
        riskLevel: data.riskLevel,
        requiresApproval: data.requiresApproval,
        config: data.config,
        addressingPolicy: data.addressingPolicy,
        proactivePolicy: data.proactivePolicy,
        contextPolicy: data.contextPolicy,
      },
      timeoutMs: 3000,
    })
    return toGatewayRow(item)
  } catch {
    return null
  }
}

export async function updateByInstanceId(instanceId: string, data: UpdateGatewayData): Promise<GatewayRow | null> {
  try {
    const item = await runtimeRequest<RuntimeGatewayRow>(`/v1/config/gateway-instances/${instanceId}`, {
      method: 'PUT',
      body: {
        displayName: data.displayName,
        isActive: data.isActive,
        isDefault: data.isDefault,
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

export async function deleteByInstanceId(instanceId: string): Promise<boolean> {
  try {
    const result = await runtimeRequest<{ deleted: boolean }>(`/v1/config/gateway-instances/${instanceId}`, {
      method: 'DELETE',
      timeoutMs: 3000,
    })
    return result.deleted === true
  } catch {
    return false
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

export async function testByInstanceId(
  instanceId: string,
  payload: Record<string, unknown>
): Promise<{ sent: boolean }> {
  return runtimeRequest<{ sent: boolean }>(`/v1/config/gateway-instances/${instanceId}/test`, {
    method: 'POST',
    body: payload,
    timeoutMs: 5000,
  })
}
