/**
 * APS Repository
 */

import * as store from '../lib/production-local-store'
import type {
  ArtifactVersion,
  CreateProductionInput,
  Escalation,
  HumanDecision,
  Production,
  ProductionEvent,
  ProductionStage,
  ProductionStatus,
  ProductionTask,
  ReplanProductionInput,
  ReviewDecision,
  ReviewJob,
  TaskAttempt,
} from '@semibot/shared-types'

export type { LocalProductionRow as ProductionRow, LocalProductionPlanRow as ProductionPlanRow } from '../lib/production-local-store'

export async function create(data: CreateProductionInput & { plannerMetadata?: Record<string, unknown> }, createdBy: string) {
  return store.localCreateProduction(data, createdBy)
}

export async function replan(productionId: string, data: ReplanProductionInput & { plannerMetadata?: Record<string, unknown> }) {
  return store.localReplanProduction(productionId, data)
}

export async function findById(id: string) {
  return store.localFindProductionById(id)
}

export async function list(params: { page?: number; limit?: number; status?: ProductionStatus; search?: string }) {
  return store.localListProductions(params)
}

export async function updateState(
  productionId: string,
  fields: Partial<Pick<Production, 'status' | 'currentStageId' | 'currentPlanId' | 'completedAt'>> & { isPaused?: boolean }
) {
  return store.localUpdateProductionState(productionId, fields)
}

export async function findPlanById(planId: string) {
  return store.localFindProductionPlanById(planId)
}

export async function listPlans(productionId: string) {
  return store.localListProductionPlans(productionId)
}

export async function listStages(productionId: string): Promise<ProductionStage[]> {
  return store.localListProductionStages(productionId)
}

export async function findStageById(stageId: string): Promise<ProductionStage | null> {
  return store.localFindProductionStageById(stageId)
}

export async function updateStageStatus(stageId: string, status: ProductionStage['status']): Promise<ProductionStage | null> {
  return store.localUpdateStageStatus(stageId, status)
}

export async function listTasks(productionId: string): Promise<ProductionTask[]> {
  return store.localListProductionTasks(productionId)
}

export async function findTaskById(taskId: string): Promise<ProductionTask | null> {
  return store.localFindProductionTaskById(taskId)
}

export async function listAttempts(productionId: string): Promise<TaskAttempt[]> {
  return store.localListProductionAttempts(productionId)
}

export async function findAttemptById(taskAttemptId: string): Promise<TaskAttempt | null> {
  return store.localFindAttemptById(taskAttemptId)
}

export async function listArtifacts(productionId: string): Promise<ArtifactVersion[]> {
  return store.localListProductionArtifacts(productionId)
}

export async function findArtifactById(artifactVersionId: string): Promise<ArtifactVersion | null> {
  return store.localFindArtifactById(artifactVersionId)
}

export async function readArtifactContent(artifactVersionId: string): Promise<{ artifact: ArtifactVersion; content: string } | null> {
  return store.localReadArtifactContent(artifactVersionId)
}

export async function listReviewJobs(productionId: string): Promise<ReviewJob[]> {
  return store.localListProductionReviewJobs(productionId)
}

export async function listOpenReviewJobs(limit?: number): Promise<ReviewJob[]> {
  return store.localListOpenReviewJobs(limit)
}

export async function findReviewJobById(reviewJobId: string): Promise<ReviewJob | null> {
  return store.localFindReviewJobById(reviewJobId)
}

export async function listReviewDecisions(productionId: string): Promise<ReviewDecision[]> {
  return store.localListProductionReviewDecisions(productionId)
}

export async function recordReviewDecision(input: {
  reviewJobId: string
  decision: ReviewDecision['decision']
  score?: number
  findings?: string[]
  revisionRequest?: {
    mustFix?: string[]
    shouldFix?: string[]
  }
}) {
  return store.localRecordReviewDecision(input)
}

export async function listEvents(productionId: string, limit?: number): Promise<ProductionEvent[]> {
  return store.localListProductionEvents(productionId, limit)
}

export async function listEscalations(productionId: string): Promise<Escalation[]> {
  return store.localListEscalations(productionId)
}

export async function listOpenEscalations(limit?: number): Promise<Escalation[]> {
  return store.localListOpenEscalations(limit)
}

export async function findEscalationById(escalationId: string): Promise<Escalation | null> {
  return store.localFindEscalationById(escalationId)
}

export async function listHumanDecisions(productionId: string): Promise<HumanDecision[]> {
  return store.localListHumanDecisions(productionId)
}

export async function appendEvent(input: {
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  eventType: string
  eventVersion?: string
  payload?: Record<string, unknown>
}) {
  return store.localAppendProductionEvent(input)
}

export async function claimNextRunnableTask(productionId: string, workerId: string) {
  return store.localClaimNextRunnableTask(productionId, workerId)
}

export async function updateAttemptHeartbeat(taskAttemptId: string) {
  store.localUpdateAttemptHeartbeat(taskAttemptId)
}

export async function startAttempt(taskAttemptId: string, inputEnvelope: Record<string, unknown>) {
  return store.localStartAttempt(taskAttemptId, inputEnvelope)
}

export async function sweepExpiredAttempts(input?: { now?: string; heartbeatTimeoutMs?: number }) {
  return store.localSweepExpiredAttempts(input)
}

export async function completeAttempt(input: {
  taskAttemptId: string
  outputResult?: Record<string, unknown>
  usage?: Record<string, unknown>
  failureKind?: string
  failureDetail?: Record<string, unknown>
  success: boolean
}) {
  return store.localCompleteAttempt(input)
}

export async function registerArtifact(input: Parameters<typeof store.localRegisterArtifact>[0]) {
  return store.localRegisterArtifact(input)
}

export async function updateArtifactSummary(artifactVersionId: string, summary: string) {
  return store.localUpdateArtifactSummary(artifactVersionId, summary)
}

export async function createReviewJobsForTask(task: ProductionTask, taskAttemptId: string, artifacts: ArtifactVersion[]) {
  return store.localCreateReviewJobsForTask(task, taskAttemptId, artifacts)
}

export async function createRevisionTask(input: {
  sourceTaskId: string
  reviewDecisionId: string
  artifactVersionId: string
  mustFix: string[]
  shouldFix?: string[]
}) {
  return store.localCreateRevisionTask(input)
}

export async function createEscalation(input: {
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  artifactVersionId?: string
  sourceType: string
  reasonCode: string
  payload?: Record<string, unknown>
}) {
  return store.localCreateEscalation(input)
}

export async function resolveEscalation(input: {
  escalationId: string
  productionId: string
  decisionType: string
  payload?: Record<string, unknown>
  decidedBy?: string
}) {
  return store.localResolveEscalation(input)
}
