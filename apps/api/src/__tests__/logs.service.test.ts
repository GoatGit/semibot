/**
 * Logs Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as logsService from '../services/logs.service'
import * as logsLocalStore from '../lib/logs-local-store'

vi.mock('../lib/logs-local-store')

const mockLogsLocalStore = logsLocalStore as typeof logsLocalStore & {
  localCreateExecutionLog: ReturnType<typeof vi.fn>
  localFindExecutionLogsByAgent: ReturnType<typeof vi.fn>
  localFindUsageRecords: ReturnType<typeof vi.fn>
  localUpsertUsageRecord: ReturnType<typeof vi.fn>
}

describe('Logs Service', () => {
  const mockAgentId = 'agent-123'
  const mockSessionId = 'session-123'

  const mockExecutionLogRow: logsLocalStore.LocalExecutionLogRow = {
    id: 'log-123',
    org_id: 'local',
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

  const mockUsageRecordRow: logsLocalStore.LocalUsageRecordRow = {
    id: 'usage-123',
    org_id: 'local',
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
      mockLogsLocalStore.localCreateExecutionLog.mockReturnValue(mockExecutionLogRow)

      const input = {
        agentId: mockAgentId,
        sessionId: mockSessionId,
        state: 'ACT',
        actionType: 'tool_call',
        actionName: 'web_search',
        actionInput: { query: 'test' },
      }

      const result = await logsService.logExecution(input)

      expect(result).toBeDefined()
      expect(result.state).toBe('ACT')
      expect(result.actionName).toBe('web_search')
      expect(mockLogsLocalStore.localCreateExecutionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: mockAgentId,
          sessionId: mockSessionId,
        })
      )
    })

    it('should include optional fields', async () => {
      mockLogsLocalStore.localCreateExecutionLog.mockReturnValue(mockExecutionLogRow)

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

      await logsService.logExecution(input)

      expect(mockLogsLocalStore.localCreateExecutionLog).toHaveBeenCalledWith(
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
      mockLogsLocalStore.localFindExecutionLogsByAgent.mockReturnValue({
        data: [mockExecutionLogRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await logsService.listExecutionLogs({ page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })

    it('should support agent filter', async () => {
      mockLogsLocalStore.localFindExecutionLogsByAgent.mockReturnValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs({ agentId: mockAgentId })

      expect(mockLogsLocalStore.localFindExecutionLogsByAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: mockAgentId,
        })
      )
    })

    it('should support date range filter', async () => {
      mockLogsLocalStore.localFindExecutionLogsByAgent.mockReturnValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs({
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T23:59:59Z',
      })

      expect(mockLogsLocalStore.localFindExecutionLogsByAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-01-31T23:59:59Z',
        })
      )
    })

    it('should support error code filter', async () => {
      mockLogsLocalStore.localFindExecutionLogsByAgent.mockReturnValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listExecutionLogs({ errorCode: 'TOOL_ERROR' })

      expect(mockLogsLocalStore.localFindExecutionLogsByAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: '',
        })
      )
    })
  })

  describe('listUsageRecords', () => {
    it('should return paginated usage records', async () => {
      mockLogsLocalStore.localFindUsageRecords.mockReturnValue({
        data: [mockUsageRecordRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await logsService.listUsageRecords({ page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })

    it('should support period type filter', async () => {
      mockLogsLocalStore.localFindUsageRecords.mockReturnValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await logsService.listUsageRecords({ periodType: 'monthly' })

      expect(mockLogsLocalStore.localFindUsageRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          periodType: 'monthly',
        })
      )
    })
  })

  describe('getUsageSummary', () => {
    it('should return usage summary with totals', async () => {
      mockLogsLocalStore.localFindUsageRecords.mockReturnValue({
        data: [mockUsageRecordRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await logsService.getUsageSummary(
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
      mockLogsLocalStore.localUpsertUsageRecord.mockReturnValue(mockUsageRecordRow)

      const result = await logsService.recordUsage(
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
      expect(mockLogsLocalStore.localUpsertUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          periodType: 'daily',
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-01T23:59:59Z',
          tokensInput: 100,
          tokensOutput: 50,
        })
      )
    })
  })
})
