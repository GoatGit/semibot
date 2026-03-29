import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createLogger } from '../lib/logger'
import * as runtimeAttemptRepository from '../repositories/runtime-attempt.repository'

const logger = createLogger('runtime-attempt-outbox')

const DEFAULT_SWEEP_INTERVAL_MS = 5_000
const DEFAULT_SWEEP_LIMIT = 100
const OUTBOX_ROOT = path.join(os.homedir(), '.semibot', 'attempt-outbox')

let sweepTimer: NodeJS.Timeout | null = null
let sweepPromise: Promise<SweepRuntimeAttemptOutboxResult> | null = null

export interface SweepRuntimeAttemptOutboxOptions {
  limit?: number
}

export interface SweepRuntimeAttemptOutboxResult {
  eventDelivered: number
  checkpointDelivered: number
}

function resolveSweepIntervalMs(): number {
  const raw = Number(process.env.SEMIBOT_RUNTIME_ATTEMPT_OUTBOX_SWEEP_MS || DEFAULT_SWEEP_INTERVAL_MS)
  if (!Number.isFinite(raw) || raw < 1_000) return DEFAULT_SWEEP_INTERVAL_MS
  return raw
}

function resolveLimit(limit?: number): number {
  const raw = Number(limit ?? DEFAULT_SWEEP_LIMIT)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_SWEEP_LIMIT
  return Math.trunc(raw)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeProjectionFile(relativeDir: string, filename: string, payload: Record<string, unknown> | null): Promise<void> {
  const dir = path.join(OUTBOX_ROOT, relativeDir)
  await ensureDir(dir)
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify(payload ?? {}, null, 2),
    'utf-8',
  )
}

async function runSweep(options?: SweepRuntimeAttemptOutboxOptions): Promise<SweepRuntimeAttemptOutboxResult> {
  const limit = resolveLimit(options?.limit)
  let eventDelivered = 0
  let checkpointDelivered = 0

  const pendingEvents = await runtimeAttemptRepository.listPendingEventOutbox(limit)
  for (const item of pendingEvents) {
    await writeProjectionFile(
      path.join('events', item.attempt_id),
      `${item.revision}-${item.event_type}.json`,
      item.payload,
    )
    await runtimeAttemptRepository.markEventOutboxDelivered(item.id)
    eventDelivered += 1
  }

  const pendingCheckpoints = await runtimeAttemptRepository.listPendingCheckpointOutbox(limit)
  for (const item of pendingCheckpoints) {
    await writeProjectionFile(
      path.join('checkpoints', item.attempt_id),
      `${item.revision}-${item.checkpoint_id}.json`,
      item.payload,
    )
    await runtimeAttemptRepository.markCheckpointOutboxDelivered(item.id)
    checkpointDelivered += 1
  }

  return { eventDelivered, checkpointDelivered }
}

export async function sweepRuntimeAttemptOutbox(
  options?: SweepRuntimeAttemptOutboxOptions
): Promise<SweepRuntimeAttemptOutboxResult> {
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

export function startRuntimeAttemptOutboxSweep(): void {
  if (String(process.env.SEMIBOT_RUNTIME_ATTEMPT_OUTBOX_DISABLED || '').trim() === 'true') {
    logger.info('runtime attempt outbox sweep disabled by env')
    return
  }
  if (sweepTimer) return

  const intervalMs = resolveSweepIntervalMs()
  sweepTimer = setInterval(() => {
    void sweepRuntimeAttemptOutbox().then((result) => {
      if (result.eventDelivered > 0 || result.checkpointDelivered > 0) {
        logger.info('runtime attempt outbox swept', {
          eventDelivered: result.eventDelivered,
          checkpointDelivered: result.checkpointDelivered,
        })
      }
    }).catch((error) => {
      logger.warn('runtime attempt outbox sweep failed', { error })
    })
  }, intervalMs)
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref()
  }
  logger.info('runtime attempt outbox sweep started', { intervalMs })
}

export function stopRuntimeAttemptOutboxSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
  logger.info('runtime attempt outbox sweep stopped')
}
