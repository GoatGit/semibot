import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockFindByIdAndOrg = vi.fn()
const mockFindBySessionId = vi.fn()
const mockRuntimeRequest = vi.fn()
const mockGetLocalDb = vi.fn()
const mockReadDir = vi.fn()
const mockReadFile = vi.fn()

vi.mock('../repositories/session.repository', () => ({
  findByIdAndOrg: mockFindByIdAndOrg,
}))

vi.mock('../repositories/message.repository', () => ({
  findBySessionId: mockFindBySessionId,
}))

vi.mock('../lib/runtime-client', () => ({
  runtimeRequest: mockRuntimeRequest,
}))

vi.mock('../lib/db-local', () => ({
  getLocalDb: mockGetLocalDb,
}))

vi.mock('fs/promises', () => ({
  default: {
    readdir: mockReadDir,
    readFile: mockReadFile,
  },
  readdir: mockReadDir,
  readFile: mockReadFile,
}))

describe('session.service', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFindByIdAndOrg.mockReset()
    mockFindBySessionId.mockReset()
    mockRuntimeRequest.mockReset()
    mockGetLocalDb.mockReset()
    mockReadDir.mockReset()
    mockReadFile.mockReset()
    mockGetLocalDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
      })),
    })
    mockReadDir.mockRejectedValue(new Error('no checkpoints'))
    mockReadFile.mockRejectedValue(new Error('no checkpoint file'))
  })

  it('returns persisted session even when runtime /v1/sessions is unavailable', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-1',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Test Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    mockRuntimeRequest.mockRejectedValue(new Error('Runtime unavailable for /v1/events: aborted'))

    const { getSession } = await import('../services/session.service')
    const session = await getSession('sess-1')

    expect(session.id).toBe('sess-1')
    expect(session.status).toBe('active')
    expect(session.title).toBe('Test Session')
  })

  it('reconciles persisted active session to completed from runtime terminal events', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-2',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Completed Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    mockRuntimeRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/events') {
        return {
          items: [
            {
              event_type: 'task.completed',
              payload: { session_id: 'sess-2' },
              timestamp: '2026-03-28T08:05:00.000Z',
            },
          ],
        }
      }
      if (path === '/v1/approvals') {
        return {
          items: [{ id: 'appr_1', status: 'pending' }],
        }
      }
      throw new Error(`unexpected runtime path: ${path}`)
    })

    const { getSession } = await import('../services/session.service')
    const session = await getSession('sess-2')

    expect(session.status).toBe('completed')
    expect(session.endedAt).toBe('2026-03-28T08:05:00.000Z')
    expect(session.metadata).toMatchObject({
      runtime_terminal_event_type: 'task.completed',
    })
  })

  it('does not reconcile persisted active session to completed when runtime completion is awaiting approval', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-3',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Awaiting Approval Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    mockRuntimeRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/events') {
        return {
          items: [
            {
              event_type: 'task.completed',
              payload: { session_id: 'sess-3', pending_approval_ids: ['appr_1'] },
              timestamp: '2026-03-28T08:05:00.000Z',
            },
          ],
        }
      }
      if (path === '/v1/approvals') {
        return {
          items: [{ id: 'appr_1', status: 'pending' }],
        }
      }
      throw new Error(`unexpected runtime path: ${path}`)
    })

    const { getSession } = await import('../services/session.service')
    const session = await getSession('sess-3')

    expect(session.status).toBe('active')
    expect(session.endedAt).toBeUndefined()
    expect(session.metadata).not.toMatchObject({
      runtime_terminal_event_type: 'task.completed',
    })
  })

  it('does not reconcile persisted active session to completed when legacy runtime emits approval-waiting final_response', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-4',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Legacy Awaiting Approval Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    mockRuntimeRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/events') {
        return {
          items: [
            {
              event_type: 'task.completed',
              payload: {
                session_id: 'sess-4',
                final_response: '操作需要人工审批后继续。\n\n待审批 ID: appr_legacy_1\n请在审批面板中通过或拒绝后继续。',
              },
              timestamp: '2026-03-28T08:05:00.000Z',
            },
          ],
        }
      }
      if (path === '/v1/approvals') {
        return {
          items: [{ id: 'appr_1', status: 'pending' }],
        }
      }
      throw new Error(`unexpected runtime path: ${path}`)
    })

    const { getSession } = await import('../services/session.service')
    const session = await getSession('sess-4')

    expect(session.status).toBe('active')
    expect(session.endedAt).toBeUndefined()
    expect(session.metadata).not.toMatchObject({
      runtime_terminal_event_type: 'task.completed',
    })
  })

  it('derives awaiting approval runState/notices from current attempt and checkpoint', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-5',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Approval Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })
    mockFindBySessionId.mockResolvedValue([
      {
        id: 'msg-user-1',
        session_id: 'sess-5',
        parent_id: null,
        role: 'user',
        content: '搜索最新的 AI 行业动态并总结',
        tool_calls: null,
        tool_call_id: null,
        tokens_used: null,
        latency_ms: null,
        metadata: null,
        created_at: '2026-03-28T08:00:00.000Z',
      },
      {
        id: 'msg-assistant-1',
        session_id: 'sess-5',
        parent_id: null,
        role: 'assistant',
        content: '已有部分历史回答',
        tool_calls: null,
        tool_call_id: null,
        tokens_used: null,
        latency_ms: null,
        metadata: null,
        created_at: '2026-03-28T08:01:00.000Z',
      },
    ])

    mockRuntimeRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/approvals') {
        return {
          items: [{ id: 'appr_1', status: 'pending' }],
        }
      }
      throw new Error(`unexpected runtime path: ${path}`)
    })
    mockGetLocalDb.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('JOIN runtime_attempts a ON a.id = s.current_attempt_id')) {
          return {
            get: vi.fn(() => ({
              id: 'att-5',
              session_id: 'sess-5',
              user_message_id: 'msg-user-1',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'direct_reasoning',
              status: 'awaiting_approval',
              approval_set_revision: 1,
              approval_block_count: 1,
              resume_count: 0,
              latest_revision: 1,
              checkpoint_id: 'cp-5',
              artifact_message_id: null,
              terminal_reason: null,
              leased_by: null,
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:02:00.000Z',
              ended_at: null,
            })),
          }
        }
        if (sql.includes('FROM runtime_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')) {
          return {
            all: vi.fn(() => [{
              id: 'att-5',
              session_id: 'sess-5',
              user_message_id: 'msg-user-1',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'direct_reasoning',
              status: 'awaiting_approval',
              approval_set_revision: 1,
              approval_block_count: 1,
              resume_count: 0,
              latest_revision: 1,
              checkpoint_id: 'cp-5',
              artifact_message_id: null,
              terminal_reason: null,
              leased_by: null,
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:02:00.000Z',
              ended_at: null,
            }]),
          }
        }
        if (sql.includes('SELECT * FROM runtime_attempt_checkpoints WHERE checkpoint_id = ?')) {
          return {
            get: vi.fn(() => ({
              checkpoint_id: 'cp-5',
              attempt_id: 'att-5',
              session_id: 'sess-5',
              user_message_id: 'msg-user-1',
              status: 'awaiting_approval',
              revision: 1,
              payload_json: JSON.stringify({
                pending_approval_ids: ['appr_1'],
                awaiting_approval_message: '操作需要人工审批后继续。',
              }),
              created_at: '2026-03-28T08:02:00.000Z',
            })),
          }
        }
        return {
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        }
      }),
    })

    const { getSessionView } = await import('../services/session.service')
    const view = await getSessionView('sess-5')

    expect(view.messages).toHaveLength(2)
    expect(view.messages.map((item) => item.id)).toEqual(['msg-user-1', 'msg-assistant-1'])
    expect(view.runState).toMatchObject({
      sessionId: 'sess-5',
      status: 'awaiting_approval',
      pendingApprovalIds: ['appr_1'],
    })
    expect(view.notices).toEqual([
      expect.objectContaining({
        kind: 'awaiting_approval',
        approvalIds: ['appr_1'],
      }),
    ])
  })

  it('returns null runtime projection when there is no current attempt', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-6',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Stale Awaiting Approval',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })
    mockFindBySessionId.mockResolvedValue([])
    mockRuntimeRequest.mockRejectedValue(new Error('runtime unavailable'))

    const { getSessionView } = await import('../services/session.service')
    const view = await getSessionView('sess-6')

    expect(view.runState).toBeNull()
    expect(view.notices).toEqual([])
    expect(view.processTrace).toBeNull()
  })

  it('prefers current running attempt over stale awaiting approval checkpoint projection', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-7',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Resumed Attempt Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
      current_attempt_id: 'att-7',
    })
    mockFindBySessionId.mockResolvedValue([])

    mockReadDir.mockRejectedValue(new Error('no checkpoints'))
    mockReadFile.mockRejectedValue(new Error('no checkpoint file'))

    mockRuntimeRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/events') {
        return { items: [] }
      }
      if (path === '/v1/approvals') {
        return { items: [] }
      }
      throw new Error(`unexpected runtime path: ${path}`)
    })

    const mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('JOIN runtime_attempts a ON a.id = s.current_attempt_id')) {
          return {
            get: vi.fn(() => ({
              id: 'att-7',
              session_id: 'sess-7',
              user_message_id: 'msg-user-7',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'direct_reasoning',
              status: 'running',
              approval_set_revision: 1,
              approval_block_count: 1,
              resume_count: 1,
              latest_revision: 1,
              checkpoint_id: 'cp-7',
              artifact_message_id: null,
              terminal_reason: null,
              leased_by: 'worker-1',
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:05:00.000Z',
              ended_at: null,
            })),
          }
        }
        if (sql.includes('FROM runtime_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')) {
          return {
            all: vi.fn(() => [{
              id: 'att-7',
              session_id: 'sess-7',
              user_message_id: 'msg-user-7',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'direct_reasoning',
              status: 'running',
              approval_set_revision: 1,
              approval_block_count: 1,
              resume_count: 1,
              latest_revision: 1,
              checkpoint_id: 'cp-7',
              artifact_message_id: null,
              terminal_reason: null,
              leased_by: 'worker-1',
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:05:00.000Z',
              ended_at: null,
            }]),
          }
        }
        if (sql.includes('SELECT * FROM runtime_attempt_checkpoints WHERE checkpoint_id = ?')) {
          return {
            get: vi.fn(() => ({
              checkpoint_id: 'cp-7',
              attempt_id: 'att-7',
              session_id: 'sess-7',
              user_message_id: 'msg-user-7',
              status: 'awaiting_approval',
              revision: 1,
              payload_json: JSON.stringify({
                status: 'awaiting_approval',
                pending_approval_ids: ['appr_7'],
                awaiting_approval_message: '操作需要人工审批后继续。',
              }),
              created_at: '2026-03-28T08:01:00.000Z',
            })),
          }
        }
        return {
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        }
      }),
    }
    mockGetLocalDb.mockReturnValue(mockDb)

    const { getSessionView } = await import('../services/session.service')
    const view = await getSessionView('sess-7')

    expect(view.currentAttempt?.status).toBe('running')
    expect(view.runState?.status).toBe('running')
    expect(view.notices.find((notice) => notice.kind === 'awaiting_approval')).toBeUndefined()
  })

  it('projects failed session status from current failed attempt', async () => {
    mockFindByIdAndOrg.mockResolvedValue({
      id: 'sess-stalled',
      org_id: 'local',
      agent_id: 'agent-1',
      user_id: 'user-1',
      status: 'active',
      title: 'Stalled Session',
      metadata_json: null,
      started_at: '2026-03-28T08:00:00.000Z',
      ended_at: null,
      created_at: '2026-03-28T08:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })
    mockFindBySessionId.mockResolvedValue([])
    mockRuntimeRequest.mockRejectedValue(new Error('runtime unavailable'))
    mockGetLocalDb.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('JOIN runtime_attempts a ON a.id = s.current_attempt_id')) {
          return {
            get: vi.fn(() => ({
              id: 'att-stalled',
              session_id: 'sess-stalled',
              user_message_id: 'msg-user-stalled',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'plan_act',
              status: 'failed',
              approval_set_revision: 0,
              approval_block_count: 0,
              resume_count: 0,
              latest_revision: 2,
              checkpoint_id: 'cp-stalled',
              artifact_message_id: null,
              terminal_reason: 'web_fetch request failed: ConnectError',
              leased_by: null,
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:00:05.000Z',
              ended_at: '2026-03-28T08:00:05.000Z',
            })),
          }
        }
        if (sql.includes('FROM runtime_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')) {
          return {
            all: vi.fn(() => [{
              id: 'att-stalled',
              session_id: 'sess-stalled',
              user_message_id: 'msg-user-stalled',
              agent_id: 'agent-1',
              attempt_seq: 1,
              execution_mode: 'plan_act',
              status: 'failed',
              approval_set_revision: 0,
              approval_block_count: 0,
              resume_count: 0,
              latest_revision: 2,
              checkpoint_id: 'cp-stalled',
              artifact_message_id: null,
              terminal_reason: 'web_fetch request failed: ConnectError',
              leased_by: null,
              lease_expires_at: null,
              heartbeat_at: null,
              metadata_json: '{}',
              started_at: '2026-03-28T08:00:00.000Z',
              updated_at: '2026-03-28T08:00:05.000Z',
              ended_at: '2026-03-28T08:00:05.000Z',
            }]),
          }
        }
        if (sql.includes('SELECT * FROM runtime_attempt_checkpoints WHERE checkpoint_id = ?')) {
          return {
            get: vi.fn(() => ({
              checkpoint_id: 'cp-stalled',
              attempt_id: 'att-stalled',
              session_id: 'sess-stalled',
              user_message_id: 'msg-user-stalled',
              status: 'failed',
              revision: 2,
              payload_json: JSON.stringify({}),
              created_at: '2026-03-28T08:00:05.000Z',
            })),
          }
        }
        return {
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        }
      }),
    })

    const { getSessionView } = await import('../services/session.service')
    const view = await getSessionView('sess-stalled')

    expect(view.session.status).toBe('failed')
    expect(view.runState).toMatchObject({
      status: 'failed',
      error: 'web_fetch request failed: ConnectError',
    })
    expect(view.notices).toEqual([
      {
        kind: 'error',
        code: 'RUN_FAILED',
        message: 'web_fetch request failed: ConnectError',
      },
    ])
  })
})
