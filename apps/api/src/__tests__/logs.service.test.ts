/**
 * Logs Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as logsService from '../services/logs.service'
import * as logsRepository from '../repositories/logs.repository'

// Mock repository
vi.mock('../repositories/logs.repository')

const mockLogsRepository = logsRepository as typeof logsRepository & {
  createExecutionLog: ReturnType<typeof vi.fn>
  findExecutionLogs: ReturnType<typeof vi.fn>
  findUsageRecords: ReturnType<typeof vi.fn>
  getUsageSummary: ReturnType<typeof vi.fn>
  upsertUsageRecord: ReturnType<typeof vi.fn>
}

describe('Logs Service', () => {
  const mockOrgId = 'org-123'
  const mockAgentId = 'agent-123'
  const mockSessionId = 'session-123'

  const mockExecutionLogRow: logsRepository.ExecutionLogRow = {
    id: 'log-123',
    org_id: mockOrgId,
    agent_id: mockAgentId,
    session_id: mockSessionId,
    request_id: 'req-123',
    step_id: 'step-1',
    action_id: 'action-1',
    state: 'ACT',
    action_type: 'tool_call',
    action_name: 'web_search',
    action_input: { query: 'test' },
    action_output: { results: [] },
    error_code: null,
    error_message: null,
    retry_count: 0,
    duration_ms: 150,
    tokens_input: 100,
    tokens_output: 50,
    model: 'gpt-4',
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  }

  const mockUsageRecordRow: logsRepository.UsageRecordRow = {
    id: 'usage-123',
    org_id: mockOrgId,
    user_id: null,
    agent_id: null,
    period_start: '2026-01-01T00:00:00Z',
    period_end: '2026-01-01T23:59:59Z',
    period_type: 'daily',
    tokens_input: 10000,
    tokens_output: 5000,
    api_calls: 100,
    tool_calls: 50,
    sessions_count: 10,
    messages_count: 200,
    errors_count: 2,
    cost_usd: 0.5,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('logExecution', () => {
    it('should create execution log successfully', async () => {
      mockLogsRepository.createExecutionLog.mockResolvedValue(mockExecutionLogRow)

      const input = {
        agentId: mockAgentId,
        sessionId: mockSessionId,
        state: 'ACT',
        actionType: 'tool_call',
        actionName: 'web_search',
        actionInput: { query: 'test' },
      }

      const result = await logsService.logExecution(mockOrgId, input)

      expect(result).toBeDefined()
      expect(result.state).toBe('ACT')
      expect(result.actionName).toBe('web_search')
      expect(mockLogsRepository.createExecutionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          agentId: mockAgentId,
          sessionId: mockSessionId,
        })
      )
    })

    it('should include optional fields', async () => {
      mockLogsRepository.createExecutionLog.mockResolvedValue(mockExecutionLogRow)

      const input = {
        agentId: mockAgentId,
        sessionId: mockSessionId,
        state: 'ACT',
        requestId: 'req-123',
        stepId: 'step-1',
        durationMs: 150,
        tokensInput: 100,
        tokensOutput: 50,
        model: 'gpt-4',
      }

      await logsService.logExecution(mockOrgId, input)

      expect(mockLogsRepository.createExecutionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-123',
          stepId: 'step-1',
          durationMs: 150,
        })
      )
    })
  })

  describe('listExecutionLogs', () => {
    it('should return paginated execution logs', async () => {
      mockLogsRepository.findExecutionLogs.mockResolvedValue({
        data: [mockExecutionLogRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await logsService.listExecutionLogs(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })

    it('should support agent filter', async () => {
      mockLogsRepository.findExecutionLogs.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs(mockOrgId, { agentId: mockAgentId })

      expect(mockLogsRepository.findExecutionLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: mockAgentId,
        })
      )
    })

    it('should support date range filter', async () => {
      mockLogsRepository.findExecutionLogs.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs(mockOrgId, {
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T23:59:59Z',
      })

      expect(mockLogsRepository.findExecutionLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-01-31T23:59:59Z',
        })
      )
    })

    it('should support error code filter', async () => {
      mockLogsRepository.findExecutionLogs.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs(mockOrgId, { errorCode: 'TOOL_ERROR' })

      expect(mockLogsRepository.findExecutionLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'TOOL_ERROR',
        })
      )
    })
  })

  describe('listUsageRecords', () => {
    it('should return paginated usage records', async () => {
      mockLogsRepository.findUsageRecords.mockResolvedValue({
        data: [mockUsageRecordRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await logsService.listUsageRecords(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })

    it('should support period type filter', async () => {
      mockLogsRepository.findUsageRecords.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listUsageRecords(mockOrgId, { periodType: 'monthly' })

      expect(mockLogsRepository.findUsageRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          periodType: 'monthly',
        })
      )
    })
  })

  describe('getUsageSummary', () => {
    it('should return usage summary with totals', async () => {
      mockLogsRepository.getUsageSummary.mockResolvedValue({
        tokensInput: 10000,
        tokensOutput: 5000,
        apiCalls: 100,
        toolCalls: 50,
        sessionsCount: 10,
        messagesCount: 200,
        errorsCount: 2,
        costUsd: 0.5,
      })

      const result = await logsService.getUsageSummary(
        mockOrgId,
        'daily',
        '2026-01-01T00:00:00Z',
        '2026-01-31T23:59:59Z'
      )

      expect(result.tokensInput).toBe(10000)
      expect(result.tokensOutput).toBe(5000)
      expect(result.tokensTotal).toBe(15000)
      expect(result.apiCalls).toBe(100)
      expect(result.costUsd).toBe(0.5)
    })
  })

  describe('recordUsage', () => {
    it('should upsert usage record', async () => {
      mockLogsRepository.upsertUsageRecord.mockResolvedValue(mockUsageRecordRow)

      const result = await logsService.recordUsage(
        mockOrgId,
        'daily',
        '2026-01-01T00:00:00Z',
        '2026-01-01T23:59:59Z',
        {
          tokensInput: 100,
          tokensOutput: 50,
          apiCalls: 1,
        }
      )

      expect(result).toBeDefined()
      expect(result.periodType).toBe('daily')
      expect(mockLogsRepository.upsertUsageRecord).toHaveBeenCalledWith(
        mockOrgId,
        'daily',
        '2026-01-01T00:00:00Z',
        '2026-01-01T23:59:59Z',
        expect.objectContaining({
          tokensInput: 100,
          tokensOutput: 50,
        })
      )
    })
  })
})
