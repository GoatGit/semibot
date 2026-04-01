import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('evolved-skill.repository', () => {
  let dbPath = ''

  beforeEach(async () => {
    dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-evolved-skill-repo-')), 'semibot.db')
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

  it('creates and fetches evolved skills', async () => {
    const repo = await import('../../repositories/evolved-skill.repository')

    const created = await repo.create({
      agentId: 'agent-1',
      sessionId: 'session-1',
      name: '查询订单状态',
      description: '根据订单号查询订单当前状态',
      steps: [{ order: 1, action: '查询', tool: 'order_query' }],
      toolsUsed: ['order_query'],
      qualityScore: 0.82,
      reusabilityScore: 0.85,
      status: 'pending_review',
    })

    expect(created.name).toBe('查询订单状态')
    expect(created.org_id).toBe('local')
    expect((await repo.findByIdAndOrg(created.id))?.id).toBe(created.id)
  })

  it('lists by status and updates review fields', async () => {
    const repo = await import('../../repositories/evolved-skill.repository')

    const created = await repo.create({
      agentId: 'agent-1',
      sessionId: 'session-1',
      name: 'Skill A',
      description: 'desc',
      steps: [],
      toolsUsed: [],
      qualityScore: 0.8,
      reusabilityScore: 0.8,
      status: 'pending_review',
    })

    const updated = await repo.update(created.id, {
      status: 'approved',
      reviewedBy: 'user-1',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      reviewComment: '质量良好',
    })
    expect(updated?.status).toBe('approved')
    expect(updated?.reviewed_by).toBe('user-1')

    const result = await repo.findByOrg({ status: 'approved', page: 1, limit: 10 })
    expect(result.meta.total).toBe(1)
    expect(result.data[0].status).toBe('approved')
  })

  it('supports embedding lookup and counters', async () => {
    const repo = await import('../../repositories/evolved-skill.repository')

    const created = await repo.create({
      agentId: 'agent-1',
      sessionId: 'session-1',
      name: 'Vector Skill',
      description: 'desc',
      steps: [],
      toolsUsed: [],
      qualityScore: 0.9,
      reusabilityScore: 0.9,
      status: 'approved',
    })

    await repo.updateEmbedding(created.id, [1, 0])
    const similar = await repo.findByEmbedding([1, 0], 5, 0.5, ['approved'])
    expect(similar).toHaveLength(1)
    expect(similar[0].id).toBe(created.id)

    await repo.incrementUseCount(created.id)
    await repo.incrementSuccessCount(created.id)
    const stats = await repo.getStatsByAgent('agent-1')
    expect(stats.total).toBe(1)
    expect(stats.approved).toBe(1)
    expect(stats.totalReuse).toBe(1)
  })

  it('soft deletes and bulk fetches skills', async () => {
    const repo = await import('../../repositories/evolved-skill.repository')

    const keep = await repo.create({
      agentId: 'agent-1',
      sessionId: 'session-1',
      name: 'Keep',
      description: 'desc',
      steps: [],
      toolsUsed: [],
      qualityScore: 0.8,
      reusabilityScore: 0.8,
      status: 'approved',
    })
    const remove = await repo.create({
      agentId: 'agent-1',
      sessionId: 'session-1',
      name: 'Remove',
      description: 'desc',
      steps: [],
      toolsUsed: [],
      qualityScore: 0.7,
      reusabilityScore: 0.7,
      status: 'approved',
    })

    expect((await repo.findByIds([keep.id, remove.id])).map((item) => item.id).sort()).toEqual([keep.id, remove.id].sort())
    expect(await repo.softDelete(remove.id, 'user-1')).toBe(true)
    expect((await repo.findByIds([keep.id, remove.id])).map((item) => item.id)).toEqual([keep.id])
  })
})
