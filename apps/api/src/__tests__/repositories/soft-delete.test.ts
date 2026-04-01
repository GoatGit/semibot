import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('软删除测试', () => {
  let dbPath = ''

  beforeEach(async () => {
    dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-soft-delete-')), 'semibot.db')
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

  it('Agent softDelete 应设置 deleted_at / deleted_by 并从列表中过滤', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    const kept = await agentRepository.create({ name: 'Keep', systemPrompt: 'a', config: {} })
    const removed = await agentRepository.create({ name: 'Remove', systemPrompt: 'b', config: {} })

    expect(await agentRepository.softDelete(removed.id, 'user-1')).toBe(true)
    expect(await agentRepository.findById(removed.id)).toBeNull()

    const list = await agentRepository.findByOrg({})
    expect(list.data.map((item) => item.id)).toEqual([kept.id])

    const { getLocalDb } = await import('../../lib/db-local')
    const raw = getLocalDb().prepare('SELECT deleted_at, deleted_by, is_active FROM agents WHERE id = ?').get(removed.id) as {
      deleted_at: string | null
      deleted_by: string | null
      is_active: number
    }
    expect(raw.deleted_at).toBeTruthy()
    expect(raw.deleted_by).toBe('user-1')
    expect(raw.is_active).toBe(0)
  })

  it('Session softDelete 应保留数据但在查询接口中隐藏', async () => {
    const sessionRepository = await import('../../repositories/session.repository')

    const created = await sessionRepository.create({
      userId: 'user-1',
      agentId: 'agent-1',
      title: 'Session To Delete',
    })

    expect(await sessionRepository.softDelete(created.id, 'user-1')).toBe(true)
    expect(await sessionRepository.findById(created.id)).toBeNull()

    const list = await sessionRepository.findByUserAndOrg({ userId: 'user-1' })
    expect(list.data).toHaveLength(0)

    const { getLocalDb } = await import('../../lib/db-local')
    const raw = getLocalDb().prepare('SELECT deleted_at, deleted_by FROM sessions WHERE id = ?').get(created.id) as {
      deleted_at: string | null
      deleted_by: string | null
    }
    expect(raw.deleted_at).toBeTruthy()
    expect(raw.deleted_by).toBe('user-1')
  })
})
