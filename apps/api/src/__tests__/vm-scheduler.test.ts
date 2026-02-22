import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import jwt from 'jsonwebtoken'

const { mockSql, mockSpawn } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSpawn: vi.fn(),
}))

vi.mock('../lib/db', () => ({
  sql: ((...args: unknown[]) => mockSql(...args)) as unknown,
}))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

import { ensureUserVM, forceRebootstrap, getUserVMStatus } from '../scheduler/vm-scheduler'

describe('vm-scheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.VM_BOOTSTRAP_CMD
    delete process.env.VM_BOOTSTRAP_COOLDOWN_MS
    delete process.env.VM_BOOTSTRAP_MAX_ATTEMPTS
    delete process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS
    process.env.JWT_SECRET = 'test-secret'
    process.env.NODE_ENV = 'production'
  })

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('creates a vm instance when missing', async () => {
    mockSql
      .mockResolvedValueOnce([]) // getActiveVM
      .mockResolvedValueOnce([{ vm_mode: null, default_vm_mode: 'docker' }]) // resolve mode
      .mockResolvedValueOnce([{ id: 'vm-1' }]) // create

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'starting', instanceId: 'vm-1' })
  })

  it('creates and provisions vm when bootstrap command is available', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    mockSql
      .mockResolvedValueOnce([]) // getActiveVM
      .mockResolvedValueOnce([{ vm_mode: null, default_vm_mode: 'docker' }]) // resolve mode
      .mockResolvedValueOnce([{ id: 'vm-1b' }]) // create
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-1' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })
    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-1b' })
    expect(mockSpawn).toHaveBeenCalled()
  })

  it('returns ready when ws is connected', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: 'vm-2', status: 'running', mode: 'docker', vm_id: 'x' }]) // getActiveVM
      .mockResolvedValueOnce(undefined) // mark ready

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: true })

    expect(result).toEqual({ ready: true, status: 'ready', instanceId: 'vm-2' })
  })

  it('promotes starting vm to ready when ws becomes connected', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: 'vm-2b', status: 'starting', mode: 'docker', vm_id: null }]) // getActiveVM
      .mockResolvedValueOnce(undefined) // mark ready

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: true })

    expect(result).toEqual({ ready: true, status: 'ready', instanceId: 'vm-2b' })
  })

  it('treats stale ready vm as disconnected and reprovisions when ws is not connected', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    mockSql
      .mockResolvedValueOnce([
        {
          id: 'vm-2c',
          status: 'ready',
          mode: 'docker',
          vm_id: 'x',
          connect_ticket: null,
          ticket_used_at: null,
          last_bootstrap_at: null,
          bootstrap_attempts: 0,
          bootstrap_last_error: null,
        },
      ]) // getActiveVM
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-2c' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })
    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-2c' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })

  it('downgrades stale ready vm to disconnected when bootstrap is skipped by cooldown', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    const recent = new Date(Date.now() - 500).toISOString()

    mockSql
      .mockResolvedValueOnce([
        {
          id: 'vm-2d',
          status: 'ready',
          mode: 'docker',
          vm_id: 'x',
          connect_ticket: null,
          ticket_used_at: null,
          last_bootstrap_at: recent,
          bootstrap_attempts: 0,
          bootstrap_last_error: null,
        },
      ]) // getActiveVM
      .mockResolvedValueOnce(undefined) // mark disconnected

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })
    expect(result).toMatchObject({ ready: false, status: 'disconnected', instanceId: 'vm-2d' })
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('triggers bootstrap for disconnected vm', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    mockSql
      .mockResolvedValueOnce([{ id: 'vm-3', status: 'disconnected', mode: 'docker', vm_id: 'x', connect_ticket: null, ticket_used_at: null, last_bootstrap_at: null, bootstrap_attempts: 0, bootstrap_last_error: null }]) // getActiveVM
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-3' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-3' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
    const spawnArgs = mockSpawn.mock.calls[0]
    expect(spawnArgs[0]).toBe('/bin/sh')
    expect(spawnArgs[1]).toEqual(['-lc', 'echo bootstrap'])
    expect(spawnArgs[2]?.env).toMatchObject({
      VM_USER_ID: 'user-1',
      VM_ORG_ID: 'org-1',
      VM_INSTANCE_ID: 'vm-3',
      VM_MODE: 'docker',
      VM_TICKET: 'ticket-3',
    })
    const token = spawnArgs[2]?.env?.VM_TOKEN as string
    expect(typeof token).toBe('string')
    const decoded = jwt.verify(token, 'test-secret') as { userId: string; orgId: string }
    expect(decoded.userId).toBe('user-1')
    expect(decoded.orgId).toBe('org-1')
  })

  it('triggers bootstrap for starting vm when not ws-ready', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    mockSql
      .mockResolvedValueOnce([{ id: 'vm-3b', status: 'starting', mode: 'docker', vm_id: null, connect_ticket: null, ticket_used_at: null, last_bootstrap_at: null, bootstrap_attempts: 0, bootstrap_last_error: null }]) // getActiveVM
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-3b' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-3b' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })

  it('retries bootstrap while provisioning when not ws-ready', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })

    mockSql
      .mockResolvedValueOnce([{ id: 'vm-3c', status: 'provisioning', mode: 'docker', vm_id: null, connect_ticket: null, ticket_used_at: null, last_bootstrap_at: null, bootstrap_attempts: 1, bootstrap_last_error: null }]) // getActiveVM
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-3c' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-3c' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })

  it('respects provisioning retry cooldown before rebootstrap', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS = '5000'
    const recent = new Date(Date.now() - 800).toISOString()

    mockSql.mockResolvedValueOnce([
      {
        id: 'vm-3d',
        status: 'provisioning',
        mode: 'docker',
        vm_id: null,
        connect_ticket: null,
        ticket_used_at: null,
        last_bootstrap_at: recent,
        bootstrap_attempts: 1,
        bootstrap_last_error: null,
      },
    ]) // getActiveVM

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toMatchObject({ ready: false, status: 'provisioning', instanceId: 'vm-3d' })
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('reuses existing unused connect ticket during provisioning retry', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_PROVISIONING_RETRY_COOLDOWN_MS = '1000'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })
    const stale = new Date(Date.now() - 3000).toISOString()

    mockSql
      .mockResolvedValueOnce([
        {
          id: 'vm-3e',
          status: 'provisioning',
          mode: 'docker',
          vm_id: null,
          connect_ticket: 'ticket-existing',
          ticket_used_at: null,
          last_bootstrap_at: stale,
          bootstrap_attempts: 1,
          bootstrap_last_error: null,
        },
      ]) // getActiveVM
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-3e' })
    expect(mockSpawn).toHaveBeenCalled()
    const spawnArgs = mockSpawn.mock.calls[0]
    expect(spawnArgs[2]?.env?.VM_TICKET).toBe('ticket-existing')
    expect(unref).toHaveBeenCalled()
  })

  it('skips bootstrap when disconnected vm is within cooldown window', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    const recent = new Date(Date.now() - 500).toISOString()

    mockSql.mockResolvedValueOnce([
      {
        id: 'vm-4',
        status: 'disconnected',
        mode: 'docker',
        vm_id: 'x',
        last_bootstrap_at: recent,
        bootstrap_attempts: 2,
        bootstrap_last_error: null,
      },
    ])

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })

    expect(result).toMatchObject({ ready: false, status: 'disconnected', instanceId: 'vm-4' })
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('marks vm failed when bootstrap attempts exceed limit', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_MAX_ATTEMPTS = '2'
    mockSql
      .mockResolvedValueOnce([
        {
          id: 'vm-5',
          status: 'disconnected',
          mode: 'docker',
          vm_id: 'x',
          last_bootstrap_at: null,
          bootstrap_attempts: 2,
          bootstrap_last_error: null,
        },
      ]) // getActiveVM
      .mockResolvedValueOnce(undefined) // mark failed
      .mockResolvedValueOnce(undefined) // record failure

    const result = await ensureUserVM('user-1', 'org-1', { wsReady: false })
    expect(result).toEqual({ ready: false, status: 'failed', instanceId: 'vm-5' })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('forceRebootstrap bypasses cooldown', async () => {
    process.env.VM_BOOTSTRAP_CMD = 'echo bootstrap'
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    const unref = vi.fn()
    mockSpawn.mockReturnValue({ unref })
    const recent = new Date(Date.now() - 200).toISOString()

    mockSql
      .mockResolvedValueOnce([
        {
          id: 'vm-6',
          status: 'disconnected',
          mode: 'docker',
          vm_id: 'x',
          last_bootstrap_at: recent,
          bootstrap_attempts: 1,
          bootstrap_last_error: null,
        },
      ]) // getActiveVM
      .mockResolvedValueOnce([{ connect_ticket: 'ticket-6' }]) // issue ticket
      .mockResolvedValueOnce(undefined) // touch bootstrap attempt
      .mockResolvedValueOnce(undefined) // mark provisioning

    const result = await forceRebootstrap('user-1', 'org-1')
    expect(result).toEqual({ ready: false, status: 'provisioning', instanceId: 'vm-6' })
    expect(mockSpawn).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })

  it('getUserVMStatus returns retryAfterMs when in cooldown window', async () => {
    process.env.VM_BOOTSTRAP_COOLDOWN_MS = '60000'
    const recent = new Date(Date.now() - 500).toISOString()

    mockSql.mockResolvedValueOnce([
      {
        id: 'vm-7',
        status: 'disconnected',
        mode: 'docker',
        vm_id: 'x',
        last_bootstrap_at: recent,
        bootstrap_attempts: 2,
        bootstrap_last_error: 'x',
      },
    ])

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
