/**
 * Context Policy SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export type ContextPolicyDocType = 'gene' | 'agents' | 'tools'

export interface LocalContextPolicyDocRow {
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

function nowIso(): string {
  return new Date().toISOString()
}

function toVersionNumber(version: string | null | undefined): number {
  const match = /^v(\d+)$/i.exec(String(version || '').trim())
  return match ? (parseInt(match[1], 10) || 0) : 0
}

function toVersionLabel(n: number): string {
  return `v${Math.max(1, n)}`
}

function rowToPolicy(row: Record<string, unknown>): LocalContextPolicyDocRow {
  return {
    id: row.id as string,
    org_id: (row.org_id as string) ?? 'local',
    doc_type: row.doc_type as ContextPolicyDocType,
    version: row.version as string,
    status: row.status as LocalContextPolicyDocRow['status'],
    content: row.content as string,
    source_candidate_id: (row.source_candidate_id as string) ?? null,
    change_note: (row.change_note as string) ?? null,
    last_reviewed_by: (row.last_reviewed_by as string) ?? null,
    last_reviewed_at: (row.last_reviewed_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

export function localListLatestApprovedByOrg(): LocalContextPolicyDocRow[] {
  const db = getLocalDb()
  const rows = db.prepare(`
    SELECT * FROM context_policy_docs
    WHERE status = 'approved' AND deleted_at IS NULL
    ORDER BY doc_type, created_at DESC
  `).all() as Record<string, unknown>[]
  const byType = new Map<string, LocalContextPolicyDocRow>()
  for (const row of rows) {
    const p = rowToPolicy(row)
    if (!byType.has(p.doc_type)) byType.set(p.doc_type, p)
  }
  return Array.from(byType.values())
}

export function localFindLatestApprovedByOrgAndType(
  docType: ContextPolicyDocType
): LocalContextPolicyDocRow | null {
  const row = getLocalDb().prepare(`
    SELECT * FROM context_policy_docs
    WHERE doc_type = ? AND status = 'approved' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(docType)
  return row ? rowToPolicy(row as Record<string, unknown>) : null
}

export function localListByOrgAndType(
  docType: ContextPolicyDocType,
  limit = 20
): LocalContextPolicyDocRow[] {
  const rows = getLocalDb().prepare(`
    SELECT * FROM context_policy_docs
    WHERE doc_type = ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(docType, Math.max(1, Math.min(limit, 100)))
  return rows.map((r) => rowToPolicy(r as Record<string, unknown>))
}

export function localCreateApprovedVersion(params: {
  docType: ContextPolicyDocType
  content: string
  reviewedBy?: string
  changeNote?: string
}): LocalContextPolicyDocRow {
  const db = getLocalDb()
  const latest = localFindLatestApprovedByOrgAndType(params.docType)
  const nextVersion = toVersionLabel(toVersionNumber(latest?.version) + 1)
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO context_policy_docs
      (id, doc_type, version, status, content, source_candidate_id, change_note, last_reviewed_by, last_reviewed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'approved', ?, NULL, ?, ?, ?, ?, ?)
  `).run(id, params.docType, nextVersion, params.content, params.changeNote ?? null,
    params.reviewedBy ?? null, now, now, now)
  return rowToPolicy(db.prepare('SELECT * FROM context_policy_docs WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindByOrgTypeAndVersion(
  docType: ContextPolicyDocType,
  version: string
): LocalContextPolicyDocRow | null {
  const row = getLocalDb().prepare(
    'SELECT * FROM context_policy_docs WHERE doc_type = ? AND version = ? AND deleted_at IS NULL'
  ).get(docType, version)
  return row ? rowToPolicy(row as Record<string, unknown>) : null
}
