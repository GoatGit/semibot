import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import jwt from 'jsonwebtoken'
import { createLogger } from '../lib/logger'

const schedulerLogger = createLogger('vm-scheduler')

// ─── 本地文件存储 ─────────────────────────────────────────────────────────────

const LOCAL_VM_DIR = path.join(os.homedir(), '.semibot', 'vm')
const LOCAL_VM_FILE = path.join(LOCAL_VM_DIR, 'instances.json')

type VMStatus = 'starting' | 'provisioning' | 'running' | 'ready' | 'disconnected' | 'terminated' | 'failed'

type VMInstanceRow = {
  id: string
  user_id: string
  org_id: string
  status: VMStatus
  mode: string
  vm_id: string | null
  connect_ticket: string | null
  ticket_used_at: string | null
  last_bootstrap_at: string | null
  bootstrap_attempts: number
  bootstrap_last_error: string | null
  created_at: string
}

interface VMStore {
  instances: VMInstanceRow[]
}

async function readVMStore(): Promise<VMStore> {
  try {
    const raw = await fsPromises.readFile(LOCAL_VM_FILE, 'utf-8')
    return JSON.parse(raw) as VMStore
  } catch {
    return { instances: [] }
  }
}

async function writeVMStore(store: VMStore): Promise<void> {
  await fsPromises.mkdir(LOCAL_VM_DIR, { recursive: true })
  await fsPromises.writeFile(LOCAL_VM_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function nowIso(): string {
  return new Date().toISOString()
}

async function getActiveVM(userId: string): Promise<VMInstanceRow | null> {
  const store = await readVMStore()
  const active = store.instances
    .filter((i) => i.user_id === userId && i.status !== 'terminated' && i.status !== 'failed')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  return active[0] ?? null
}

async function resolveVMMode(_userId: string, _orgId: string): Promise<string> {
  return process.env.VM_DEFAULT_MODE ?? 'docker'
}

async function createVMInstance(userId: string, orgId: string, mode: string): Promise<{ id: string }> {
  const store = await readVMStore()
  const row: VMInstanceRow = {
    id: randomUUID(),
    user_id: userId,
    org_id: orgId,
    status: 'starting',
    mode,
    vm_id: null,
    connect_ticket: null,
    ticket_used_at: null,
    last_bootstrap_at: null,
    bootstrap_attempts: 0,
    bootstrap_last_error: null,
    created_at: nowIso(),
  }
  store.instances.push(row)
  await writeVMStore(store)
  return { id: row.id }
}

async function markVMStatus(id: string, status: VMStatus): Promise<void> {
  const store = await readVMStore()
  const idx = store.instances.findIndex((i) => i.id === id)
  if (idx === -1) return
  store.instances[idx] = { ...store.instances[idx], status }
  await writeVMStore(store)
}

async function touchBootstrapAttempt(instanceId: string): Promise<void> {
  const store = await readVMStore()
  const idx = store.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return
  store.instances[idx] = {
    ...store.instances[idx],
    bootstrap_attempts: (store.instances[idx].bootstrap_attempts ?? 0) + 1,
    last_bootstrap_at: nowIso(),
    bootstrap_last_error: null,
  }
  await writeVMStore(store)
}

async function issueVMConnectTicket(instanceId: string): Promise<string> {
  const store = await readVMStore()
  const idx = store.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return ''
  const ticket = randomUUID()
  store.instances[idx] = { ...store.instances[idx], connect_ticket: ticket, ticket_used_at: null }
  await writeVMStore(store)
  return ticket
}

async function recordBootstrapFailure(instanceId: string, reason: string): Promise<void> {
  const store = await readVMStore()
  const idx = store.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return
  store.instances[idx] = { ...store.instances[idx], bootstrap_last_error: reason }
  await writeVMStore(store)
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

export interface EnsureVMOptions {
  wsReady: boolean
}

export interface EnsureVMResult {
  ready: boolean
  status: VMStatus | 'missing'
  instanceId?: string
  retryAfterMs?: number
}

function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET
  if (secret) return secret
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('JWT_SECRET must be configured in production')
  }
  return 'development-secret-change-in-production'
}

function resolveBootstrapCommand(): string {
  const fromEnv = (process.env.VM_BOOTSTRAP_CMD ?? '').trim()
  if (fromEnv) return fromEnv
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    const schedulerDir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.resolve(process.cwd(), 'scripts/vm/bootstrap-local.sh'),
      path.resolve(schedulerDir, '../../../../scripts/vm/bootstrap-local.sh'),
    ]
    for (const localScript of candidates) {
      if (fs.existsSync(localScript)) return localScript
    }
  }
  return ''
}

