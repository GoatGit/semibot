import * as sessionService from './session.service'
import { createLogger } from '../lib/logger'

const WATCHDOG_OWNER = `watchdog:${process.pid}`
const DEFAULT_SWEEP_INTERVAL_MS = 15_000

const logger = createLogger('runtime-attempt-watchdog')

let sweepTimer: NodeJS.Timeout | null = null
let sweepPromise: Promise<SweepStalledAttemptsResult> | null = null

export interface SweepStalledAttemptsOptions {
  limit?: number
  leaseDurationMs?: number
}

export interface SweepStalledAttemptsResult {
  scanned: number
  failed: string[]
}

export async function sweepStalledRuntimeAttempts(
  options?: SweepStalledAttemptsOptions
): Promise<SweepStalledAttemptsResult> {
  if (!options && sweepPromise) {
    return sweepPromise
  }
  if (!options) {
    sweepPromise = runSweep(undefined)
    try {
      return await sweepPromise
    } finally {
      sweepPromise = null
    }
  }
  return runSweep(options)
}

async function runSweep(
  options?: SweepStalledAttemptsOptions
): Promise<SweepStalledAttemptsResult> {
  const limit = Math.max(1, options?.limit ?? 100)
  const leaseDurationMs = Math.max(1000, options?.leaseDurationMs ?? 30_000)
  const attempts = await sessionService.listStalledRuntimeAttempts(limit)
  const failed: string[] = []

  for (const attempt of attempts) {
    if (attempt.status !== 'running') continue

    const claimed = await sessionService.claimRuntimeAttemptLease({
      attemptId: attempt.id,
      leasedBy: WATCHDOG_OWNER,
      leaseDurationMs,
      expectedStatuses: ['running'],
    })
    if (!claimed) continue

    await sessionService.commitAttemptTerminal({
      attemptId: claimed.id,
      sessionId: claimed.sessionId,
      userMessageId: claimed.userMessageId,
      status: 'failed',
      terminalReason: 'stalled_execution',
      checkpointPayload: {
        status: 'failed',
        error: 'attempt stalled after lease expiry',
      },
    })
    failed.push(claimed.id)
  }

  return {
    scanned: attempts.length,
    failed,
  }
}

function resolveSweepIntervalMs(): number {
  const raw = Number(process.env.SEMIBOT_RUNTIME_ATTEMPT_WATCHDOG_SWEEP_MS || DEFAULT_SWEEP_INTERVAL_MS)
  if (!Number.isFinite(raw) || raw < 1_000) return DEFAULT_SWEEP_INTERVAL_MS
  return raw
}

export function startRuntimeAttemptWatchdogSweep(): void {
  if (String(process.env.SEMIBOT_RUNTIME_ATTEMPT_WATCHDOG_DISABLED || '').trim() === 'true') {
    logger.info('runtime attempt watchdog disabled by env')
    return
  }
  if (sweepTimer) return

  const intervalMs = resolveSweepIntervalMs()
  sweepTimer = setInterval(() => {
    void sweepStalledRuntimeAttempts().then((result) => {
      if (result.failed.length > 0) {
        logger.warn('runtime attempt watchdog failed stalled attempts', {
          scanned: result.scanned,
          failed: result.failed,
        })
      }
    }).catch((error) => {
      logger.warn('runtime attempt watchdog sweep failed', { error })
    })
  }, intervalMs)
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref()
  }
  logger.info('runtime attempt watchdog started', { intervalMs })
}

export function stopRuntimeAttemptWatchdogSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
  logger.info('runtime attempt watchdog stopped')
}
