/**
 * LLM Provider/Model SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export interface LocalLLMProviderRow {
  id: string
  name: string
  provider_type: string
  endpoint: string | null
  config: Record<string, unknown>
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LocalLLMModelRow {
  id: string
  provider_id: string
  model_id: string
  display_name: string | null
  capabilities: string[]
  context_window: number | null
  max_output_tokens: number | null
  input_price_per_1k: string | null
  output_price_per_1k: string | null
  config: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LocalLLMModelWithProvider extends LocalLLMModelRow {
  provider_name: string
  provider_type: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToProvider(row: Record<string, unknown>): LocalLLMProviderRow {
  return {
    id: row.id as string,
    name: row.name as string,
    provider_type: row.provider_type as string,
    endpoint: (row.endpoint as string) ?? null,
    config: JSON.parse((row.config_json as string) ?? '{}'),
    is_default: (row.is_default as number) === 1,
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

function rowToModel(row: Record<string, unknown>): LocalLLMModelRow {
  return {
    id: row.id as string,
    provider_id: row.provider_id as string,
    model_id: row.model_id as string,
    display_name: (row.display_name as string) ?? null,
    capabilities: JSON.parse((row.capabilities_json as string) ?? '["chat"]'),
    context_window: (row.context_window as number) ?? null,
    max_output_tokens: (row.max_output_tokens as number) ?? null,
    input_price_per_1k: (row.input_price_per_1k as string) ?? null,
    output_price_per_1k: (row.output_price_per_1k as string) ?? null,
    config: JSON.parse((row.config_json as string) ?? '{}'),
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

function ensureDefaultProvider(): void {
  // No-op: LLM config is managed via runtime SQLite DB, not env vars or local store.
}

export function localFindProvidersByOrg(): LocalLLMProviderRow[] {
  ensureDefaultProvider()
  const rows = getLocalDb().prepare('SELECT * FROM llm_providers WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all()
  return rows.map((r) => rowToProvider(r as Record<string, unknown>))
}

export function localFindSystemProviders(): LocalLLMProviderRow[] {
  return localFindProvidersByOrg()
}

export function localFindProviderById(id: string): LocalLLMProviderRow | null {
  ensureDefaultProvider()
  const row = getLocalDb().prepare('SELECT * FROM llm_providers WHERE id = ?').get(id)
  return row ? rowToProvider(row as Record<string, unknown>) : null
}

export function localFindModelsByOrg(): LocalLLMModelWithProvider[] {
  ensureDefaultProvider()
  const rows = getLocalDb().prepare(`
    SELECT m.*, p.name as provider_name, p.provider_type as p_type
    FROM llm_models m JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.is_active = 1 AND p.is_active = 1
    ORDER BY p.name ASC, m.display_name ASC
  `).all()
  return rows.map((r) => {
    const row = r as Record<string, unknown>
    return { ...rowToModel(row), provider_name: row.provider_name as string, provider_type: row.p_type as string }
  })
}

export function localFindSystemModels(): LocalLLMModelWithProvider[] {
  return localFindModelsByOrg()
}

export function localFindModelsByProvider(providerId: string): LocalLLMModelRow[] {
  const rows = getLocalDb().prepare('SELECT * FROM llm_models WHERE provider_id = ? AND is_active = 1 ORDER BY display_name ASC').all(providerId)
  return rows.map((r) => rowToModel(r as Record<string, unknown>))
}

export function localFindModelById(id: string): LocalLLMModelWithProvider | null {
  const row = getLocalDb().prepare(`
    SELECT m.*, p.name as provider_name, p.provider_type as p_type
    FROM llm_models m JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.id = ?
  `).get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return { ...rowToModel(row), provider_name: row.provider_name as string, provider_type: row.p_type as string }
}

export function localFindModelByModelId(modelId: string): LocalLLMModelWithProvider | null {
  const row = getLocalDb().prepare(`
    SELECT m.*, p.name as provider_name, p.provider_type as p_type
    FROM llm_models m JOIN llm_providers p ON m.provider_id = p.id
    WHERE m.model_id = ? AND m.is_active = 1 AND p.is_active = 1
    LIMIT 1
  `).get(modelId) as Record<string, unknown> | undefined
  if (!row) return null
  return { ...rowToModel(row), provider_name: row.provider_name as string, provider_type: row.p_type as string }
}

export function localFindModelsByCapability(capability: string): LocalLLMModelWithProvider[] {
  return localFindModelsByOrg().filter((m) => m.capabilities.includes(capability))
}

export function localUpsertProvider(data: {
  id?: string
  name: string
  providerType: string
  endpoint?: string
  config: Record<string, unknown>
  isDefault?: boolean
}): LocalLLMProviderRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = data.id ?? randomUUID()
  db.prepare(`
    INSERT INTO llm_providers (id, name, provider_type, endpoint, config_json, is_default, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider_type=excluded.provider_type,
      endpoint=excluded.endpoint, config_json=excluded.config_json, is_default=excluded.is_default, updated_at=excluded.updated_at
  `).run(id, data.name, data.providerType, data.endpoint ?? null, JSON.stringify(data.config), data.isDefault ? 1 : 0, now, now)
  return rowToProvider(db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localUpsertModel(data: {
  id?: string
  providerId: string
  modelId: string
  displayName?: string
  capabilities?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  config?: Record<string, unknown>
}): LocalLLMModelRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = data.id ?? randomUUID()
  db.prepare(`
    INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities_json, context_window, max_output_tokens, config_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET model_id=excluded.model_id, display_name=excluded.display_name,
      capabilities_json=excluded.capabilities_json, context_window=excluded.context_window,
      max_output_tokens=excluded.max_output_tokens, config_json=excluded.config_json, updated_at=excluded.updated_at
  `).run(
    id, data.providerId, data.modelId, data.displayName ?? data.modelId,
    JSON.stringify(data.capabilities ?? ['chat']),
    data.contextWindow ?? null, data.maxOutputTokens ?? null,
    JSON.stringify(data.config ?? {}), now, now
  )
  return rowToModel(db.prepare('SELECT * FROM llm_models WHERE id = ?').get(id) as Record<string, unknown>)
}
