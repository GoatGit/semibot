import { sql } from '../lib/db'

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

function buildBootstrapOrgSlug(orgId: string): string {
  const raw = String(orgId || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = raw.slice(0, 12) || 'default'
  return `single-org-${suffix}`
}

async function ensureOrganizationExists(orgId: string, ownerId?: string): Promise<void> {
  const existing = await sql<Array<{ id: string }>>`
    SELECT id
    FROM organizations
    WHERE id = ${orgId}
    LIMIT 1
  `
  if (existing.length > 0) return

  const slug = buildBootstrapOrgSlug(orgId)
  await sql`
    INSERT INTO organizations (id, name, slug, owner_id, plan, is_active)
    VALUES (
      ${orgId},
      'Semibot Default Org',
      ${slug},
      ${ownerId ?? orgId},
      'enterprise',
      true
    )
    ON CONFLICT (id) DO NOTHING
  `
}

async function resolveExistingUserId(userId?: string): Promise<string | null> {
  if (!userId) return null
  const rows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

export async function listVersions(
  orgId: string,
  capabilityType: EvolutionCapabilityType,
  limit = 20
): Promise<CapabilityVersionRow[]> {
  const actualLimit = Math.max(1, Math.min(limit, 100))
  return sql<CapabilityVersionRow[]>`
    SELECT *
    FROM capability_versions
    WHERE org_id = ${orgId}
      AND capability_type = ${capabilityType}
    ORDER BY created_at DESC
    LIMIT ${actualLimit}
  `
}

export async function listLatestVersionsByOrg(orgId: string): Promise<CapabilityVersionRow[]> {
  return sql<CapabilityVersionRow[]>`
    SELECT DISTINCT ON (capability_type) *
    FROM capability_versions
    WHERE org_id = ${orgId}
    ORDER BY capability_type, created_at DESC
  `
}

export async function listLatestReleasesByOrg(orgId: string): Promise<CapabilityReleaseRow[]> {
  return sql<CapabilityReleaseRow[]>`
    SELECT DISTINCT ON (capability_type) *
    FROM capability_releases
    WHERE org_id = ${orgId}
    ORDER BY capability_type, created_at DESC
  `
}

export async function findLatestReleaseByOrgAndType(
  orgId: string,
  capabilityType: EvolutionCapabilityType
): Promise<CapabilityReleaseRow | null> {
  const rows = await sql<CapabilityReleaseRow[]>`
    SELECT *
    FROM capability_releases
    WHERE org_id = ${orgId}
      AND capability_type = ${capabilityType}
    ORDER BY created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function findVersion(
  orgId: string,
  capabilityType: EvolutionCapabilityType,
  version: string
): Promise<CapabilityVersionRow | null> {
  const rows = await sql<CapabilityVersionRow[]>`
    SELECT *
    FROM capability_versions
    WHERE org_id = ${orgId}
      AND capability_type = ${capabilityType}
      AND version = ${version}
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function createVersion(params: {
  orgId: string
  capabilityType: EvolutionCapabilityType
  version: string
  content: string
  checksum: string
  createdBy?: string
}): Promise<CapabilityVersionRow> {
  await ensureOrganizationExists(params.orgId, params.createdBy)
  const createdBy = await resolveExistingUserId(params.createdBy)
  const rows = await sql<CapabilityVersionRow[]>`
    INSERT INTO capability_versions (
      org_id, capability_type, version, content_text, checksum, created_by
    )
    VALUES (
      ${params.orgId},
      ${params.capabilityType},
      ${params.version},
      ${params.content},
      ${params.checksum},
      ${createdBy}
    )
    RETURNING *
  `
  return rows[0]
}

export async function createRelease(params: {
  orgId: string
  capabilityType: EvolutionCapabilityType
  fromVersion?: string | null
  toVersion: string
  action: 'create_version' | 'switch_version' | 'rollback_version'
  operatorId?: string
  changeNote?: string
  metricsSnapshot?: Record<string, unknown>
}): Promise<CapabilityReleaseRow> {
  await ensureOrganizationExists(params.orgId, params.operatorId)
  const operatorId = await resolveExistingUserId(params.operatorId)
  const rows = await sql<CapabilityReleaseRow[]>`
    INSERT INTO capability_releases (
      org_id, capability_type, from_version, to_version, action, operator_id, change_note, metrics_snapshot_json
    )
    VALUES (
      ${params.orgId},
      ${params.capabilityType},
      ${params.fromVersion ?? null},
      ${params.toVersion},
      ${params.action},
      ${operatorId},
      ${params.changeNote ?? null},
      ${JSON.stringify(params.metricsSnapshot ?? {})}::jsonb
    )
    RETURNING *
  `
  return rows[0]
}
