import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import path from 'path'

import { WSServer } from '../ws/ws-server'
import * as logsService from '../services/logs.service'
import * as sessionService from '../services/session.service'
import * as evolvedSkillRepo from '../repositories/evolved-skill.repository'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'

describe('ws-server request/fire_and_forget internals', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loadSkillPackage returns package files from package path', async () => {
    const tmpRoot = path.join('/tmp', `skill-pkg-${Date.now()}`)
    await fs.ensureDir(path.join(tmpRoot, 'scripts'))
    await fs.writeFile(path.join(tmpRoot, 'SKILL.md'), '# skill', 'utf-8')
    await fs.writeFile(path.join(tmpRoot, 'scripts', 'main.py'), 'print(1)', 'utf-8')

    vi.spyOn(skillDefinitionRepo, 'findBySkillId').mockResolvedValue({
      id: 'def-1',
      skillId: 'skill-1',
      name: 'Skill 1',
      description: 'd',
      triggerKeywords: [],
      isActive: true,
      isPublic: false,
      createdBy: 'u',
      createdAt: '',
      updatedAt: '',
    })

    vi.spyOn(skillPackageRepo, 'findByDefinition').mockResolvedValue({
      id: 'pkg-1',
      skillDefinitionId: 'def-1',
      sourceType: 'local',
      packagePath: tmpRoot,
      sourceUrl: undefined,
      packageSizeBytes: 1,
      checksumSha256: 'x',
      status: 'active',
      validationResult: {},
      tools: [],
      config: {},
      createdAt: '',
      updatedAt: '',
    })

    const server = Object.create(WSServer.prototype) as any
    const result = await server.loadSkillPackage('skill-1')

    expect(result.package.skill_id).toBe('skill-1')
    expect(result.package.files.some((f: { path: string }) => f.path === 'SKILL.md')).toBe(true)
    expect(result.package.files.some((f: { path: string }) => f.path === 'scripts/main.py')).toBe(true)

    await fs.remove(tmpRoot)
  })

  it('handleFireAndForget dispatches usage/audit/evolution', async () => {
    const server = Object.create(WSServer.prototype) as any

    vi.spyOn(logsService, 'recordUsage').mockResolvedValue({} as any)
    vi.spyOn(logsService, 'logExecution').mockResolvedValue({} as any)
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      id: 's1',
      agentId: 'a1',
      orgId: 'o1',
      userId: 'u1',
      status: 'active',
      startedAt: '',
      createdAt: '',
    })
    vi.spyOn(evolvedSkillRepo, 'create').mockResolvedValue({} as any)

    const conn = { orgId: 'o1', userId: 'u1' }

    await server.handleFireAndForget(conn, {
      type: 'fire_and_forget',
      session_id: 's1',
      method: 'usage_report',
      params: { tokens_in: 10, tokens_out: 20 },
    })

    await server.handleFireAndForget(conn, {
      type: 'fire_and_forget',
      session_id: 's1',
      method: 'audit_log',
      params: { event: 'x', details: { ok: true } },
    })

    await server.handleFireAndForget(conn, {
      type: 'fire_and_forget',
      session_id: 's1',
      method: 'evolution_submit',
      params: { name: 'n', description: 'd', quality_score: 0.9, skill_md: '#md' },
    })

    expect(logsService.recordUsage).toHaveBeenCalled()
    expect(logsService.logExecution).toHaveBeenCalled()
    expect(evolvedSkillRepo.create).toHaveBeenCalled()
  })

  it('handleResume returns cached request results', async () => {
    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    const conn = {
      ws: {
        send: (payload: string) => sent.push(JSON.parse(payload)),
      },
      requestResults: new Map([
        ['ok-1', { status: 'completed', data: { value: 1 }, updatedAt: Date.now() }],
        ['err-1', { status: 'failed', error: { code: 'REQUEST_FAILED', message: 'x' }, updatedAt: Date.now() }],
      ]),
    }

    server.handleResume(conn, { type: 'resume', pending_ids: ['ok-1', 'err-1', 'lost-1'] })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'resume_response',
      results: {
        'ok-1': { status: 'completed', data: { value: 1 } },
        'err-1': { status: 'failed', error: { code: 'REQUEST_FAILED', message: 'x' } },
        'lost-1': { status: 'lost' },
      },
    })
  })

  it('handleMessage ignores invalid json payload safely', async () => {
    const server = Object.create(WSServer.prototype) as any
    const conn = {
      userId: 'u1',
      lastHeartbeat: Date.now(),
      activeSessions: new Set<string>(),
    }

    await expect(server.handleMessage(conn, '{invalid json')).resolves.toBeUndefined()
  })
})
