import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { sql } from '../lib/db'
import { createLogger } from '../lib/logger'

const schedulerLogger = createLogger('vm-scheduler')

type VMStatus = 'starting' | 'provisioning' | 'running' | 'ready' | 'disconnected' | 'terminated' | 'failed'

type VMInstanceRow = {
  id: string
  status: VMStatus
  mode: string
  vm_id: string | null
  last_bootstrap_at: string | null
  bootstrap_attempts: number
  bootstrap_last_error: string | null
}

export interface EnsureVMOptions {
  wsReady: boolean
}

export interface EnsureVMResult {
  ready: boolean
  status: VMStatus | 'missing'
  instanceId?: string
  retryAfterMs?: number
}

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
    if (active.status !== 'ready') {
      await markVMStatus(active.id, 'ready')
    }
    return { ready: true, status: 'ready', instanceId: active.id }
  }

  if (active.status === 'failed' || active.status === 'terminated') {
    const mode = await resolveVMMode(userId, orgId)
    const created = await createVMInstance(userId, orgId, mode)
    const triggered = await maybeTriggerBootstrap(userId, orgId, created.id, mode)
    if (triggered) {
      await markVMStatus(created.id, 'provisioning')
      return { ready: false, status: 'provisioning', instanceId: created.id }
    }
    return { ready: false, status: 'starting', instanceId: created.id }
  }

  if (active.status === 'disconnected') {
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

  return { ready: false, status: active.status, instanceId: active.id }
}

async function getActiveVM(userId: string): Promise<VMInstanceRow | null> {
  const rows = await sql<VMInstanceRow[]>`
    SELECT id, status, mode, vm_id, last_bootstrap_at, bootstrap_attempts, bootstrap_last_error
    FROM user_vm_instances
    WHERE user_id = ${userId}
      AND status NOT IN ('terminated', 'failed')
    ORDER BY created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

async function resolveVMMode(userId: string, orgId: string): Promise<string> {
  const rows = await sql<Array<{ vm_mode: string | null; default_vm_mode: string | null }>>`
    SELECT
      u.vm_mode AS vm_mode,
      o.default_vm_mode AS default_vm_mode
    FROM users u
    JOIN organizations o ON o.id = u.org_id
    WHERE u.id = ${userId}
      AND o.id = ${orgId}
    LIMIT 1
  `
  const row = rows[0]
  return row?.vm_mode || row?.default_vm_mode || 'docker'
}

async function createVMInstance(userId: string, orgId: string, mode: string): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO user_vm_instances (user_id, org_id, mode, status, config, bootstrap_attempts, bootstrap_last_error)
    VALUES (${userId}, ${orgId}, ${mode}, 'starting', '{}', 0, NULL)
    RETURNING id
  `
  return rows[0] as { id: string }
}

async function markVMStatus(id: string, status: VMStatus): Promise<void> {
  await sql`
    UPDATE user_vm_instances
    SET status = ${status}
    WHERE id = ${id}
  `
}

function resolveBootstrapCommand(): string {
  const fromEnv = (process.env.VM_BOOTSTRAP_CMD ?? '').trim()
  if (fromEnv) return fromEnv

  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    const localScript = path.resolve(process.cwd(), 'scripts/vm/bootstrap-local.sh')
    if (fs.existsSync(localScript)) return localScript
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
  if (!active.last_bootstrap_at) return undefined
  const last = Date.parse(active.last_bootstrap_at)
  if (Number.isNaN(last)) return undefined
  const remaining = cooldownMs - (Date.now() - last)
  return remaining > 0 ? remaining : undefined
}

function hasExceededBootstrapAttempts(active: VMInstanceRow): boolean {
  const maxAttempts = Math.max(1, Number(process.env.VM_BOOTSTRAP_MAX_ATTEMPTS ?? 5))
  return Number(active.bootstrap_attempts ?? 0) >= maxAttempts
}

async function touchBootstrapAttempt(instanceId: string): Promise<void> {
  await sql`
    UPDATE user_vm_instances
    SET bootstrap_attempts = COALESCE(bootstrap_attempts, 0) + 1,
        last_bootstrap_at = NOW(),
        bootstrap_last_error = NULL
    WHERE id = ${instanceId}
  `
}

async function recordBootstrapFailure(instanceId: string, reason: string): Promise<void> {
  await sql`
    UPDATE user_vm_instances
    SET bootstrap_last_error = ${reason}
    WHERE id = ${instanceId}
  `
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
      userId,
      orgId,
      instanceId,
      status: active.status,
      lastBootstrapAt: active.last_bootstrap_at,
    })
    return false
  }
  const vmToken = createVMToken(userId, orgId)
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

function createVMToken(userId: string, orgId: string): string {
  const secret = process.env.JWT_SECRET ?? 'development-secret-change-in-production'
  return jwt.sign(
    { userId, orgId },
    secret,
    { expiresIn: '10m' }
  )
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
