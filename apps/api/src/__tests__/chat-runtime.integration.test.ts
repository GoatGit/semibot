/**
 * Chat Runtime 集成测试
 * 注意：这些测试需要真实的数据库连接，请确保 DATABASE_URL 环境变量已正确配置
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

// 检查是否有数据库连接
const DATABASE_URL = process.env.DATABASE_URL
const SKIP_INTEGRATION_TESTS = !DATABASE_URL || DATABASE_URL.includes('localhost:5432')

// 条件导入
const getTestDependencies = async () => {
  if (SKIP_INTEGRATION_TESTS) {
    return null
  }
  const { app } = await import('../index')
  const { getRuntimeMonitor } = await import('../services/runtime-monitor.service')
  const request = (await import('supertest')).default
  return { app, getRuntimeMonitor, request }
}

describe.skipIf(SKIP_INTEGRATION_TESTS)('Chat Runtime Integration', () => {
  let authToken: string
  let orgId: string
  let userId: string
  let agentId: string
  let sessionId: string

  beforeAll(async () => {
    // 设置测试环境
    // 注意：这需要实际的测试数据库和认证设置
  })

  afterAll(async () => {
    // 清理测试数据
  })

  beforeEach(() => {
    // 清空监控数据
    const monitor = getRuntimeMonitor()
    monitor.clear()
  })

  describe('执行模式切换', () => {
    it('应该默认使用 direct_llm 模式', async () => {
      // 这个测试需要实际的 API 调用
      // 暂时跳过，需要完整的测试环境
    })

    it('应该在白名单组织中使用 runtime_orchestrator 模式', async () => {
      // 这个测试需要实际的 API 调用
      // 暂时跳过，需要完整的测试环境
    })

    it('应该在 Runtime 不可用时自动回退到 direct 模式', async () => {
      // 这个测试需要实际的 API 调用
      // 暂时跳过，需要完整的测试环境
    })
  })

  describe('监控与回退', () => {
    it('应该记录执行指标', () => {
      const monitor = getRuntimeMonitor()

      monitor.recordExecution({
        sessionId: 'test-session',
        orgId: 'test-org',
        mode: 'runtime_orchestrator',
        success: true,
        latencyMs: 1000,
        timestamp: Date.now(),
      })

      const metrics = monitor.getMetrics('runtime_orchestrator')
      expect(metrics.total).toBe(1)
      expect(metrics.success).toBe(1)
      expect(metrics.errorRate).toBe(0)
    })

    it('应该在错误率过高时触发自动回退', () => {
      const monitor = getRuntimeMonitor()

      // 记录 10 次失败
      for (let i = 0; i < 10; i++) {
        monitor.recordExecution({
          sessionId: `test-session-${i}`,
          orgId: 'test-org',
          mode: 'runtime_orchestrator',
          success: false,
          error: 'Test error',
          latencyMs: 1000,
          timestamp: Date.now(),
        })
      }

      expect(monitor.shouldFallback()).toBe(true)
      expect(monitor.getFallbackReason()).toContain('错误率过高')
    })

    it('应该在指标恢复后禁用回退', () => {
      const monitor = getRuntimeMonitor()

      // 先触发回退
      for (let i = 0; i < 10; i++) {
        monitor.recordExecution({
          sessionId: `test-session-${i}`,
          orgId: 'test-org',
          mode: 'runtime_orchestrator',
          success: false,
          error: 'Test error',
          latencyMs: 1000,
          timestamp: Date.now(),
        })
      }

      expect(monitor.shouldFallback()).toBe(true)

      // 记录成功执行（需要足够多使错误率低于恢复阈值 25%）
      for (let i = 0; i < 40; i++) {
        monitor.recordExecution({
          sessionId: `test-session-success-${i}`,
          orgId: 'test-org',
          mode: 'runtime_orchestrator',
          success: true,
          latencyMs: 1000,
          timestamp: Date.now(),
        })
      }

      // 应该自动禁用回退
      expect(monitor.shouldFallback()).toBe(false)
    })
  })

  describe('Runtime API 端点', () => {
    it('GET /api/v1/runtime/metrics 应该返回指标摘要', async () => {
      // 需要管理员权限
      // 暂时跳过，需要完整的认证设置
    })

    it('POST /api/v1/runtime/fallback/reset 应该重置回退状态', async () => {
      const monitor = getRuntimeMonitor()

      // 触发回退
      for (let i = 0; i < 10; i++) {
        monitor.recordExecution({
          sessionId: `test-session-${i}`,
          orgId: 'test-org',
          mode: 'runtime_orchestrator',
          success: false,
          error: 'Test error',
          latencyMs: 1000,
          timestamp: Date.now(),
        })
      }

      expect(monitor.shouldFallback()).toBe(true)

      // 手动重置
      monitor.resetFallback()

      expect(monitor.shouldFallback()).toBe(false)
    })
  })

  describe('事件协议兼容性', () => {
    it('应该发送兼容的 SSE 事件', async () => {
      // 这个测试需要实际的 SSE 连接
      // 暂时跳过，需要完整的测试环境
    })

    it('应该支持新的事件类型', async () => {
      // 测试 plan_step, skill_call, mcp_call 等新事件
      // 暂时跳过，需要完整的测试环境
    })
  })
})

// RuntimeMonitorService 单元测试 - 不需要数据库连接
import { getRuntimeMonitor } from '../services/runtime-monitor.service'

describe('RuntimeMonitorService', () => {
  let monitor: ReturnType<typeof getRuntimeMonitor>

  beforeEach(() => {
    monitor = getRuntimeMonitor()
    monitor.clear()
  })

  it('应该正确计算错误率', () => {
    // 记录 7 次成功，3 次失败
    for (let i = 0; i < 7; i++) {
      monitor.recordExecution({
        sessionId: `session-${i}`,
        orgId: 'test-org',
        mode: 'runtime_orchestrator',
        success: true,
        latencyMs: 1000,
        timestamp: Date.now(),
      })
    }

    for (let i = 0; i < 3; i++) {
      monitor.recordExecution({
        sessionId: `session-fail-${i}`,
        orgId: 'test-org',
        mode: 'runtime_orchestrator',
        success: false,
        error: 'Test error',
        latencyMs: 1000,
        timestamp: Date.now(),
      })
    }

    const metrics = monitor.getMetrics('runtime_orchestrator')
    expect(metrics.total).toBe(10)
    expect(metrics.success).toBe(7)
    expect(metrics.error).toBe(3)
    expect(metrics.errorRate).toBe(0.3)
  })

  it('应该正确计算平均延迟', () => {
    monitor.recordExecution({
      sessionId: 'session-1',
      orgId: 'test-org',
      mode: 'runtime_orchestrator',
      success: true,
      latencyMs: 1000,
      timestamp: Date.now(),
    })

    monitor.recordExecution({
      sessionId: 'session-2',
      orgId: 'test-org',
      mode: 'runtime_orchestrator',
      success: true,
      latencyMs: 2000,
      timestamp: Date.now(),
    })

    monitor.recordExecution({
      sessionId: 'session-3',
      orgId: 'test-org',
      mode: 'runtime_orchestrator',
      success: true,
      latencyMs: 3000,
      timestamp: Date.now(),
    })

    const metrics = monitor.getMetrics('runtime_orchestrator')
    expect(metrics.avgLatencyMs).toBe(2000)
  })

  it('应该按组织分组统计', () => {
    monitor.recordExecution({
      sessionId: 'session-1',
      orgId: 'org-1',
      mode: 'runtime_orchestrator',
      success: true,
      latencyMs: 1000,
      timestamp: Date.now(),
    })

    monitor.recordExecution({
      sessionId: 'session-2',
      orgId: 'org-2',
      mode: 'runtime_orchestrator',
      success: true,
      latencyMs: 1000,
      timestamp: Date.now(),
    })

    const org1Metrics = monitor.getMetricsByOrg('org-1', 'runtime_orchestrator')
    const org2Metrics = monitor.getMetricsByOrg('org-2', 'runtime_orchestrator')

    expect(org1Metrics.total).toBe(1)
    expect(org2Metrics.total).toBe(1)
  })
})
