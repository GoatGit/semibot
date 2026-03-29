import * as local from '../lib/session-local-store'

export type {
  RuntimeAttemptStatus,
  RuntimeExecutionMode,
  LocalRuntimeAttemptRow as RuntimeAttemptRow,
  LocalRuntimeAttemptCheckpointRow as RuntimeAttemptCheckpointRow,
  LocalEventOutboxRow as EventOutboxRow,
  LocalCheckpointOutboxRow as CheckpointOutboxRow,
} from '../lib/session-local-store'

export interface CreateRuntimeAttemptData {
  sessionId: string
  userMessageId: string
  agentId: string
  executionMode?: local.RuntimeExecutionMode
  status?: local.RuntimeAttemptStatus
  metadata?: Record<string, unknown>
}

export interface UpdateRuntimeAttemptData {
  executionMode?: local.RuntimeExecutionMode
  status?: local.RuntimeAttemptStatus
  approvalSetRevision?: number
  approvalBlockCount?: number
  resumeCount?: number
  checkpointId?: string | null
  artifactMessageId?: string | null
  terminalReason?: string | null
  leasedBy?: string | null
  leaseExpiresAt?: string | null
  heartbeatAt?: string | null
  metadata?: Record<string, unknown> | null
  endedAt?: string | null
}

export interface AppendRuntimeAttemptCheckpointData {
  attemptId: string
  sessionId: string
  userMessageId: string
  status: local.RuntimeAttemptStatus
  payload?: Record<string, unknown>
}

export interface ClaimRuntimeAttemptLeaseData {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
  expectedStatuses?: local.RuntimeAttemptStatus[]
}

export interface HeartbeatRuntimeAttemptData {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
}

export async function create(data: CreateRuntimeAttemptData): Promise<local.LocalRuntimeAttemptRow> {
  return local.localCreateRuntimeAttempt(data)
}

export async function findById(id: string): Promise<local.LocalRuntimeAttemptRow | null> {
  return local.localFindRuntimeAttemptById(id)
}

export async function findCurrentBySessionId(sessionId: string): Promise<local.LocalRuntimeAttemptRow | null> {
  return local.localFindCurrentRuntimeAttempt(sessionId)
}

export async function listBySessionId(sessionId: string, limit = 20): Promise<local.LocalRuntimeAttemptRow[]> {
  return local.localListRuntimeAttemptsBySessionId(sessionId, limit)
}

export async function update(id: string, data: UpdateRuntimeAttemptData): Promise<local.LocalRuntimeAttemptRow | null> {
  return local.localUpdateRuntimeAttempt(id, data)
}

export async function claimLease(
  data: ClaimRuntimeAttemptLeaseData
): Promise<local.LocalRuntimeAttemptRow | null> {
  return local.localClaimRuntimeAttemptLease(data)
}

export async function heartbeat(
  data: HeartbeatRuntimeAttemptData
): Promise<local.LocalRuntimeAttemptRow | null> {
  return local.localHeartbeatRuntimeAttempt(data)
}

export async function listStalled(limit = 100): Promise<local.LocalRuntimeAttemptRow[]> {
  return local.localListStalledRuntimeAttempts({ limit })
}

export async function appendCheckpoint(
  data: AppendRuntimeAttemptCheckpointData
): Promise<local.LocalRuntimeAttemptCheckpointRow> {
  return local.localAppendRuntimeAttemptCheckpoint(data)
}

export async function listEventOutboxByAttemptId(attemptId: string): Promise<local.LocalEventOutboxRow[]> {
  return local.localListEventOutboxByAttemptId(attemptId)
}

export async function listCheckpointOutboxByAttemptId(attemptId: string): Promise<local.LocalCheckpointOutboxRow[]> {
  return local.localListCheckpointOutboxByAttemptId(attemptId)
}

export async function listPendingEventOutbox(limit = 100): Promise<local.LocalEventOutboxRow[]> {
  return local.localListPendingEventOutbox(limit)
}

export async function listPendingCheckpointOutbox(limit = 100): Promise<local.LocalCheckpointOutboxRow[]> {
  return local.localListPendingCheckpointOutbox(limit)
}

export async function markEventOutboxDelivered(id: string): Promise<local.LocalEventOutboxRow | null> {
  return local.localMarkEventOutboxDelivered(id)
}

export async function markCheckpointOutboxDelivered(id: string): Promise<local.LocalCheckpointOutboxRow | null> {
  return local.localMarkCheckpointOutboxDelivered(id)
}
