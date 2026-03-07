import { runtimeRequest } from './runtime-client'

export type RuntimeLlmProviderConfig = {
  display_name?: string
  api_key?: string
  base_url?: string
}

export type RuntimeLlmConfig = {
  default_model: string
  default_provider_key: string
  fallback_model: string
  fallback_provider_key: string
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

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  kimi: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.chat/v1',
  xai: 'https://api.x.ai/v1',
  custom: '',
}

export async function getRuntimeLlmConfig(): Promise<RuntimeLlmConfig> {
  const response = await runtimeRequest<{ data?: RuntimeLlmConfig }>('/v1/config/llm')
  return response.data || {
    default_model: '',
    default_provider_key: '',
    fallback_model: '',
    fallback_provider_key: '',
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
    providers: {},
  }
}

export function applyRuntimeLlmConfigToProcessEnv(config: RuntimeLlmConfig): void {
  process.env.DEFAULT_LLM_MODEL = config.default_model || ''
  process.env.DEFAULT_LLM_PROVIDER_KEY = config.default_provider_key || ''
  process.env.FALLBACK_LLM_MODEL = config.fallback_model || ''
  process.env.FALLBACK_LLM_PROVIDER_KEY = config.fallback_provider_key || ''

  for (const [providerKey, rawItem] of Object.entries(config.providers || {})) {
    const item = rawItem || {}
    if (!providerKey.includes(':')) {
      const envPrefix = providerKey.toUpperCase()
      process.env[`${envPrefix}_API_KEY`] = item.api_key || ''
      process.env[`${envPrefix}_API_BASE_URL`] = item.base_url || DEFAULT_BASE_URLS[providerKey] || ''
    }
  }

  const instances = Object.entries(config.providers || {})
    .filter(([providerKey]) => providerKey.includes(':'))
    .map(([providerKey, rawItem]) => {
      const [type, id] = providerKey.split(':', 2)
      const item = rawItem || {}
      return {
        type,
        id,
        ...(item.display_name ? { displayName: item.display_name } : {}),
        ...(item.api_key ? { apiKey: item.api_key } : {}),
        ...(item.base_url ? { baseUrl: item.base_url } : {}),
      }
    })
    .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))

  process.env.LLM_PROVIDER_INSTANCES = instances.length > 0 ? JSON.stringify(instances) : ''
  const legacyCustom = instances
    .filter((item) => item.type === 'custom')
    .map(({ id, displayName, apiKey, baseUrl }) => ({
      id,
      ...(displayName ? { displayName } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }))
  process.env.CUSTOM_LLM_PROVIDERS = legacyCustom.length > 0 ? JSON.stringify(legacyCustom) : ''
}

export async function syncRuntimeLlmConfigToProcessEnv(): Promise<RuntimeLlmConfig> {
  const config = await getRuntimeLlmConfig()
  applyRuntimeLlmConfigToProcessEnv(config)
  return config
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
