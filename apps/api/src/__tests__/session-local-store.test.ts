import { afterEach, describe, expect, it, vi } from 'vitest'

describe('session-local-store message persistence', () => {
  afterEach(async () => {
    const { closeLocalDb } = await import('../lib/db-local')
    closeLocalDb()
    delete process.env.SEMIBOT_DB_PATH
    vi.resetModules()
  })

  it('persists messages in local sqlite and can read them back by session', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-session-local-store-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')

    const created = store.localCreateMessage({
      sessionId: 'sess-local-1',
      role: 'assistant',
      content: '最终结果',
      metadata: { status: 'completed' },
    })

    expect(created.session_id).toBe('sess-local-1')

    const rows = store.localFindMessagesBySessionId('sess-local-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: created.id,
      role: 'assistant',
      content: '最终结果',
      metadata: { status: 'completed' },
    })
    expect(store.localCountMessagesBySessionId('sess-local-1')).toBe(1)
  })

  it('auto-migrates legacy messages table before inserting attempt-aware messages', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-session-local-store-legacy-${Date.now()}.sqlite`
    vi.resetModules()

    const Database = (await import('better-sqlite3')).default
    const db = new Database(process.env.SEMIBOT_DB_PATH)
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT,
        tool_call_id TEXT,
        tokens_used INTEGER,
        latency_ms INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT
      );
    `)
    db.close()

    const store = await import('../lib/session-local-store')

    const created = store.localCreateMessage({
      sessionId: 'sess-legacy-1',
      attemptId: 'att-legacy-1',
      userMessageId: 'msg-user-legacy-1',
      role: 'assistant',
      content: 'legacy migration works',
    })

    expect(created.attempt_id).toBe('att-legacy-1')
    expect(created.user_message_id).toBe('msg-user-legacy-1')

    const { getLocalDb } = await import('../lib/db-local')
    const cols = getLocalDb().prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>
    expect(cols.map((col) => col.name)).toContain('attempt_id')
    expect(cols.map((col) => col.name)).toContain('user_message_id')
  })

  it('persists runtime attempts and binds assistant artifacts to the same attempt', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-runtime-attempt-store-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'attempt test',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '搜索最新 AI 动态',
    })
    const attempt = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })
    const assistant = store.localCreateMessage({
      sessionId: session.id,
      attemptId: attempt.id,
      userMessageId: user.id,
      role: 'assistant',
      content: '这里是最终结果',
    })

    expect(store.localFindCurrentRuntimeAttempt(session.id)?.id).toBe(attempt.id)
    expect(store.localFindMessagesBySessionId(session.id)[1]).toMatchObject({
      id: assistant.id,
      attempt_id: attempt.id,
      user_message_id: user.id,
    })
  })

  it('claims lease, heartbeats, and lists only stalled running attempts', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-runtime-attempt-lease-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'lease test',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '执行任务',
    })
    const running = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })
    const awaitingApproval = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'awaiting_approval',
    })

    const claimed = store.localClaimRuntimeAttemptLease({
      attemptId: running.id,
      leasedBy: 'worker-1',
      leaseDurationMs: 60_000,
    })
    expect(claimed?.leased_by).toBe('worker-1')
    expect(claimed?.lease_expires_at).toBeTruthy()
    expect(claimed?.heartbeat_at).toBeTruthy()

    const heartbeat = store.localHeartbeatRuntimeAttempt({
      attemptId: running.id,
      leasedBy: 'worker-1',
      leaseDurationMs: 60_000,
    })
    expect(heartbeat?.leased_by).toBe('worker-1')
    expect(heartbeat?.lease_expires_at).toBeTruthy()

    store.localUpdateRuntimeAttempt(running.id, {
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    })
    store.localUpdateRuntimeAttempt(awaitingApproval.id, {
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
      leasedBy: 'worker-2',
    })

    const stalled = store.localListStalledRuntimeAttempts({
      nowIso: '2000-01-01T00:00:01.000Z',
    })
    expect(stalled.map((row) => row.id)).toEqual([running.id])
  })
})
