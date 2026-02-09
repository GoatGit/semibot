/**
 * Session Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 数据库
vi.mock('../lib/db', () => ({
  sql: vi.fn(),
}))

import { sql } from '../lib/db'

const mockSql = sql as unknown as ReturnType<typeof vi.fn>

describe('Session Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSession', () => {
    it('should create a session with valid input', async () => {
      const mockSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'Test Session',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const { createSession } = await import('../services/session.service')

      const result = await createSession('org-123', 'user-123', {
        agentId: 'agent-123',
        title: 'Test Session',
      })

      expect(result).toBeDefined()
      expect(result.title).toBe('Test Session')
      expect(result.status).toBe('active')
    })
  })

  describe('getSession', () => {
    it('should return session when found', async () => {
      const mockSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'Test Session',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const { getSession } = await import('../services/session.service')

      const result = await getSession('org-123', 'session-123')

      expect(result).toBeDefined()
      expect(result.id).toBe('session-123')
    })

    it('should throw error when session not found', async () => {
      mockSql.mockResolvedValueOnce([])

      const { getSession } = await import('../services/session.service')

      await expect(getSession('org-123', 'nonexistent')).rejects.toThrow('会话不存在')
    })
  })

  describe('listSessions', () => {
    it('should return paginated list of sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          org_id: 'org-123',
          user_id: 'user-123',
          agent_id: 'agent-123',
          title: 'Session 1',
          status: 'active',
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      // Mock whereClause construction
      mockSql.mockReturnValueOnce('org_id = $1 AND user_id = $2')
      // Mock count query - returns total count
      mockSql.mockResolvedValueOnce([{ total: '1' }])
      // Mock list query - returns sessions
      mockSql.mockResolvedValueOnce(mockSessions)

      const { listSessions } = await import('../services/session.service')

      const result = await listSessions('org-123', 'user-123', { page: 1, limit: 10 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })
  })

  describe('updateSessionTitle', () => {
    it('should update session title', async () => {
      const updatedSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'New Title',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([updatedSession])

      const { updateSessionTitle } = await import('../services/session.service')

      const result = await updateSessionTitle('org-123', 'session-123', 'New Title')

      expect(result.title).toBe('New Title')
    })
  })

  describe('updateSessionStatus', () => {
    it('should update session status', async () => {
      const activeSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'Test Session',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const updatedSession = {
        ...activeSession,
        status: 'completed',
        ended_at: new Date().toISOString(),
      }

      // Mock getSession call (to check current status)
      mockSql.mockResolvedValueOnce([activeSession])
      // Mock nested sql`NOW()` call in UPDATE query
      mockSql.mockReturnValueOnce('NOW()')
      // Mock updateStatus call - UPDATE query returns array with updated row
      mockSql.mockResolvedValueOnce([updatedSession])

      const { updateSessionStatus } = await import('../services/session.service')

      const result = await updateSessionStatus('org-123', 'session-123', 'completed')

      expect(result.status).toBe('completed')
    })
  })

  describe('deleteSession', () => {
    it('should delete session when found', async () => {
      const mockSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'Test Session',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Mock getSession call (to verify session exists)
      mockSql.mockResolvedValueOnce([mockSession])
      // Mock deleteBySessionId (delete messages)
      mockSql.mockResolvedValueOnce([])
      // Mock remove (delete session) - should return the deleted row
      mockSql.mockResolvedValueOnce([mockSession])

      const { deleteSession } = await import('../services/session.service')

      await expect(deleteSession('org-123', 'session-123')).resolves.not.toThrow()
    })
  })

  describe('addMessage', () => {
    it('should add a message to session', async () => {
      const mockSession = {
        id: 'session-123',
        org_id: 'org-123',
        user_id: 'user-123',
        agent_id: 'agent-123',
        title: 'Test Session',
        status: 'active',
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const mockMessage = {
        id: 'msg-123',
        session_id: 'session-123',
        role: 'user',
        content: 'Hello',
        parent_id: null,
        tool_calls: null,
        tool_call_id: null,
        tokens_used: null,
        latency_ms: null,
        metadata: {},
        created_at: new Date().toISOString(),
      }

      // Mock getSession call (to verify session exists and check status)
      mockSql.mockResolvedValueOnce([mockSession])
      // Mock countBySessionId call (to check message limit)
      mockSql.mockResolvedValueOnce([{ count: '5' }])
      // Mock create message
      mockSql.mockResolvedValueOnce([mockMessage])

      const { addMessage } = await import('../services/session.service')

      const result = await addMessage('org-123', 'session-123', {
        role: 'user',
        content: 'Hello',
      })

      expect(result.content).toBe('Hello')
      expect(result.role).toBe('user')
    })
  })

  describe('getSessionMessages', () => {
    it('should return messages for a session', async () => {
      const mockMessages = [
        {
          id: 'msg-1',
          session_id: 'session-123',
          role: 'user',
          content: 'Hello',
          parent_id: null,
          tool_calls: null,
          tool_call_id: null,
          tokens_used: null,
          latency_ms: null,
          metadata: {},
          created_at: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          session_id: 'session-123',
          role: 'assistant',
          content: 'Hi there!',
          parent_id: 'msg-1',
          tool_calls: null,
          tool_call_id: null,
          tokens_used: 10,
          latency_ms: 500,
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ]

      // Mock get session
      mockSql.mockResolvedValueOnce([{ id: 'session-123', org_id: 'org-123' }])
      // Mock get messages
      mockSql.mockResolvedValueOnce(mockMessages)

      const { getSessionMessages } = await import('../services/session.service')

      const result = await getSessionMessages('org-123', 'session-123')

      expect(result).toHaveLength(2)
      expect(result[0].role).toBe('user')
      expect(result[1].role).toBe('assistant')
    })
  })
})
