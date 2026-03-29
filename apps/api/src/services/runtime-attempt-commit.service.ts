import { createError } from '../middleware/errorHandler'
import { SESSION_NOT_FOUND } from '../constants/errorCodes'
import { getLocalDb } from '../lib/db-local'
import { createLogger } from '../lib/logger'
import * as runtimeAttemptRepository from '../repositories/runtime-attempt.repository'
import type {
  CommitAttemptStateInput,
  CommitAttemptTerminalInput,
  RuntimeAttempt,
  RuntimeAttemptCheckpoint,
  RuntimeAttemptStatus,
} from './session.service'

const logger = createLogger('runtime-attempt-commit')

function mapAttemptStatusToEventType(
  status: Extract<RuntimeAttemptStatus, 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>
): string {
  switch (status) {
    case 'awaiting_approval':
      return 'task.awaiting_approval'
    case 'completed':
      return 'task.completed'
    case 'failed':
      return 'task.failed'
    case 'cancelled':
      return 'task.cancelled'
    case 'running':
      return 'task.running'
    default:
      return 'task.queued'
  }
}

function resolveCommitRevision(currentRevision: number, requestedRevision?: number): number {
  const nextRevision = currentRevision + 1
  if (typeof requestedRevision !== 'number' || !Number.isFinite(requestedRevision)) {
    return nextRevision
  }
  const normalized = Math.max(1, Math.trunc(requestedRevision))
  return normalized >= nextRevision ? normalized : nextRevision
}

function mapAttemptStatusToSessionStatus(
  status: Extract<RuntimeAttemptStatus, 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>
): 'active' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'active'
}

function rowToRuntimeAttempt(row: runtimeAttemptRepository.RuntimeAttemptRow): RuntimeAttempt {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    agentId: row.agent_id,
    attemptSeq: row.attempt_seq,
    executionMode: row.execution_mode,
    status: row.status,
    approvalSetRevision: row.approval_set_revision,
    approvalBlockCount: row.approval_block_count,
    resumeCount: row.resume_count,
    latestRevision: row.latest_revision,
    checkpointId: row.checkpoint_id ?? undefined,
    artifactMessageId: row.artifact_message_id ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    leasedBy: row.leased_by ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    metadata: row.metadata ?? undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  }
}

function rowToRuntimeAttemptCheckpoint(
  row: runtimeAttemptRepository.RuntimeAttemptCheckpointRow
): RuntimeAttemptCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    status: row.status,
    revision: row.revision,
    payload: row.payload ?? undefined,
    createdAt: row.created_at,
  }
}

function insertCommitOutbox(params: {
  db: ReturnType<typeof getLocalDb>
  now: string
  attemptId: string
  sessionId: string
  userMessageId: string
  checkpointId: string
  revision: number
  status: RuntimeAttemptStatus
  checkpointPayload?: Record<string, unknown>
  terminalReason?: string | null
  artifactMessageId?: string
}): void {
  const eventType = mapAttemptStatusToEventType(params.status)
  const eventPayload = {
    attempt_id: params.attemptId,
    session_id: params.sessionId,
    user_message_id: params.userMessageId,
    checkpoint_id: params.checkpointId,
    revision: params.revision,
    status: params.status,
    terminal_reason: params.terminalReason ?? null,
    artifact_message_id: params.artifactMessageId ?? null,
    checkpoint_payload: params.checkpointPayload ?? {},
  }
  params.db.prepare(`
    INSERT INTO event_outbox (
      id, attempt_id, session_id, user_message_id, revision, event_type, idempotency_key, payload_json, status, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
  `).run(
    crypto.randomUUID(),
    params.attemptId,
    params.sessionId,
    params.userMessageId,
    params.revision,
    eventType,
    `${params.attemptId}:${params.revision}:${eventType}`,
    JSON.stringify(eventPayload),
    params.now,
  )
  params.db.prepare(`
    INSERT INTO checkpoint_outbox (
      id, attempt_id, session_id, user_message_id, checkpoint_id, revision, projection_target, payload_json, status, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'local_file', ?, 'pending', ?, NULL)
  `).run(
    crypto.randomUUID(),
    params.attemptId,
    params.sessionId,
    params.userMessageId,
    params.checkpointId,
    params.revision,
    JSON.stringify({
      checkpoint_id: params.checkpointId,
      attempt_id: params.attemptId,
      session_id: params.sessionId,
      user_message_id: params.userMessageId,
      revision: params.revision,
      status: params.status,
      payload: params.checkpointPayload ?? {},
    }),
    params.now,
  )
}

export async function appendRuntimeAttemptCheckpointCommitted(
  attemptId: string,
  input: {
    sessionId: string
    userMessageId: string
    status: RuntimeAttemptStatus
    payload?: Record<string, unknown>
  }
): Promise<RuntimeAttemptCheckpoint> {
  const row = await runtimeAttemptRepository.appendCheckpoint({
    attemptId,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    status: input.status,
    payload: input.payload,
  })
  await runtimeAttemptRepository.update(attemptId, { checkpointId: row.checkpoint_id })
  return rowToRuntimeAttemptCheckpoint(row)
}