function shouldSkipBootstrapByCooldown(active: VMInstanceRow): boolean {
  const cooldownMs = Math.max(1000, Number(process.env.VM_BOOTSTRAP_COOLDOWN_MS ?? 30000))
  if (!active.last_bootstrap_at) return false
  const last = Date.parse(active.last_bootstrap_at)
  if (Number.isNaN(last)) return false
  return Date.now() - last < cooldownMs
}

function getRemainingCooldownMs(active: VMInstanceRow): number | undefined {
  const cooldownMs = Math.max(1000, Number(process.env.VM_BOOTSTRAP_COOLDOWN_MS ?? 30000))
  return getRemainingCooldownMsWithWindow(active, cooldownMs)
}

function getRemainingCooldownMsWithWindow(active: VMInstanceRow, cooldownMs: number): number | undefined {
  if (!active.last_bootstrap_at) return undefined
  const last = Date.parse(active.last_bootstrap_at)
  if (Number.isNaN(last)) return undefined
  const remaining = cooldownMs - (Date.now() - last)
  return remaining > 0 ? remaining : undefined
}

function getProvisioningRetryCooldownMs(): number {
  return Math.max(1000, Number(process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS ?? 5000))
}

function hasExceededBootstrapAttempts(active: VMInstanceRow): boolean {
  const maxAttempts = Math.max(1, Number(process.env.VM_BOOTSTRAP_MAX_ATTEMPTS ?? 5))
  return Number(active.bootstrap_attempts ?? 0) >= maxAttempts
}

function createVMToken(userId: string, orgId: string): string {
  const secret = getJWTSecret()
  const tokenTtl = ((process.env.VM_TOKEN_TTL ?? '12h').trim() || '12h') as jwt.SignOptions['expiresIn']
  return jwt.sign({ userId, orgId }, secret, { expiresIn: tokenTtl })
}

