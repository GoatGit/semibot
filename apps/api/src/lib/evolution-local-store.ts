/**
 * Evolution Capabilities SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export interface LocalEvolutionCapabilityRow {
  id: string
  org_id: string
  agent_id: string
  capability_type: string
  data: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToCap(row: Record<string, unknown>): LocalEvolutionCapabilityRow {
  return {
    id: row.id as string,
    org_id: 'local',
    agent_id: row.agent_id as string,
    capability_type: row.capability_type as string,
    data: JSON.parse((row.data_json as string) ?? '{}'),
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export function localUpsertEvolutionCapability(data: {
  agentId: string
  capabilityType: string
  data: Record<string, unknown>
}): LocalEvolutionCapabilityRow {
  const db = getLocalDb()
  const now = nowIso()
  const existing = db.prepare(
    'SELECT * FROM evolution_capabilities WHERE agent_id = ? AND capability_type = ?'
  ).get(data.agentId, data.capabilityType) as Record<string, unknown> | undefined

  if (existing) {
    db.prepare('UPDATE evolution_capabilities SET data_json = ?, is_active = 1, updated_at = ? WHERE id = ?').run(
      JSON.stringify(data.data), now, existing.id
    )
    return rowToCap(db.prepare('SELECT * FROM evolution_capabilities WHERE id = ?').get(existing.id) as Record<string, unknown>)
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO evolution_capabilities (id, agent_id, capability_type, data_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, data.agentId, data.capabilityType, JSON.stringify(data.data), now, now)
  return rowToCap(db.prepare('SELECT * FROM evolution_capabilities WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindEvolutionCapabilitiesByAgent(agentId: string): LocalEvolutionCapabilityRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM evolution_capabilities WHERE agent_id = ? AND is_active = 1 ORDER BY created_at DESC'
  ).all(agentId)
  return rows.map((r) => rowToCap(r as Record<string, unknown>))
}

export function localFindEvolutionCapabilityByType(agentId: string, capabilityType: string): LocalEvolutionCapabilityRow | null {
  const row = getLocalDb().prepare(
    'SELECT * FROM evolution_capabilities WHERE agent_id = ? AND capability_type = ? AND is_active = 1'
  ).get(agentId, capabilityType)
  return row ? rowToCap(row as Record<string, unknown>) : null
}

export function localDeactivateEvolutionCapability(agentId: string, capabilityType: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE evolution_capabilities SET is_active = 0, updated_at = ? WHERE agent_id = ? AND capability_type = ?'
  ).run(nowIso(), agentId, capabilityType)
  return (result.changes ?? 0) > 0
}

// ─── Evolution Capability Versions & Releases ─────────────────
// These mirror the DB schema used by evolution-capability.service.ts

export type EvolutionCapabilityType = 'hands' | 'reflex' | 'spine' | 'guard' | 'mind'

export interface CapabilityVersionRow {
  id: string
  org_id: string
  capability_type: EvolutionCapabilityType
  version: string
  content_text: string
  checksum: string
  created_by: string | null
  created_at: string
}

export interface CapabilityReleaseRow {
  id: string
  org_id: string
  capability_type: EvolutionCapabilityType
  from_version: string | null
  to_version: string
  action: 'create_version' | 'switch_version' | 'rollback_version'
  operator_id: string | null
  change_note: string | null
  metrics_snapshot_json: Record<string, unknown>
  created_at: string
}

// In-memory store for capability versions/releases (lightweight, rarely changes)
const _versions: CapabilityVersionRow[] = []
const _releases: CapabilityReleaseRow[] = []

export async function localCreateVersion(data: {
  capabilityType: EvolutionCapabilityType
  version: string
  content: string
  checksum: string
  createdBy?: string
}): Promise<CapabilityVersionRow> {
  const row: CapabilityVersionRow = {
    id: randomUUID(),
    org_id: 'local',
    capability_type: data.capabilityType,
    version: data.version,
    content_text: data.content,
    checksum: data.checksum,
    created_by: data.createdBy ?? null,
    created_at: nowIso(),
  }
  _versions.push(row)
  return row
}

export async function localCreateRelease(data: {
  capabilityType: EvolutionCapabilityType
  fromVersion: string | null
  toVersion: string
  action: 'create_version' | 'switch_version' | 'rollback_version'
  operatorId?: string
  changeNote?: string
}): Promise<CapabilityReleaseRow> {
  const row: CapabilityReleaseRow = {
    id: randomUUID(),
    org_id: 'local',
    capability_type: data.capabilityType,
    from_version: data.fromVersion,
    to_version: data.toVersion,
    action: data.action,
    operator_id: data.operatorId ?? null,
    change_note: data.changeNote ?? null,
    metrics_snapshot_json: {},
    created_at: nowIso(),
  }
  _releases.push(row)
  return row
}

export async function localListLatestVersionsByOrg(): Promise<CapabilityVersionRow[]> {
  const byType = new Map<string, CapabilityVersionRow>()
  for (const v of _versions.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!byType.has(v.capability_type)) byType.set(v.capability_type, v)
  }
  return Array.from(byType.values())
}

export async function localListLatestReleasesByOrg(): Promise<CapabilityReleaseRow[]> {
  const byType = new Map<string, CapabilityReleaseRow>()
  for (const r of _releases.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!byType.has(r.capability_type)) byType.set(r.capability_type, r)
  }
  return Array.from(byType.values())
}

export async function localFindLatestReleaseByOrgAndType(capabilityType: EvolutionCapabilityType): Promise<CapabilityReleaseRow | null> {
  const rows = _releases.filter((r) => r.capability_type === capabilityType).sort((a, b) => b.created_at.localeCompare(a.created_at))
  return rows[0] ?? null
}

export async function localListVersions(capabilityType: EvolutionCapabilityType, limit = 20): Promise<CapabilityVersionRow[]> {
  return _versions.filter((v) => v.capability_type === capabilityType).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
}

export async function localFindVersion(capabilityType: EvolutionCapabilityType, version: string): Promise<CapabilityVersionRow | null> {
  return _versions.find((v) => v.capability_type === capabilityType && v.version === version) ?? null
}
