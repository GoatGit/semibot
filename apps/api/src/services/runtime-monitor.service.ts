/**
 * Runtime 监控服务 - 跟踪执行指标并触发自动回退
 */

import {
  CHAT_RUNTIME_ERROR_RATE_THRESHOLD,
  CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS,
} from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型���义
// ═══════════════════════════════════════════════════════════════

export interface ExecutionMetrics {
  total: number
  success: number
  error: number
  timeout: number
  avgLatencyMs: number
  errorRate: number
  timeoutRate: number
}

export interface ExecutionRecord {
  sessionId: string
  orgId: string
  mode: 'direct_llm' | 'runtime_orchestrator'
  success: boolean
  error?: string
  latencyMs: number
  timestamp: number
}

// ═══════════════════════════════════════════════════════════════
// Runtime 监控服务
// ═══════════════════════════════════════════════════════════════

class RuntimeMonitorService {
  private records: ExecutionRecord[] = []
  private maxRecords = 1000 // 保留最近 1000 条记录
  private windowMs = 300000 // 5 分钟滑动窗口
  private fallbackEnabled = false
  private fallbackReason = ''

  /**
   * 记录执行结果
   */
  recordExecution(record: ExecutionRecord): void {
    this.records.push(record)

    // 限制记录数量
    if (this.records.length > this.maxRecords) {
      this.records.shift()
    }

    // 检查是否需要触发回退
    this.checkFallbackConditions()
  }

  /**
   * 获取指定时间窗口内的指标
   */
  getMetrics(mode: 'direct_llm' | 'runtime_orchestrator', windowMs?: number): ExecutionMetrics {
    const window = windowMs ?? this.windowMs
    const now = Date.now()
    const cutoff = now - window

    // 过滤时间窗口内的记录
    const windowRecords = this.records.filter(
      (r) => r.mode === mode && r.timestamp >= cutoff
    )

    if (windowRecords.length === 0) {
      return {
        total: 0,
        success: 0,
        error: 0,
        timeout: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        timeoutRate: 0,
      }
    }

    const total = windowRecords.length
    const success = windowRecords.filter((r) => r.success).length
    const error = windowRecords.filter((r) => !r.success).length
    const timeout = windowRecords.filter(
      (r) => r.latencyMs >= CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS
    ).length

    const totalLatency = windowRecords.reduce((sum, r) => sum + r.latencyMs, 0)
    const avgLatencyMs = totalLatency / total

    return {
      total,
      success,
      error,
      timeout,
      avgLatencyMs,
      errorRate: error / total,
      timeoutRate: timeout / total,
    }
  }

  /**
   * 检查是否需要触发自动回退
   */
  private checkFallbackConditions(): void {
    const metrics = this.getMetrics('runtime_orchestrator')

    // 需要至少 10 个样本才能触发回退
    if (metrics.total < 10) {
      return
    }

    // 检查错误率
    if (metrics.errorRate > CHAT_RUNTIME_ERROR_RATE_THRESHOLD) {
      this.enableFallback(
        `错误率过高: ${(metrics.errorRate * 100).toFixed(2)}% (阈值: ${(CHAT_RUNTIME_ERROR_RATE_THRESHOLD * 100).toFixed(2)}%)`
      )
      return
    }

    // 检查超时率
    if (metrics.timeoutRate > 0.3) {
      // 30% 超时率
      this.enableFallback(
        `超时率过高: ${(metrics.timeoutRate * 100).toFixed(2)}% (阈值: 30%)`
      )
      return
    }

    // 检查平均延迟
    if (metrics.avgLatencyMs > CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS * 0.8) {
      this.enableFallback(
        `平均延迟过高: ${metrics.avgLatencyMs.toFixed(0)}ms (阈值: ${(CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS * 0.8).toFixed(0)}ms)`
      )
      return
    }

    // 如果指标恢复正常，禁用回退
    if (this.fallbackEnabled && metrics.errorRate < CHAT_RUNTIME_ERROR_RATE_THRESHOLD * 0.5) {
      this.disableFallback()
    }
  }

  /**
   * 启用自动回退
   */
  private enableFallback(reason: string): void {
    if (!this.fallbackEnabled) {
      this.fallbackEnabled = true
      this.fallbackReason = reason
      console.warn(`[RuntimeMonitor] 触发自动回退 - 原因: ${reason}`)
    }
  }

  /**
   * 禁用自动回退
   */
  private disableFallback(): void {
    if (this.fallbackEnabled) {
      this.fallbackEnabled = false
      this.fallbackReason = ''
      console.info('[RuntimeMonitor] 指标恢复正常，禁用自动回退')
    }
  }

  /**
   * 检查是否应该回退到 direct 模式
   */
  shouldFallback(): boolean {
    return this.fallbackEnabled
  }

  /**
   * 获取回退原因
   */
  getFallbackReason(): string {
    return this.fallbackReason
  }

  /**
   * 手动重置回退状态
   */
  resetFallback(): void {
    this.fallbackEnabled = false
    this.fallbackReason = ''
    console.info('[RuntimeMonitor] 手动重置回退状态')
  }

  /**
   * 获取所有模式的指标摘要
   */
  getSummary(): {
    direct: ExecutionMetrics
    runtime: ExecutionMetrics
    fallbackEnabled: boolean
    fallbackReason: string
  } {
    return {
      direct: this.getMetrics('direct_llm'),
      runtime: this.getMetrics('runtime_orchestrator'),
      fallbackEnabled: this.fallbackEnabled,
      fallbackReason: this.fallbackReason,
    }
  }

  /**
   * 清空所有记录
   */
  clear(): void {
    this.records = []
    this.fallbackEnabled = false
    this.fallbackReason = ''
  }

  /**
   * 获取按组织分组的指标
   */
  getMetricsByOrg(orgId: string, mode: 'direct_llm' | 'runtime_orchestrator'): ExecutionMetrics {
    const now = Date.now()
    const cutoff = now - this.windowMs

    const windowRecords = this.records.filter(
      (r) => r.mode === mode && r.orgId === orgId && r.timestamp >= cutoff
    )

    if (windowRecords.length === 0) {
      return {
        total: 0,
        success: 0,
        error: 0,
        timeout: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        timeoutRate: 0,
      }
    }

    const total = windowRecords.length
    const success = windowRecords.filter((r) => r.success).length
    const error = windowRecords.filter((r) => !r.success).length
    const timeout = windowRecords.filter(
      (r) => r.latencyMs >= CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS
    ).length

    const totalLatency = windowRecords.reduce((sum, r) => sum + r.latencyMs, 0)
    const avgLatencyMs = totalLatency / total

    return {
      total,
      success,
      error,
      timeout,
      avgLatencyMs,
      errorRate: error / total,
      timeoutRate: timeout / total,
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 单例实例
// ═══════════════════════════════════════════════════════════════

let monitorInstance: RuntimeMonitorService | null = null

/**
 * 获取监控服务单例
 */
export function getRuntimeMonitor(): RuntimeMonitorService {
  if (!monitorInstance) {
    monitorInstance = new RuntimeMonitorService()
  }
  return monitorInstance
}
