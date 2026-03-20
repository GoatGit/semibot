/**
 * API Keys SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export interface LocalApiKeyRow {
  id: string
  org_id: string
  user_id: string | null
  name: string
  key_hash: string
  key_prefix: string
  scopes: string[]
  is_active: boolean
  last_used_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToKey(row: Record<string, unknown>): LocalApiKeyRow {
  return {
    id: row.id as string,
    org_id: 'local',
    user_id: null,
    name: row.name as string,
    key_hash: row.key_hash as string,
    key_prefix: row.key_prefix as string,
    scopes: JSON.parse((row.scopes_json as string) ?? '[]'),
    is_active: (row.is_active as number) === 1,
    last_used_at: (row.last_used_at as string) ?? null,
    expires_at: (row.expires_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

export function localCreateApiKey(data: {
  userId?: string
  name: string
  keyHash: string
  keyPrefix: string
  scopes?: string[]
  expiresAt?: string
}): LocalApiKeyRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes_json, is_active, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, data.name, data.keyHash, data.keyPrefix, JSON.stringify(data.scopes ?? []), data.expiresAt ?? null, now, now)
  return rowToKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindApiKeyByHash(keyHash: string): LocalApiKeyRow | null {
  const row = getLocalDb().prepare('SELECT * FROM api_keys WHERE key_hash = ? AND deleted_at IS NULL').get(keyHash)
  return row ? rowToKey(row as Record<string, unknown>) : null
}

export function localFindApiKeyById(id: string): LocalApiKeyRow | null {
  const row = getLocalDb().prepare('SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToKey(row as Record<string, unknown>) : null
}

export function localFindApiKeysByOrg(): LocalApiKeyRow[] {
  const rows = getLocalDb().prepare('SELECT * FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC').all()
  return rows.map((r) => rowToKey(r as Record<string, unknown>))
}

export function localUpdateApiKeyLastUsed(id: string): void {
  getLocalDb().prepare('UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id)
}

export function localRevokeApiKey(id: string, revokedBy?: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE api_keys SET is_active = 0, deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), revokedBy ?? null, nowIso(), id)
  return (result.changes ?? 0) > 0
}
