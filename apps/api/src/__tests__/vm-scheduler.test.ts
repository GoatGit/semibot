import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'

const { mockSpawn, mockHomedir } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockHomedir: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  const mocked = {
    ...actual,
    homedir: () => mockHomedir(),
  }
  return {
    ...mocked,
    default: mocked,
  }
})

type VMRow = {
  id: string
  user_id: string
  org_id: string
  status: 'starting' | 'provisioning' | 'running' | 'ready' | 'disconnected' | 'terminated' | 'failed'
  mode: string
  vm_id: string | null
  connect_ticket: string | null
  ticket_used_at: string | null
  last_bootstrap_at: string | null
  bootstrap_attempts: number
  bootstrap_last_error: string | null
  created_at: string
}

async function seedVmStore(home: string, rows: VMRow[]): Promise<void> {
  const dir = path.join(home, '.semibot', 'vm')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'instances.json'), JSON.stringify({ instances: rows }, null, 2))
}

describe('vm-scheduler', () => {
  const originalHome = process.env.HOME
  const originalNodeEnv = process.env.NODE_ENV
  let tempHome = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-vm-scheduler-'))
    process.env.HOME = tempHome
    mockHomedir.mockReturnValue(tempHome)
    process.env.JWT_SECRET = 'test-secret'
    process.env.NODE_ENV = 'production'
    delete process.env.VM_BOOTSTRAP_CMD
    delete process.env.VM_BOOTSTRAP_COOLDOWN_MS
    delete process.env.VM_BOOTSTRAP_MAX_ATTEMPTS
    delete process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS
  })

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('creates a vm instance when missing', async () => {
    const { ensureUserVM } = await import('../scheduler/vm-scheduler')

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result.ready).toBe(false)
    expect(result.status).toBe('starting')
    expect(result.instanceId).toBeTruthy()
  })

  it('creates and provisions vm when bootstrap command is available', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    const { ensureUserVM } = await import('../scheduler/vm-scheduler')
    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result.ready).toBe(false)
    expect(result.status).toBe('provisioning')
    const spawnArgs = mockSpawn.mock.calls[0]
    expect(spawnArgs[0]).toBe('/bin/sh')
    expect(spawnArgs[1]).toEqual(['-lc', 'echo bootstrap'])
    expect(spawnArgs[2]?.env).toMatchObject({
      VM_USER_ID: 'user-1',
      VM_ORG_ID: 'org-1',
      VM_INSTANCE_ID: result.instanceId,
      VM_MODE: 'docker',
    })
    const decoded = jwt.verify(spawnArgs[2]?.env?.VM_TOKEN as string, 'test-secret') as { userId: string; orgId: string }
    expect(decoded).toMatchObject({ userId: 'user-1', orgId: 'org-1' })
    expect(unref).toHaveBeenCalled()
  })

  it('returns ready when ws is connected', async () => {
    await seedVmStore(tempHome, [{
      id: 'vm-2',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'running',
      mode: 'docker',
      vm_id: 'x',
      connect_ticket: null,
      ticket_used_at: null,
      last_bootstrap_at: null,
      bootstrap_attempts: 0,
      bootstrap_last_error: null,
      created_at: new Date().toISOString(),
    }])

    const { ensureUserVM } = await import('../scheduler/vm-scheduler')
    const result = await ensureUserVM('user-1', 'org-1', { wsReady: true })

    expect(result).toEqual({ ready: true, status: 'ready', instanceId: 'vm-2' })
  })

  it('downgrades stale ready vm to disconnected when bootstrap is skipped by cooldown', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    await seedVmStore(tempHome, [{
      id: 'vm-2d',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'ready',
      mode: 'docker',
      vm_id: 'x',
      connect_ticket: null,
      ticket_used_at: null,
      last_bootstrap_at: new Date(Date.now() - 500).toISOString(),
      bootstrap_attempts: 0,
      bootstrap_last_error: null,
      created_at: new Date().toISOString(),
    }])

    const { ensureUserVM } = await import('../scheduler/vm-scheduler')
    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toMatchObject({ ready: false, status: 'disconnected', instanceId: 'vm-2d' })
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('retries provisioning after cooldown and reuses connect ticket', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS = '1000'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })
    await seedVmStore(tempHome, [{
      id: 'vm-3e',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'provisioning',
      mode: 'docker',
      vm_id: null,
      connect_ticket: 'ticket-existing',
      ticket_used_at: null,
      last_bootstrap_at: new Date(Date.now() - 3000).toISOString(),
      bootstrap_attempts: 1,
      bootstrap_last_error: null,
      created_at: new Date().toISOString(),
    }])

    const { ensureUserVM } = await import('../scheduler/vm-scheduler')
    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-3e' })
    expect(mockSpawn.mock.calls[0][2]?.env?.VM_TICKET).toBe('ticket-existing')
    expect(unref).toHaveBeenCalled()
  })

  it('marks vm failed when bootstrap attempts exceed limit', async () => {
    process.env.VM_BOOTSTRAP_MAX_ATTEMPTS = '2'
    await seedVmStore(tempHome, [{
      id: 'vm-5',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'disconnected',
      mode: 'docker',
      vm_id: 'x',
      connect_ticket: null,
      ticket_used_at: null,
      last_bootstrap_at: null,
      bootstrap_attempts: 2,
      bootstrap_last_error: null,
      created_at: new Date().toISOString(),
    }])

    const { ensureUserVM } = await import('../scheduler/vm-scheduler')
    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'failed', instanceId: 'vm-5' })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('forceRebootstrap bypasses cooldown', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })
    await seedVmStore(tempHome, [{
      id: 'vm-6',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'disconnected',
      mode: 'docker',
      vm_id: 'x',
      connect_ticket: null,
      ticket_used_at: null,
      last_bootstrap_at: new Date(Date.now() - 200).toISOString(),
      bootstrap_attempts: 1,
      bootstrap_last_error: null,
      created_at: new Date().toISOString(),
    }])

    const { forceRebootstrap } = await import('../scheduler/vm-scheduler')
    const result = await forceRebootstrap('user-1', 'org-1')

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-6' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })

  it('getUserVMStatus returns retryAfterMs when in cooldown window', async () => {
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    await seedVmStore(tempHome, [{
      id: 'vm-7',
      user_id: 'user-1',
      org_id: 'org-1',
      status: 'disconnected',
      mode: 'docker',
      vm_id: 'x',
      connect_ticket: null,
      ticket_used_at: null,
      last_bootstrap_at: new Date(Date.now() - 500).toISOString(),
      bootstrap_attempts: 2,
      bootstrap_last_error: 'x',
      created_at: new Date().toISOString(),
    }])

    const { getUserVMStatus } = await import('../scheduler/vm-scheduler')
    const status = await getUserVMStatus('user-1')

    expect(status).toMatchObject({
      instanceId: 'vm-7',
      status: 'disconnected',
      bootstrapAttempts: 2,
      lastError: 'x',
    })
    expect(status.retryAfterMs).toBeGreaterThan(0)
  })
})
