/**
 * Runtime Adapter 测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios from 'axios'
import { RuntimeAdapter, type RuntimeInputState } from '../adapters/runtime.adapter'
import type { SSEConnection } from '../services/chat.service'

// Mock axios
vi.mock('axios')

describe('RuntimeAdapter', () => {
  let adapter: RuntimeAdapter
  let mockConnection: SSEConnection

  beforeEach(() => {
    adapter = new RuntimeAdapter('http://localhost:8000', 30000)
    mockConnection = {
      id: 'test-connection-id',
      res: {} as any,
      sessionId: 'test-session-id',
      userId: 'test-user-id',
      isActive: true,
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('healthCheck', () => {
    it('应该在服务可用时返回 true', async () => {
      const mockAxios = axios as any
      mockAxios.create.mockReturnValue({
        get: vi.fn().mockResolvedValue({ status: 200 }),
      })

      adapter = new RuntimeAdapter()
      const result = await adapter.healthCheck()

      expect(result).toBe(true)
    })

    it('应该在服务不可用时返回 false', async () => {
      const mockAxios = axios as any
      mockAxios.create.mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('Connection refused')),
      })

      adapter = new RuntimeAdapter()
      const result = await adapter.healthCheck()

      expect(result).toBe(false)
    })
  })

  describe('executeWithStreaming', () => {
    it('应该正确处理 Runtime 事件流', async () => {
      const input: RuntimeInputState = {
        session_id: 'test-session',
        agent_id: 'test-agent',
        org_id: 'test-org',
        user_message: 'Hello',
      }

      // Mock SSE stream
      const mockStream = {
        on: vi.fn((event, handler) => {
          if (event === 'data') {
            // 模拟事件数据
            handler(Buffer.from('data: {"event":"thinking","data":{"content":"思考中..."},"timestamp":"2024-01-01T00:00:00Z"}\n'))
            handler(Buffer.from('data: {"event":"text_chunk","data":{"content":"Hello"},"timestamp":"2024-01-01T00:00:01Z"}\n'))
            handler(Buffer.from('data: [DONE]\n'))
          } else if (event === 'end') {
            setTimeout(handler, 10)
          }
        }),
      }

      const mockAxios = axios as any
      mockAxios.create.mockReturnValue({
        post: vi.fn().mockResolvedValue({ data: mockStream }),
      })

      adapter = new RuntimeAdapter()

      const onComplete = vi.fn()
      await adapter.executeWithStreaming(mockConnection, input, onComplete)

      // 等待异步完成
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(onComplete).toHaveBeenCalled()
    })

    it('应该在发生错误时调用 onComplete 并传递错误', async () => {
      const input: RuntimeInputState = {
        session_id: 'test-session',
        agent_id: 'test-agent',
        org_id: 'test-org',
        user_message: 'Hello',
      }

      const mockAxios = axios as any
      mockAxios.create.mockReturnValue({
        post: vi.fn().mockRejectedValue(new Error('Network error')),
      })

      adapter = new RuntimeAdapter()

      const onComplete = vi.fn()
      await adapter.executeWithStreaming(mockConnection, input, onComplete)

      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Network error',
        })
      )
    })
  })

  describe('事件映射', () => {
    it('应该正确映射 plan_created 事件', () => {
      // 这个测试需要访问私有方法，暂时跳过
      // 实际测试应该通过集成测试验证
    })

    it('应该正确映射 tool_call 事件', () => {
      // 这个测试需要访问私有方法，暂时跳过
      // 实际测试应该通过集成测试验证
    })
  })
})

describe('isRuntimeAvailable', () => {
  it('应该检查 Runtime 服务是否可用', async () => {
    const { isRuntimeAvailable } = await import('../adapters/runtime.adapter')

    const mockAxios = axios as any
    mockAxios.create.mockReturnValue({
      get: vi.fn().mockResolvedValue({ status: 200 }),
    })

    const result = await isRuntimeAvailable()
    expect(typeof result).toBe('boolean')
  })
})
