import { createLogger } from '../lib/logger'
import * as productionRepo from '../repositories/production.repository'
import * as productionService from './production.service'

const logger = createLogger('production-lifecycle')

const DEFAULT_SWEEP_INTERVAL_MS = 15_000

let sweepTimer: NodeJS.Timeout | null = null
let sweepPromise: Promise<{ recoveredAttempts: number; resumedProductions: string[] }> | null = null

function resolveSweepIntervalMs(): number {
  const raw = Number(process.env.SEMIBOT_APS_LIFECYCLE_SWEEP_MS || DEFAULT_SWEEP_INTERVAL_MS)
  if (!Number.isFinite(raw) || raw < 1_000) return DEFAULT_SWEEP_INTERVAL_MS
  return raw
}

export async function sweepApsLifecycle(): Promise<{
  recoveredAttempts: number
  resumedProductions: string[]
}> {
  if (sweepPromise) {
    return sweepPromise
  }

  sweepPromise = (async () => {
    const recovered = await productionRepo.sweepExpiredAttempts()
    const productionIds = [...new Set(recovered.map((item) => item.productionId))]
    const resumedProductions: string[] = []

    for (const productionId of productionIds) {
      try {
        const production = await productionService.getProduction(productionId)
        if (production.status !== 'active' || production.isPaused) continue
        const engine = await import('./production-engine.service')
        const started = await engine.runProductionGuarded(productionId)
        if (started) {
          resumedProductions.push(productionId)
        }
      } catch (error) {
        logger.warn('APS lifecycle could not resume recovered production', { productionId, error })
      }
    }

    if (recovered.length > 0) {
      logger.info('APS lifecycle sweep recovered stale attempts', {
        recoveredAttempts: recovered.length,
        resumedProductions: resumedProductions.length,
      })
    }

    return {
      recoveredAttempts: recovered.length,
      resumedProductions,
    }
  })()

  try {
    return await sweepPromise
  } finally {
    sweepPromise = null
  }
}

export function startApsLifecycleSweep(): void {
  if (String(process.env.SEMIBOT_APS_LIFECYCLE_SWEEP_DISABLED || '').trim() === 'true') {
    logger.info('APS lifecycle sweep disabled by env')
    return
  }
  if (sweepTimer) return

  const intervalMs = resolveSweepIntervalMs()
  sweepTimer = setInterval(() => {
    void sweepApsLifecycle().catch((error) => {
      logger.warn('APS lifecycle sweep failed', { error })
    })
  }, intervalMs)
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref()
  }
  logger.info('APS lifecycle sweep started', { intervalMs })
}

export function stopApsLifecycleSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
  logger.info('APS lifecycle sweep stopped')
}
