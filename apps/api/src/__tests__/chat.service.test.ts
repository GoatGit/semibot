/**
 * Chat Service 单元测试
 */
import { describe, it, expect, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import {
  createSSEConnection,
  closeSSEConnection,
  sendSSEEvent,
  sendAgent2UIMessage,
} from '../services/chat.service'

// Mock Response 对象
const createMockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {
    setHeader: vi.fn().mockReturnThis() as unknown as Response['setHeader'],
    flushHeaders: vi.fn() as unknown as Response['flushHeaders'],
    write: vi.fn().mockReturnValue(true) as unknown as Response['write'],
    end: vi.fn() as unknown as Response['end'],
    on: vi.fn() as unknown as Response['on'],
  }
  return res
}

describe('Chat Service', () => {
  describe('createSSEConnection', () => {
    it('should create a new SSE connection', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())

      expect(connection).toBeDefined()
      expect(connection.id).toBeDefined()
      expect(connection.sessionId).toBe(sessionId)
      expect(connection.userId).toBe(userId)
      expect(connection.isActive).toBe(true)
    })

    it('should set correct SSE headers', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      createSSEConnection(mockRes, sessionId, userId, uuidv4())

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform')
      expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive')
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no')
    })

    it('should register close event handler', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      createSSEConnection(mockRes, sessionId, userId, uuidv4())

      expect(mockRes.on).toHaveBeenCalledWith('close', expect.any(Function))
    })
  })

  describe('closeSSEConnection', () => {
    it('should close an active connection', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      closeSSEConnection(connection.id)

      expect(connection.isActive).toBe(false)
    })

    it('should handle closing non-existent connection gracefully', () => {
      // 不应该抛出错误
      expect(() => closeSSEConnection('non-existent-id')).not.toThrow()
    })
  })

  describe('sendSSEEvent', () => {
    it('should send event to active connection', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      const result = sendSSEEvent(connection, 'test-event', { message: 'hello' })

      expect(result).toBe(true)
      expect(mockRes.write).toHaveBeenCalledWith('event: test-event\n')
      expect(mockRes.write).toHaveBeenCalledWith('data: {"message":"hello"}\n\n')
    })

    it('should return false for inactive connection', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      closeSSEConnection(connection.id)

      const result = sendSSEEvent(connection, 'test-event', { message: 'hello' })
      expect(result).toBe(false)
    })

    it('should handle write errors gracefully', () => {
      const mockRes = createMockResponse() as Response
      ;(mockRes.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Write error')
      })

      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      const result = sendSSEEvent(connection, 'test-event', { message: 'hello' })

      expect(result).toBe(false)
    })
  })

  describe('sendAgent2UIMessage', () => {
    it('should send message with correct format', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      const result = sendAgent2UIMessage(connection, 'text', { content: 'Hello' })

      expect(result).toBe(true)
      expect(mockRes.write).toHaveBeenCalledWith('event: message\n')
    })

    it('should include metadata when provided', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())
      sendAgent2UIMessage(connection, 'text', { content: 'Hello' }, { source: 'test' })

      // 验证 write 被调用
      expect(mockRes.write).toHaveBeenCalled()
    })

    it('should support all Agent2UI message types', () => {
      const mockRes = createMockResponse() as Response
      const sessionId = uuidv4()
      const userId = uuidv4()

      const connection = createSSEConnection(mockRes, sessionId, userId, uuidv4())

      const messageTypes = [
        'text',
        'markdown',
        'code',
        'table',
        'chart',
        'image',
        'file',
        'plan',
        'progress',
        'tool_call',
        'tool_result',
        'error',
        'thinking',
        'report',
      ] as const

      messageTypes.forEach((type) => {
        const result = sendAgent2UIMessage(connection, type, { content: 'test' })
        expect(result).toBe(true)
      })
    })
  })
})
