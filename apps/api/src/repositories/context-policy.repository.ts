import { sql } from '../lib/db'

export type ContextPolicyDocType = 'gene' | 'agents' | 'tools'

export interface ContextPolicyDocRow {
  id: string
  org_id: string
  doc_type: ContextPolicyDocType
  version: string
  status: 'draft' | 'review_required' | 'approved' | 'archived'
  content: string
  source_candidate_id: string | null
  change_note: string | null
  last_reviewed_by: string | null
  last_reviewed_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
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

function toVersionNumber(version: string | null | undefined): number {
  const raw = String(version || '').trim()
  const match = /^v(\d+)$/i.exec(raw)
  if (!match) return 0
  return Number.parseInt(match[1], 10) || 0
}

function toVersionLabel(versionNumber: number): string {
  return `v${Math.max(1, versionNumber)}`
}

export async function listLatestApprovedByOrg(orgId: string): Promise<ContextPolicyDocRow[]> {
  const rows = await sql<ContextPolicyDocRow[]>`
    SELECT DISTINCT ON (doc_type) *
    FROM context_policy_docs
    WHERE org_id = ${orgId}
      AND status = 'approved'
      AND deleted_at IS NULL
    ORDER BY doc_type, created_at DESC
  `
  return rows
}

export async function findLatestApprovedByOrgAndType(
  orgId: string,
  docType: ContextPolicyDocType
): Promise<ContextPolicyDocRow | null> {
  const rows = await sql<ContextPolicyDocRow[]>`
    SELECT *
    FROM context_policy_docs
    WHERE org_id = ${orgId}
      AND doc_type = ${docType}
      AND status = 'approved'
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function listByOrgAndType(
  orgId: string,
  docType: ContextPolicyDocType,
  limit = 20
): Promise<ContextPolicyDocRow[]> {
  const actualLimit = Math.max(1, Math.min(limit, 100))
  return sql<ContextPolicyDocRow[]>`
    SELECT *
    FROM context_policy_docs
    WHERE org_id = ${orgId}
      AND doc_type = ${docType}
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${actualLimit}
  `
}

export async function createApprovedVersion(params: {
  orgId: string
  docType: ContextPolicyDocType
  content: string
  reviewedBy?: string
  changeNote?: string
}): Promise<ContextPolicyDocRow> {
  await ensureOrganizationExists(params.orgId, params.reviewedBy)
  const reviewedBy = await resolveExistingUserId(params.reviewedBy)
  const latest = await findLatestApprovedByOrgAndType(params.orgId, params.docType)
  const nextVersion = toVersionLabel(toVersionNumber(latest?.version) + 1)

  const rows = await sql<ContextPolicyDocRow[]>`
    INSERT INTO context_policy_docs (
      org_id, doc_type, version, status, content, change_note, last_reviewed_by, last_reviewed_at
    )
    VALUES (
      ${params.orgId},
      ${params.docType},
      ${nextVersion},
      'approved',
      ${params.content},
      ${params.changeNote ?? null},
      ${reviewedBy},
      NOW()
    )
    RETURNING *
  `
  return rows[0]
}

export async function findByOrgTypeAndVersion(
  orgId: string,
  docType: ContextPolicyDocType,
  version: string
): Promise<ContextPolicyDocRow | null> {
  const rows = await sql<ContextPolicyDocRow[]>`
    SELECT *
    FROM context_policy_docs
    WHERE org_id = ${orgId}
      AND doc_type = ${docType}
      AND version = ${version}
      AND deleted_at IS NULL
    LIMIT 1
  `
  return rows[0] ?? null
}
