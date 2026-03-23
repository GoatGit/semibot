import { runtimeRequest } from './runtime-client'

export type RuntimeLlmProviderConfig = {
  display_name?: string
  api_key?: string
  base_url?: string
}

export type RuntimeNodeModelConfig = {
  model?: string
  temperature?: number
}

export type RuntimeModelRolesConfig = {
  plan?: RuntimeNodeModelConfig
  act?: RuntimeNodeModelConfig
  textProcessing?: RuntimeNodeModelConfig
  text_processing?: RuntimeNodeModelConfig
}

export type RuntimeLlmConfig = {
  default_model: string
  default_provider_key: string
  fallback_model: string
  fallback_provider_key: string
  model_roles?: RuntimeModelRolesConfig
  providers: Record<string, RuntimeLlmProviderConfig>
  updated_at?: string | null
}

export type RuntimeAgentProfile = {
  id: string
  name: string
  description?: string | null
  system_prompt?: string | null
  model?: string | null
  temperature: number
  max_tokens: number
  metadata?: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export async function getRuntimeLlmConfig(): Promise<RuntimeLlmConfig> {
  const response = await runtimeRequest<{ data?: RuntimeLlmConfig }>('/v1/config/llm')
  return response.data || {
    default_model: '',
    default_provider_key: '',
    fallback_model: '',
    fallback_provider_key: '',
    model_roles: {},
    providers: {},
  }
}

export async function updateRuntimeLlmConfig(payload: Partial<RuntimeLlmConfig>): Promise<RuntimeLlmConfig> {
  const response = await runtimeRequest<{ data?: RuntimeLlmConfig }>('/v1/config/llm', {
    method: 'PUT',
    body: payload,
    timeoutMs: 5000,
  })
  return response.data || {
    default_model: '',
    default_provider_key: '',
    fallback_model: '',
    fallback_provider_key: '',
    model_roles: {},
    providers: {},
  }
}

export async function listRuntimeAgentProfiles(includeInactive = true): Promise<RuntimeAgentProfile[]> {
  const response = await runtimeRequest<{ items?: RuntimeAgentProfile[] }>('/v1/config/agents', {
    query: { include_inactive: includeInactive },
    timeoutMs: 5000,
  })
  return Array.isArray(response.items) ? response.items : []
}

export async function getRuntimeAgentProfile(agentId: string): Promise<RuntimeAgentProfile | null> {
  try {
    const response = await runtimeRequest<{ item?: RuntimeAgentProfile }>(`/v1/config/agents/${agentId}`, {
      timeoutMs: 5000,
    })
    return response.item || null
  } catch {
    return null
  }
}

export async function createRuntimeAgentProfile(payload: Record<string, unknown>): Promise<RuntimeAgentProfile> {
  const response = await runtimeRequest<{ item: RuntimeAgentProfile }>('/v1/config/agents', {
    method: 'POST',
    body: payload,
    timeoutMs: 5000,
  })
  return response.item
}

export async function updateRuntimeAgentProfile(
  agentId: string,
  payload: Record<string, unknown>
): Promise<RuntimeAgentProfile | null> {
  try {
    const response = await runtimeRequest<{ item?: RuntimeAgentProfile }>(`/v1/config/agents/${agentId}`, {
      method: 'PUT',
      body: payload,
      timeoutMs: 5000,
    })
    return response.item || null
  } catch {
    return null
  }
}

export async function deleteRuntimeAgentProfile(agentId: string): Promise<boolean> {
  try {
    await runtimeRequest(`/v1/config/agents/${agentId}`, {
      method: 'DELETE',
      timeoutMs: 5000,
    })
    return true
  } catch {
    return false
  }
}
