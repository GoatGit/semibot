import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('AgentRepository', () => {
  let dbPath = ''

  beforeEach(async () => {
    dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-agent-repo-')), 'semibot.db')
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

  it('creates and fetches an agent', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    const created = await agentRepository.create({
      name: 'Test Agent',
      description: 'Test description',
      systemPrompt: 'You are a helpful assistant',
      config: {},
    })

    expect(created.name).toBe('Test Agent')
    expect(created.is_active).toBe(true)
    expect(created.is_system).toBe(false)

    const found = await agentRepository.findById(created.id)
    expect(found?.id).toBe(created.id)
  })

  it('lists agents with pagination and search', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    await agentRepository.create({ name: 'Alpha Agent', systemPrompt: 'a', config: {} })
    await agentRepository.create({ name: 'Beta Agent', systemPrompt: 'b', config: {} })

    const searchResult = await agentRepository.findByOrg({ search: 'Alpha' })
    expect(searchResult.data).toHaveLength(1)
    expect(searchResult.data[0].name).toBe('Alpha Agent')

    const pageResult = await agentRepository.findByOrg({ page: 1, limit: 1 })
    expect(pageResult.data).toHaveLength(1)
    expect(pageResult.meta.total).toBe(2)
    expect(pageResult.meta.totalPages).toBe(2)
  })

  it('updates non-system agent and blocks system agent updates', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    const created = await agentRepository.create({
      name: 'Editable Agent',
      systemPrompt: 'prompt',
      config: {},
    })
    const updated = await agentRepository.update(created.id, { name: 'Updated Name' })
    expect(updated?.name).toBe('Updated Name')
    expect(updated?.version).toBe(2)

    const systemAgent = await agentRepository.ensureSystemDefault()
    const blocked = await agentRepository.update(systemAgent.id, { name: 'Nope' })
    expect(blocked).toBeNull()
  })

  it('soft deletes agents and excludes them from listings', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    const created = await agentRepository.create({
      name: 'Delete Me',
      systemPrompt: 'prompt',
      config: {},
    })
    expect(await agentRepository.countByOrg()).toBe(1)

    const deleted = await agentRepository.softDelete(created.id, 'user-1')
    expect(deleted).toBe(true)
    expect(await agentRepository.findById(created.id)).toBeNull()
    expect(await agentRepository.countByOrg()).toBe(0)
  })

  it('finds the system default when ensured', async () => {
    const agentRepository = await import('../../repositories/agent.repository')

    expect(await agentRepository.findSystemDefault()).toBeNull()
    const ensured = await agentRepository.ensureSystemDefault()
    expect((await agentRepository.findSystemDefault())?.id).toBe(ensured.id)
  })
})