async function maybeTriggerBootstrap(
  userId: string,
  orgId: string,
  instanceId: string,
  mode: string,
  active?: VMInstanceRow,
  force = false
): Promise<boolean> {
  const cmd = resolveBootstrapCommand()
  if (!cmd) return false
  if (!force && active && shouldSkipBootstrapByCooldown(active)) {
    schedulerLogger.info('vm_bootstrap_skipped_by_cooldown', {
      userId, orgId, instanceId, status: active.status, lastBootstrapAt: active.last_bootstrap_at,
    })
    return false
  }
  const vmToken = createVMToken(userId, orgId)
  const vmTicket = (active?.connect_ticket && !active.ticket_used_at)
    ? active.connect_ticket
    : await issueVMConnectTicket(instanceId)
  await touchBootstrapAttempt(instanceId)

  try {
    const child = spawn('/bin/sh', ['-lc', cmd], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        VM_USER_ID: userId,
        VM_ORG_ID: orgId,
        VM_INSTANCE_ID: instanceId,
        VM_MODE: mode,
        VM_TOKEN: vmToken,
        VM_TICKET: vmTicket,
        FORCE_RESTART_RUNTIME: force ? 'true' : 'false',
      },
    })
    child.unref()
    schedulerLogger.info('vm_bootstrap_triggered', { userId, orgId, instanceId, mode })
    return true
  } catch (error) {
    const reason = (error as Error).message || 'unknown bootstrap spawn error'
    await recordBootstrapFailure(instanceId, reason)
    schedulerLogger.error('vm_bootstrap_failed', error as Error, { userId, orgId, instanceId, mode })
    return false
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export async function ensureUserVM(
  userId: string,
  orgId: string,
  options: EnsureVMOptions
): Promise<EnsureVMResult> {
  const active = await getActiveVM(userId)

  if (!active) {
    const mode = await resolveVMMode(userId, orgId)
    const created = await createVMInstance(userId, orgId, mode)
    const triggered = await maybeTriggerBootstrap(userId, orgId, created.id, mode)
    if (triggered) {
      await markVMStatus(created.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: created.id }
    }
    return { ready: false, status: 'starting', instanceId: created.id }
  }

  if (options.wsReady) {
    if (active.status !== 'ready') await markVMStatus(active.id, 'ready')
    return { ready: true, status: 'ready', instanceId: active.id }
  }

  if (active.status === 'ready') {
    if (hasExceededBootstrapAttempts(active)) {
      await markVMStatus(active.id, 'failed')
      await recordBootstrapFailure(active.id, 'bootstrap attempts exceeded')
      return { ready: false, status: 'failed', instanceId: active.id }
    }
    const retryAfterMs = getRemainingCooldownMs(active)
    const triggered = await maybeTriggerBootstrap(userId, orgId, active.id, active.mode, active)
    if (triggered) {
      await markVMStatus(active.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: active.id }
    }
    await markVMStatus(active.id, 'disconnected')
    return { ready: false, status: 'disconnected', instanceId: active.id, retryAfterMs }
  }

  if (active.status === 'failed') {
    const mode = await resolveVMMode(userId, orgId)
    const created = await createVMInstance(userId, orgId, mode)
    const triggered = await maybeTriggerBootstrap(userId, orgId, created.id, mode)
    if (triggered) {
      await markVMStatus(created.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: created.id }
    }
    return { ready: false, status: 'starting', instanceId: created.id }
  }

  if (active.status === 'disconnected' || active.status === 'starting') {
    if (hasExceededBootstrapAttempts(active)) {
      await markVMStatus(active.id, 'failed')
      await recordBootstrapFailure(active.id, 'bootstrap attempts exceeded')
      return { ready: false, status: 'failed', instanceId: active.id }
    }
    const retryAfterMs = getRemainingCooldownMs(active)
    const triggered = await maybeTriggerBootstrap(userId, orgId, active.id, active.mode, active)
    if (triggered) {
      await markVMStatus(active.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: active.id }
    }
    return { ready: false, status: active.status, instanceId: active.id, retryAfterMs }
  }

  if (active.status === 'provisioning') {
    if (hasExceededBootstrapAttempts(active)) {
      await markVMStatus(active.id, 'failed')
      await recordBootstrapFailure(active.id, 'bootstrap attempts exceeded')
      return { ready: false, status: 'failed', instanceId: active.id }
    }
    const provisioningCooldownMs = getProvisioningRetryCooldownMs()
    const retryAfterMs = getRemainingCooldownMsWithWindow(active, provisioningCooldownMs)
    if (retryAfterMs && retryAfterMs > 0) {
      return { ready: false, status: active.status, instanceId: active.id, retryAfterMs }
    }
    const triggered = await maybeTriggerBootstrap(userId, orgId, active.id, active.mode, active, true)
    if (triggered) {
      await markVMStatus(active.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: active.id }
    }
    return { ready: false, status: active.status, instanceId: active.id, retryAfterMs }
  }

  return { ready: false, status: active.status, instanceId: active.id }
}

export async function getUserVMStatus(userId: string): Promise<{
  instanceId?: string
  status: VMStatus | 'missing'
  mode?: string
  vmId?: string | null
  bootstrapAttempts?: number
  lastBootstrapAt?: string | null
  lastError?: string | null
  retryAfterMs?: number
}> {
  const active = await getActiveVM(userId)
  if (!active) return { status: 'missing' }
  return {
    instanceId: active.id,
    status: active.status,
    mode: active.mode,
    vmId: active.vm_id,
    bootstrapAttempts: active.bootstrap_attempts,
    lastBootstrapAt: active.last_bootstrap_at,
    lastError: active.bootstrap_last_error,
    retryAfterMs: getRemainingCooldownMs(active),
  }
}

export async function forceRebootstrap(userId: string, orgId: string): Promise<EnsureVMResult> {
  const active = await getActiveVM(userId)
  if (!active) {
    const mode = await resolveVMMode(userId, orgId)
    const created = await createVMInstance(userId, orgId, mode)
    const triggered = await maybeTriggerBootstrap(userId, orgId, created.id, mode, undefined, true)
    if (triggered) {
      await markVMStatus(created.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: created.id }
    }
    return { ready: false, status: 'starting', instanceId: created.id }
  }
  const triggered = await maybeTriggerBootstrap(userId, orgId, active.id, active.mode, active, true)
  if (triggered) {
    await markVMStatus(active.id, 'provisioning')
    return { ready: false, status: 'provisioning', instanceId: active.id }
  }
  return { ready: false, status: active.status, instanceId: active.id }
}
