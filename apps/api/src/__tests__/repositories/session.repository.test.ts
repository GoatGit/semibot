import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('SessionRepository', () => {
  let dbPath = ''

  beforeEach(async () => {
    dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-session-repo-')), 'semibot.db')
    process.env.SEMIBOT_DB_PATH = dbPath
    vi.resetModules()
  })

  afterEach(async () => {
    const { closeLocalDb } = await import('../../lib/db-local')
    closeLocalDb()
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true })
    delete process.env.SEMIBOT_DB_PATH
    vi.resetModules()
  })

  it('creates and fetches sessions', async () => {
    const sessionRepository = await import('../../repositories/session.repository')

    const created = await sessionRepository.create({
      userId: 'user-1',
      agentId: 'agent-1',
      title: 'Test Session',
    })

    expect(created.title).toBe('Test Session')
    expect(created.org_id).toBe('local')

    const found = await sessionRepository.findById(created.id)
    expect(found?.id).toBe(created.id)
  })

  it('filters sessions by user and paginates', async () => {
    const sessionRepository = await import('../../repositories/session.repository')

    await sessionRepository.create({ userId: 'user-1', agentId: 'agent-1', title: 'Session 1' })
    await sessionRepository.create({ userId: 'user-1', agentId: 'agent-1', title: 'Session 2' })
    await sessionRepository.create({ userId: 'user-2', agentId: 'agent-1', title: 'Other user' })

    const result = await sessionRepository.findByUserAndOrg({
      userId: 'user-1',
      page: 1,
      limit: 10,
    })

    expect(result.data).toHaveLength(2)
    expect(result.meta.total).toBe(2)

    const paged = await sessionRepository.findByUserAndOrg({
      userId: 'user-1',
      page: 1,
      limit: 1,
    })
    expect(paged.data).toHaveLength(1)
    expect(paged.meta.totalPages).toBe(2)
  })

  it('updates title and soft deletes sessions', async () => {
    const sessionRepository = await import('../../repositories/session.repository')

    const created = await sessionRepository.create({
      userId: 'user-1',
      agentId: 'agent-1',
      title: 'Original',
    })

    const updated = await sessionRepository.updateTitle(created.id, 'Updated Title')
    expect(updated?.title).toBe('Updated Title')

    const deleted = await sessionRepository.softDelete(created.id, 'user-1')
    expect(deleted).toBe(true)
    expect(await sessionRepository.findById(created.id)).toBeNull()
  })
})
