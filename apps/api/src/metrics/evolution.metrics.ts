/**
 * Evolution Prometheus Metrics
 *
 * 进化系统可观测性指标定义
 * 注意：如果项目未安装 prom-client，这些指标定义作为接口预留
 */

// ═══════════════════════════════════════════════════════════════
// 指标名称常量（供外部引用）
// ═══════════════════════════════════════════════════════════════

export const EVOLUTION_METRICS = {
  TRIGGERED_TOTAL: 'evolution_triggered_total',
  SUCCESS_TOTAL: 'evolution_success_total',
  SKILL_QUALITY: 'evolution_skill_quality',
  SKILL_REUSE_TOTAL: 'evolved_skill_reuse_total',
  SKILL_REUSE_SUCCESS_RATE: 'evolved_skill_reuse_success_rate',
  DURATION_SECONDS: 'evolution_duration_seconds',
  TOKENS_TOTAL: 'evolution_tokens_total',
} as const

// ═══════════════════════════════════════════════════════════════
// 指标记录器（轻量实现，不依赖 prom-client）
// ═══════════════════════════════════════════════════════════════

import { createLogger } from '../lib/logger'

const logger = createLogger('evolution-metrics')

export class EvolutionMetricsRecorder {
  static recordTriggered(orgId: string, agentId: string): void {
    logger.info('[Metrics] evolution_triggered', { orgId, agentId })
  }

  static recordSuccess(orgId: string, agentId: string): void {
    logger.info('[Metrics] evolution_success', { orgId, agentId })
  }

  static recordQuality(orgId: string, qualityScore: number): void {
    logger.info('[Metrics] evolution_skill_quality', { orgId, qualityScore })
  }

  static recordReuse(orgId: string, skillId: string): void {
    logger.info('[Metrics] evolved_skill_reuse', { orgId, skillId })
  }

  static recordDuration(orgId: string, stage: string, durationSeconds: number): void {
    logger.info('[Metrics] evolution_duration', { orgId, stage, durationSeconds })
  }

  static recordTokens(orgId: string, stage: string, tokens: number): void {
    logger.info('[Metrics] evolution_tokens', { orgId, stage, tokens })
  }
}
