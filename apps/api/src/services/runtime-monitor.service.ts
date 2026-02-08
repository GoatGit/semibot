/**
 * Runtime 监控服务 - 跟踪执行指标并触发自动回退
 */

import {
  CHAT_RUNTIME_ERROR_RATE_THRESHOLD,
  CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS,
  RUNTIME_MONITOR_MAX_RECORDS,
  RUNTIME_MONITOR_WINDOW_MS,
  RUNTIME_MONITOR_MIN_SAMPLES,
  RUNTIME_MONITOR_TIMEOUT_RATE_THRESHOLD,
  RUNTIME_MONITOR_ERROR_RATE_RECOVERY_MULTIPLIER,
  RUNTIME_MONITOR_LATENCY_THRESHOLD_MULTIPLIER,
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
  private maxRecords = RUNTIME_MONITOR_MAX_RECORDS
  private windowMs = RUNTIME_MONITOR_WINDOW_MS
  private fallbackEnabled = false
  private fallbackReason = ''

  /**
   * 记录执行结果
   */
  recordExecution(record: ExecutionRecord): void {
    this.records.push(record)

    // 限制记录数量
    if (this.records.length > this.maxRecords) {
      console.warn(
        `[RuntimeMonitor] 记录数已达上限，删除最旧记录 (当前: ${this.records.length}, 限制: ${this.maxRecords})`
      )
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
    if (metrics.total < RUNTIME_MONITOR_MIN_SAMPLES) {
      console.debug(
        `[RuntimeMonitor] 样本数不足，跳过回退检查 (当前: ${metrics.total}, 最小: ${RUNTIME_MONITOR_MIN_SAMPLES})`
      )
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
    if (metrics.timeoutRate > RUNTIME_MONITOR_TIMEOUT_RATE_THRESHOLD) {
      this.enableFallback(
        `超时率过高: ${(metrics.timeoutRate * 100).toFixed(2)}% (阈值: ${(RUNTIME_MONITOR_TIMEOUT_RATE_THRESHOLD * 100).toFixed(2)}%)`
      )
      return
    }

    // 检查平均延迟
    const latencyThreshold = CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS * RUNTIME_MONITOR_LATENCY_THRESHOLD_MULTIPLIER
    if (metrics.avgLatencyMs > latencyThreshold) {
      this.enableFallback(
        `平均延迟过高: ${metrics.avgLatencyMs.toFixed(0)}ms (阈值: ${latencyThreshold.toFixed(0)}ms)`
      )
      return
    }

    // 如果指标恢复正常，禁用回退
    const recoveryThreshold = CHAT_RUNTIME_ERROR_RATE_THRESHOLD * RUNTIME_MONITOR_ERROR_RATE_RECOVERY_MULTIPLIER
    if (this.fallbackEnabled && metrics.errorRate < recoveryThreshold) {
      console.info(
        `[RuntimeMonitor] 指标恢复正常，准备禁用自动回退 (错误率: ${(metrics.errorRate * 100).toFixed(2)}% < 恢复阈值: ${(recoveryThreshold * 100).toFixed(2)}%)`
      )
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