export async function commitAttemptState(
  input: CommitAttemptStateInput
): Promise<RuntimeAttempt> {
  const db = getLocalDb()
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(input.attemptId) as Record<string, unknown> | undefined
    if (!row) throw createError(SESSION_NOT_FOUND)

    const revisionRow = db
      .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM runtime_attempt_checkpoints WHERE attempt_id = ?')
      .get(input.attemptId) as { revision?: number }
    const revision = resolveCommitRevision(Number(revisionRow?.revision ?? 0), input.revision)
    const checkpointId = crypto.randomUUID()

    db.prepare(`
      INSERT INTO runtime_attempt_checkpoints (
        checkpoint_id, attempt_id, session_id, user_message_id, status, revision, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      input.attemptId,
      input.sessionId,
      input.userMessageId,
      input.status,
      revision,
      JSON.stringify(input.checkpointPayload ?? {}),
      now,
    )

    db.prepare(`
      UPDATE runtime_attempts
      SET
        status = ?,
        approval_block_count = COALESCE(?, approval_block_count),
        approval_set_revision = COALESCE(?, approval_set_revision),
        metadata_json = COALESCE(?, metadata_json),
        latest_revision = ?,
        checkpoint_id = ?,
        leased_by = CASE WHEN ? = 'running' THEN leased_by ELSE NULL END,
        lease_expires_at = CASE WHEN ? = 'running' THEN lease_expires_at ELSE NULL END,
        heartbeat_at = CASE WHEN ? = 'running' THEN heartbeat_at ELSE NULL END,
        ended_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.approvalBlockCount ?? null,
      input.approvalSetRevision ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata ?? {}) : null,
      revision,
      checkpointId,
      input.status,
      input.status,
      input.status,
      now,
      input.attemptId,
    )

    db.prepare('UPDATE sessions SET status = ?, current_attempt_id = ? WHERE id = ?').run(
      mapAttemptStatusToSessionStatus(input.status),
      input.attemptId,
      input.sessionId,
    )
    insertCommitOutbox({
      db,
      now,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      checkpointId,
      revision,
      status: input.status,
      checkpointPayload: input.checkpointPayload,
    })
  })

  tx()
  const committed = await runtimeAttemptRepository.findById(input.attemptId)
  if (!committed) throw createError(SESSION_NOT_FOUND)
  logger.info('attempt state committed', {
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    status: input.status,
  })
  return rowToRuntimeAttempt(committed)
}

export async function commitAttemptTerminal(
  input: CommitAttemptTerminalInput
): Promise<RuntimeAttempt> {
  const db = getLocalDb()
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(input.attemptId) as Record<string, unknown> | undefined
    if (!row) throw createError(SESSION_NOT_FOUND)

    const revisionRow = db
      .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM runtime_attempt_checkpoints WHERE attempt_id = ?')
      .get(input.attemptId) as { revision?: number }
    const revision = resolveCommitRevision(Number(revisionRow?.revision ?? 0), input.revision)
    const checkpointId = crypto.randomUUID()

    db.prepare(`
      INSERT INTO runtime_attempt_checkpoints (
        checkpoint_id, attempt_id, session_id, user_message_id, status, revision, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      input.attemptId,
      input.sessionId,
      input.userMessageId,
      input.status,
      revision,
      JSON.stringify(input.checkpointPayload ?? {}),
      now,
    )

    db.prepare(`
      UPDATE runtime_attempts
      SET
        status = ?,
        artifact_message_id = ?,
        terminal_reason = ?,
        metadata_json = COALESCE(?, metadata_json),
        latest_revision = ?,
        checkpoint_id = ?,
        leased_by = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        ended_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.artifactMessageId ?? null,
      input.terminalReason,
      input.metadata !== undefined ? JSON.stringify(input.metadata ?? {}) : null,
      revision,
      checkpointId,
      now,
      now,
      input.attemptId,
    )

    db.prepare('UPDATE sessions SET status = ?, current_attempt_id = ? WHERE id = ?').run(
      mapAttemptStatusToSessionStatus(input.status),
      input.attemptId,
      input.sessionId,
    )
    insertCommitOutbox({
      db,
      now,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      checkpointId,
      revision,
      status: input.status,
      checkpointPayload: input.checkpointPayload,
      terminalReason: input.terminalReason,
      artifactMessageId: input.artifactMessageId,
    })
  })

  tx()
  const committed = await runtimeAttemptRepository.findById(input.attemptId)
  if (!committed) throw createError(SESSION_NOT_FOUND)
  logger.info('attempt terminal committed', {
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    status: input.status,
    terminalReason: input.terminalReason,
  })
  return rowToRuntimeAttempt(committed)
}
