/**
 * Evolution Cleanup Job
 *
 * 定时执行进化质量退化检查
 */

import * as governanceService from '../services/evolution-governance.service'
import { createLogger } from '../lib/logger'

const logger = createLogger('evolution-cleanup-job')

/**
 * 执行进化质量退化检查
 * 可由外部调度器（cron、node-schedule 等）调用
 */
export async function runEvolutionCleanup(orgIds: string[]): Promise<void> {
  logger.info('[Job] 开始执行进化质量退化检查', { orgCount: orgIds.length })
  const startTime = Date.now()

  let totalDeprecated = 0
  let totalStale = 0

  for (const orgId of orgIds) {
    try {
      const result = await governanceService.checkQualityDegradation(orgId)
      totalDeprecated += result.deprecatedCount
      totalStale += result.staleCount
    } catch (error) {
      logger.error('[Job] 组织退化检查失败', {
        orgId,
        error: (error as Error).message,
      })
    }
  }

  const duration = Date.now() - startTime
  logger.info('[Job] 进化质量退化检查完成', {
    durationMs: duration,
    totalDeprecated,
    totalStale,
  })
}
