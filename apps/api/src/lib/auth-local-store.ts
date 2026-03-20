/**
 * Auth 本地文件存储
 *
 * 单用户模式下将 users / organizations 持久化到
 * ~/.semibot/auth/auth.json，避免依赖远端 RDS。
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createLogger } from './logger'

const logger = createLogger('auth-local-store')
const LOCAL_AUTH_DIR = path.join(os.homedir(), '.semibot', 'auth')
const LOCAL_AUTH_FILE = path.join(LOCAL_AUTH_DIR, 'auth.json')

export interface LocalUserRow {
  id: string
  email: string
  password_hash: string
  name: string
  avatar_url: string | null
  org_id: string
  role: string
  is_active: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface LocalOrgRow {
  id: string
  name: string
  slug: string
  plan: string
  quota: Record<string, unknown>
  settings: Record<string, unknown>
  owner_id: string
  is_active: boolean
  created_at: string
  updated_at: string
}

interface LocalStore {
  users: LocalUserRow[]
  organizations: LocalOrgRow[]
}

async function readStore(): Promise<LocalStore> {
  try {
    const raw = await fs.readFile(LOCAL_AUTH_FILE, 'utf-8')
    return JSON.parse(raw) as LocalStore
  } catch {
    return { users: [], organizations: [] }
  }
}

async function writeStore(store: LocalStore): Promise<void> {
  await fs.mkdir(LOCAL_AUTH_DIR, { recursive: true })
  await fs.writeFile(LOCAL_AUTH_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function nowIso(): string {
  return new Date().toISOString()
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function localFindUserByEmail(email: string): Promise<LocalUserRow | null> {
  const store = await readStore()
  return store.users.find((u) => u.email === email && u.is_active) ?? null
}

export async function localFindUserById(id: string): Promise<LocalUserRow | null> {
  const store = await readStore()
  return store.users.find((u) => u.id === id && u.is_active) ?? null
}

export async function localCreateUser(data: {
  email: string
  passwordHash: string
  name: string
  role?: string
}): Promise<LocalUserRow> {
  const store = await readStore()
  if (store.users.find((u) => u.email === data.email)) {
    throw Object.assign(new Error('Email already exists'), { code: '23505' })
  }
  const row: LocalUserRow = {
    id: randomUUID(),
    email: data.email,
    password_hash: data.passwordHash,
    name: data.name,
    avatar_url: null,
    org_id: 'local',
    role: data.role ?? 'owner',
    is_active: true,
    last_login_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  store.users.push(row)
  await writeStore(store)
  logger.info('本地创建用户', { id: row.id, email: data.email })
  return row
}

export async function localUpdateUserLastLogin(id: string): Promise<void> {
  const store = await readStore()
  const idx = store.users.findIndex((u) => u.id === id)
  if (idx === -1) return
  store.users[idx] = { ...store.users[idx], last_login_at: nowIso(), updated_at: nowIso() }
  await writeStore(store)
}

export async function localUpdateUserProfile(
  id: string,
  data: { name?: string; avatarUrl?: string }
): Promise<LocalUserRow | null> {
  const store = await readStore()
  const idx = store.users.findIndex((u) => u.id === id && u.is_active)
  if (idx === -1) return null
  store.users[idx] = {
    ...store.users[idx],
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.avatarUrl !== undefined ? { avatar_url: data.avatarUrl } : {}),
    updated_at: nowIso(),
  }
  await writeStore(store)
  return store.users[idx]
}

export async function localUpdateUserPassword(id: string, passwordHash: string): Promise<void> {
  const store = await readStore()
  const idx = store.users.findIndex((u) => u.id === id && u.is_active)
  if (idx === -1) return
  store.users[idx] = { ...store.users[idx], password_hash: passwordHash, updated_at: nowIso() }
  await writeStore(store)
}

// ─── Organizations ──────────────────────────────────────────────────────────

export async function localFindOrgById(orgId: string): Promise<LocalOrgRow | null> {
  const store = await readStore()
  return store.organizations.find((o) => o.id === orgId && o.is_active) ?? null
}

export async function localUpdateOrg(
  orgId: string,
  data: { name?: string; settings?: Record<string, unknown> }
): Promise<void> {
  const store = await readStore()
  const idx = store.organizations.findIndex((o) => o.id === orgId)
  if (idx === -1) return
  store.organizations[idx] = {
    ...store.organizations[idx],
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.settings !== undefined ? { settings: data.settings } : {}),
    updated_at: nowIso(),
  }
  await writeStore(store)
}

export async function localListUsersByOrg(orgId: string): Promise<LocalUserRow[]> {
  const store = await readStore()
  return store.users.filter((u) => u.org_id === orgId && u.is_active)
}
