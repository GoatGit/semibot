/**
 * APS Service
 */

import { createError } from '../middleware/errorHandler'
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import { createLogger } from '../lib/logger'
import * as productionRepo from '../repositories/production.repository'
import * as productionPlanner from './production-planner.service'
import * as stageGateService from './production-stage-gate.service'
import type {
  ArtifactDiffSummary,
  ArtifactLineageSummary,
  CreateProductionInput,
  ProductionGraphDiffSummary,
  ProductionPlanSnapshot,
  ProductionControlRoomSummary,
  ProductionPortfolioIssue,
  ProductionPortfolioItem,
  ProductionPortfolioSummary,
  Escalation,
  HumanDecision,
  Production,
  ProductionEvent,
  ProductionPlan,
  ProductionStage,
  ProductionStageHealth,
  ProductionTask,
  ReplanProductionInput,
  ReviewDecision,
  ReviewJob,
  TaskAttempt,
} from '@semibot/shared-types'

const logger = createLogger('production-service')

export interface ProductionDetail {
  production: Production
  plan?: ProductionPlan
  planSnapshots: ProductionPlanSnapshot[]
  stages: ProductionStage[]
  tasks: ProductionTask[]
  attempts: TaskAttempt[]
  artifacts: Awaited<ReturnType<typeof productionRepo.listArtifacts>>
  reviewJobs: ReviewJob[]
  reviewDecisions: ReviewDecision[]
  escalations: Escalation[]
  humanDecisions: HumanDecision[]
  events: ProductionEvent[]
  controlRoom: ProductionControlRoomSummary
}

export interface ReviewInboxItem {
  production: Production
  reviewJob: ReviewJob
  task?: ProductionTask
  artifact?: Awaited<ReturnType<typeof productionRepo.findArtifactById>>
}

export interface EscalationInboxItem {
  production: Production
  escalation: Escalation
  task?: ProductionTask
}

export interface HumanInboxItem {
  kind: 'review' | 'escalation'
  production: Production
  reviewJob?: ReviewJob
  artifact?: Awaited<ReturnType<typeof productionRepo.findArtifactById>>
  escalation?: Escalation
  task?: ProductionTask
}

function getHumanInboxItemCreatedAt(item: HumanInboxItem): string {
  if (item.kind === 'review') return item.reviewJob?.createdAt || item.production.updatedAt
  return item.escalation?.createdAt || item.production.updatedAt
}

function derivePortfolioIssue(input: {
  production: Production
  controlRoom: ProductionControlRoomSummary
}): ProductionPortfolioIssue {
  if (input.production.status === 'awaiting_human' || input.controlRoom.openEscalations > 0) {
    return {
      severity: 'critical',
      code: 'awaiting_human',
      title: '等待人工介入',
      description: '存在 escalation 或人工决策阻塞，优先处理。',
    }
  }
  if (input.controlRoom.stageHealth.some((stage) => stage.health === 'blocked')) {
    return {
      severity: 'critical',
      code: 'blocked_stage',
      title: '存在阻塞阶段',
      description: '当前 stage 因失败或 rejected review 被阻塞。',
    }
  }
  if (input.controlRoom.pendingReviews > 0) {
    return {
      severity: 'warning',
      code: 'pending_reviews',
      title: '待处理 Review',
      description: '有 review job 尚未完成，推进会受阻。',
    }
  }
  if (input.controlRoom.failedTasks > 0) {
    return {
      severity: 'warning',
      code: 'failed_tasks',
      title: '存在失败 Task',
      description: '需要检查失败原因或考虑 replan。',
    }
  }
  if (input.controlRoom.runningTasks > 0) {
    return {
      severity: 'info',
      code: 'running',
      title: '正在推进',
      description: '当前存在运行中 task，继续观察即可。',
    }
  }
  return {
    severity: 'info',
    code: 'healthy',
    title: '相对健康',
    description: '当前没有明显阻塞，可低频巡检。',
  }
}

function deriveStageHealth(input: {
  stage: ProductionStage
  tasks: ProductionTask[]
  reviewJobs: ReviewJob[]
  reviewDecisions: ReviewDecision[]
}): ProductionStageHealth {
  const stageTaskIds = new Set(input.tasks.map((task) => task.id))
  const taskCounts = {
    total: input.tasks.length,
    pending: input.tasks.filter((task) => task.status === 'pending').length,
    running: input.tasks.filter((task) => task.status === 'running').length,
    done: input.tasks.filter((task) => task.status === 'done').length,
    failed: input.tasks.filter((task) => task.status === 'failed').length,
    superseded: input.tasks.filter((task) => task.status === 'superseded').length,
  }
  const decisions = input.reviewDecisions.filter((decision) => stageTaskIds.has(decision.taskId))
  const reviewCounts = {
    total: input.reviewJobs.length,
    pending: input.reviewJobs.filter((job) => job.status !== 'completed').length,
    approved: decisions.filter((decision) => decision.decision === 'approved').length,
    revisionRequested: decisions.filter((decision) => decision.decision === 'request_revision').length,
    rejected: decisions.filter((decision) => decision.decision === 'rejected').length,
  }

  let health: ProductionStageHealth['health'] = 'healthy'
  let reason = 'stage progressing normally'
  if (input.stage.status === 'completed') {
    health = 'completed'
    reason = 'stage completed'
  } else if (input.stage.status === 'blocked' || input.stage.status === 'failed' || reviewCounts.rejected > 0 || taskCounts.failed > 0) {
    health = 'blocked'
    reason = reviewCounts.rejected > 0 ? 'review rejected output' : 'task failure is blocking the stage'
  } else if (reviewCounts.pending > 0) {
    health = 'waiting_review'
    reason = 'waiting for review jobs to complete'
  } else if (reviewCounts.revisionRequested > 0 || taskCounts.running > 0) {
    health = 'at_risk'
    reason = reviewCounts.revisionRequested > 0 ? 'revision requested in current stage' : 'stage still executing tasks'
  }

  return {
    stageId: input.stage.id,
    stageKey: input.stage.key,
    stageTitle: input.stage.title,
    status: input.stage.status,
    health,
    reason,
    taskCounts,
    reviewCounts,
  }
}

function deriveControlRoomSummary(input: {
  stages: ProductionStage[]
  tasks: ProductionTask[]
  attempts: TaskAttempt[]
  reviewJobs: ReviewJob[]
  reviewDecisions: ReviewDecision[]
  escalations: Escalation[]
}): ProductionControlRoomSummary {
  const totalTokens = input.attempts.reduce((sum, attempt) => sum + Number((attempt.usage?.total_tokens as number | undefined) || 0), 0)
  const stageHealth = input.stages.map((stage) => deriveStageHealth({
    stage,
    tasks: input.tasks.filter((task) => task.stageId === stage.id),
    reviewJobs: input.reviewJobs.filter((job) => input.tasks.some((task) => task.stageId === stage.id && task.id === job.taskId)),
    reviewDecisions: input.reviewDecisions,
  }))
  return {
    pendingReviews: input.reviewJobs.filter((job) => job.status !== 'completed').length,
    openEscalations: input.escalations.filter((item) => item.status === 'open').length,
    runningTasks: input.tasks.filter((task) => task.status === 'running').length,
    revisionTasks: input.tasks.filter((task) => task.kind === 'revision' && task.status !== 'done').length,
    failedTasks: input.tasks.filter((task) => task.status === 'failed').length,
    totalTokens,
    stageHealth,
  }
}

function toPlanSnapshot(row: Awaited<ReturnType<typeof productionRepo.findPlanById>>): ProductionPlanSnapshot | null {
  if (!row) return null
  return {
    id: row.id,
    productionId: row.production_id,
    planVersion: row.plan_version,
    schemaVersion: row.schema_version,
    plannerType: row.planner_type,
    rationale: row.rationale || undefined,
    plannerMetadata: row.metadata || {},
    graph: row.graph,
    createdAt: row.created_at,
  }
}

function buildGraphDiffSummary(input: {
  currentPlan?: ProductionPlanSnapshot
  basePlan?: ProductionPlanSnapshot
  tasks: ProductionTask[]
}): ProductionGraphDiffSummary {
  const currentStageKeys = new Set(input.currentPlan?.graph.stages.map((stage) => stage.key) || [])
  const baseStageKeys = new Set(input.basePlan?.graph.stages.map((stage) => stage.key) || [])
  const currentTaskKeys = new Set(input.currentPlan?.graph.stages.flatMap((stage) => stage.tasks.map((task) => task.key)) || [])
  const baseTaskKeys = new Set(input.basePlan?.graph.stages.flatMap((stage) => stage.tasks.map((task) => task.key)) || [])
  const addedStageKeys = [...currentStageKeys].filter((key) => !baseStageKeys.has(key))
  const removedStageKeys = [...baseStageKeys].filter((key) => !currentStageKeys.has(key))
  const addedTaskKeys = [...currentTaskKeys].filter((key) => !baseTaskKeys.has(key))
  const removedTaskKeys = [...baseTaskKeys].filter((key) => !currentTaskKeys.has(key))
  const supersededTaskIds = input.tasks.filter((task) => task.status === 'superseded' || task.failureReason === 'superseded').map((task) => task.id)
  return {
    currentPlan: input.currentPlan,
    basePlan: input.basePlan,
    stats: {
      addedStages: addedStageKeys.length,
      removedStages: removedStageKeys.length,
      addedTasks: addedTaskKeys.length,
      removedTasks: removedTaskKeys.length,
      supersededTasks: supersededTaskIds.length,
    },
    addedStageKeys,
    removedStageKeys,
    addedTaskKeys,
    removedTaskKeys,
    supersededTaskIds,
  }
}

export async function createProduction(data: CreateProductionInput, createdBy: string): Promise<ProductionDetail> {
  const plannerResult = await productionPlanner.buildInitialPlanResult(data)
  const created = await productionRepo.create({ ...data, plan: plannerResult.plan, plannerMetadata: plannerResult.plannerMetadata }, createdBy)
  const detail = await getProductionDetail(created.production.id)
  logger.info('APS production 已创建', { productionId: detail.production.id, status: detail.production.status })
  return detail
}

export async function replanProduction(id: string, input: ReplanProductionInput): Promise<ProductionDetail> {
  const production = await getProduction(id)
  const currentPlanRow = production.currentPlanId ? await productionRepo.findPlanById(production.currentPlanId) : null
  const plannerResult = await productionPlanner.buildReplanResult(
    { ...production, currentPlan: currentPlanRow?.graph },
    input,
  )
  const result = await productionRepo.replan(id, { ...input, plan: plannerResult.plan, plannerMetadata: plannerResult.plannerMetadata })
  if (!result) throw createError(RESOURCE_NOT_FOUND, 'Production 不存在')
  return getProductionDetail(id)
}

export async function listProductions(params: { page?: number; limit?: number; status?: Production['status']; search?: string }) {
  return productionRepo.list(params)
}

export async function getProductionControlRoom(params: {
  page?: number
  limit?: number
  status?: Production['status']
  search?: string
}): Promise<ProductionPortfolioSummary> {
  const listed = await productionRepo.list(params)
  const items: ProductionPortfolioItem[] = await Promise.all(listed.data.map(async (production) => {
    const detail = await getProductionDetail(production.id)
    const currentStage = detail.stages.find((stage) => stage.id === production.currentStageId)
      || detail.stages.find((stage) => stage.status === 'active')
      || detail.stages[0]
    return {
      production,
      controlRoom: detail.controlRoom,
      currentStage,
      topIssue: derivePortfolioIssue({
        production,
        controlRoom: detail.controlRoom,
      }),
    }
  }))

  const totals = items.reduce<ProductionPortfolioSummary['totals']>((acc, item) => {
    acc.productions += 1
    acc.pendingReviews += item.controlRoom.pendingReviews
    acc.openEscalations += item.controlRoom.openEscalations
    acc.runningTasks += item.controlRoom.runningTasks
    acc.totalTokens += item.controlRoom.totalTokens
    if (item.production.status === 'active') acc.active += 1
    if (item.production.status === 'awaiting_human') acc.awaitingHuman += 1
    if (item.controlRoom.stageHealth.some((stage) => stage.health === 'blocked')) acc.blocked += 1
    return acc
  }, {
    productions: 0,
    active: 0,
    awaitingHuman: 0,
    blocked: 0,
    pendingReviews: 0,
    openEscalations: 0,
    runningTasks: 0,
    totalTokens: 0,
  })

  return {
    totals,
    items: items.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 }
      const diff = rank[a.topIssue.severity] - rank[b.topIssue.severity]
      if (diff !== 0) return diff
      return new Date(b.production.updatedAt).getTime() - new Date(a.production.updatedAt).getTime()
    }),
  }
}

export async function getProduction(id: string): Promise<Production> {
  const production = await productionRepo.findById(id)
  if (!production) throw createError(RESOURCE_NOT_FOUND, 'Production 不存在')
  return production
}

export async function getProductionDetail(id: string): Promise<ProductionDetail> {
  const production = await getProduction(id)
  const [stages, tasks, attempts, artifacts, reviewJobs, reviewDecisions, escalations, humanDecisions, events, planRows] = await Promise.all([
    productionRepo.listStages(id),
    productionRepo.listTasks(id),
    productionRepo.listAttempts(id),
    productionRepo.listArtifacts(id),
    productionRepo.listReviewJobs(id),
    productionRepo.listReviewDecisions(id),
    productionRepo.listEscalations(id),
    productionRepo.listHumanDecisions(id),
    productionRepo.listEvents(id, 200),
    productionRepo.listPlans(id),
  ])
  const plan = production.currentPlanId ? await productionRepo.findPlanById(production.currentPlanId) : null
  return {
    production,
    plan: plan?.graph,
    planSnapshots: planRows.map((row) => ({
      id: row.id,
      productionId: row.production_id,
      planVersion: row.plan_version,
      schemaVersion: row.schema_version,
      plannerType: row.planner_type,
      rationale: row.rationale || undefined,
      plannerMetadata: row.metadata || {},
      graph: row.graph,
      createdAt: row.created_at,
    })),
    stages,
    tasks,
    attempts,
    artifacts,
    reviewJobs,
    reviewDecisions,
    escalations,
    humanDecisions,
    events,
    controlRoom: deriveControlRoomSummary({
      stages,
      tasks,
      attempts,
      reviewJobs,
      reviewDecisions,
      escalations,
    }),
  }
}

export async function listProductionPlans(id: string): Promise<ProductionPlanSnapshot[]> {
  await getProduction(id)
  const plans = await productionRepo.listPlans(id)
  return plans.map((row) => ({
    id: row.id,
    productionId: row.production_id,
    planVersion: row.plan_version,
    schemaVersion: row.schema_version,
    plannerType: row.planner_type,
    rationale: row.rationale || undefined,
    plannerMetadata: row.metadata || {},
    graph: row.graph,
    createdAt: row.created_at,
  }))
}

export async function getProductionGraphSummary(productionId: string, basePlanId?: string): Promise<ProductionGraphDiffSummary> {
  await getProduction(productionId)
  const [plans, tasks] = await Promise.all([
    productionRepo.listPlans(productionId),
    productionRepo.listTasks(productionId),
  ])
  const currentPlan = toPlanSnapshot(plans[0] || null) || undefined
  const basePlan = basePlanId
    ? toPlanSnapshot(plans.find((plan) => plan.id === basePlanId) || null) || undefined
    : toPlanSnapshot(plans[1] || null) || undefined
  return buildGraphDiffSummary({
    currentPlan,
    basePlan,
    tasks,
  })
}

export async function activateProduction(id: string): Promise<Production> {
  const production = await getProduction(id)
  if (production.status === 'completed' || production.status === 'failed' || production.status === 'cancelled') {
    throw createError(RESOURCE_CONFLICT, 'Production 已结束，无法激活')
  }
  const updated = await productionRepo.updateState(id, { status: 'active', isPaused: false })
  if (!updated) throw createError(RESOURCE_NOT_FOUND, 'Production 不存在')
  await productionRepo.appendEvent({
    productionId: id,
    eventType: 'production.activated',
    payload: { previousStatus: production.status },
  })
  return updated
}

export async function pauseProduction(id: string): Promise<Production> {
  const production = await getProduction(id)
  if (production.status !== 'active') {
    throw createError(RESOURCE_CONFLICT, 'Production 当前不在运行态')
  }
  const updated = await productionRepo.updateState(id, { status: 'paused', isPaused: true })
  if (!updated) throw createError(RESOURCE_NOT_FOUND, 'Production 不存在')
  await productionRepo.appendEvent({
    productionId: id,
    eventType: 'production.paused',
    payload: {},
  })
  return updated
}

export async function listProductionTasks(id: string): Promise<ProductionTask[]> {
  await getProduction(id)
  return productionRepo.listTasks(id)
}

export async function getProductionTask(productionId: string, taskId: string): Promise<ProductionTask> {
  await getProduction(productionId)
  const task = await productionRepo.findTaskById(taskId)
  if (!task || task.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Task 不存在')
  }
  return task
}

export async function getProductionAttempt(productionId: string, attemptId: string): Promise<TaskAttempt> {
  await getProduction(productionId)
  const attempt = await productionRepo.findAttemptById(attemptId)
  if (!attempt) {
    throw createError(RESOURCE_NOT_FOUND, 'Attempt 不存在')
  }
  const task = await productionRepo.findTaskById(attempt.taskId)
  if (!task || task.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Attempt 不存在')
  }
  return attempt
}

export async function listProductionStages(id: string): Promise<ProductionStage[]> {
  await getProduction(id)
  return productionRepo.listStages(id)
}

export async function getProductionStage(productionId: string, stageId: string): Promise<ProductionStage> {
  await getProduction(productionId)
  const stage = await productionRepo.findStageById(stageId)
  if (!stage || stage.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Stage 不存在')
  }
  return stage
}

export async function listProductionArtifacts(id: string) {
  await getProduction(id)
  return productionRepo.listArtifacts(id)
}

export async function getArtifact(productionId: string, artifactVersionId: string) {
  await getProduction(productionId)
  const artifact = await productionRepo.findArtifactById(artifactVersionId)
  if (!artifact || artifact.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Artifact 不存在')
  }
  return artifact
}

export async function getArtifactContent(productionId: string, artifactVersionId: string) {
  await getProduction(productionId)
  const result = await productionRepo.readArtifactContent(artifactVersionId)
  if (!result || result.artifact.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Artifact 内容不存在')
  }
  return result
}

export async function getArtifactLineage(productionId: string, artifactVersionId: string): Promise<ArtifactLineageSummary> {
  const artifact = await getArtifact(productionId, artifactVersionId)
  const artifacts = await productionRepo.listArtifacts(productionId)
  const sameKey = artifacts
    .filter((item) => item.artifactKey === artifact.artifactKey)
    .sort((a, b) => a.version - b.version)
  const relatedIds = new Set<string>([artifact.id, ...(artifact.lineageRefs || [])])
  const related = sameKey.filter((item) => relatedIds.has(item.id) || item.lineageRefs.some((ref) => ref === artifact.id))
  const previous = sameKey.filter((item) => item.version < artifact.version).sort((a, b) => b.version - a.version)[0]
  return {
    current: artifact,
    previous,
    related,
  }
}

function buildArtifactDiffLines(baseContent: string, nextContent: string): ArtifactDiffSummary['lines'] {
  const baseLines = baseContent.split('\n')
  const nextLines = nextContent.split('\n')
  const max = Math.max(baseLines.length, nextLines.length)
  const lines: ArtifactDiffSummary['lines'] = []
  for (let index = 0; index < max; index += 1) {
    const before = baseLines[index]
    const after = nextLines[index]
    if (before === after) {
      lines.push({ type: 'context', content: before ?? '' })
      continue
    }
    if (before !== undefined) lines.push({ type: 'removed', content: before })
    if (after !== undefined) lines.push({ type: 'added', content: after })
  }
  return lines
}

export async function getArtifactDiff(
  productionId: string,
  artifactVersionId: string,
  baseArtifactVersionId?: string,
): Promise<ArtifactDiffSummary> {
  const current = await getArtifactContent(productionId, artifactVersionId)
  const lineage = await getArtifactLineage(productionId, artifactVersionId)
  const baseArtifact = baseArtifactVersionId
    ? await getArtifactContent(productionId, baseArtifactVersionId)
    : lineage.previous
      ? await getArtifactContent(productionId, lineage.previous.id)
      : null
  const baseContent = baseArtifact?.content || ''
  const nextContent = current.content || ''
  const lines = buildArtifactDiffLines(baseContent, nextContent)
  return {
    artifact: current.artifact,
    baseArtifact: baseArtifact?.artifact,
    stats: {
      added: lines.filter((line) => line.type === 'added').length,
      removed: lines.filter((line) => line.type === 'removed').length,
      changed: lines.some((line) => line.type !== 'context'),
    },
    lines,
  }
}

export async function updateArtifactSummary(productionId: string, artifactVersionId: string, summary: string) {
  await getProduction(productionId)
  const artifact = await productionRepo.findArtifactById(artifactVersionId)
  if (!artifact || artifact.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Artifact 不存在')
  }
  const updated = await productionRepo.updateArtifactSummary(artifactVersionId, summary)
  if (!updated) {
    throw createError(RESOURCE_NOT_FOUND, 'Artifact 不存在')
  }
  return updated
}

export async function listProductionReviewJobs(id: string): Promise<ReviewJob[]> {
  await getProduction(id)
  return productionRepo.listReviewJobs(id)
}

export async function listOpenReviewInbox(limit = 50): Promise<ReviewInboxItem[]> {
  const reviewJobs = await productionRepo.listOpenReviewJobs(limit)
  const items: Array<ReviewInboxItem | null> = await Promise.all(reviewJobs.map(async (reviewJob) => {
    const [production, task, artifact] = await Promise.all([
      productionRepo.findById(reviewJob.productionId),
      productionRepo.findTaskById(reviewJob.taskId),
      productionRepo.findArtifactById(reviewJob.artifactVersionId),
    ])
    if (!production) return null
    return {
      production,
      reviewJob,
      task: task || undefined,
      artifact: artifact || undefined,
    } satisfies ReviewInboxItem
  }))
  return items.filter((item): item is ReviewInboxItem => Boolean(item))
}

export async function listProductionReviewDecisions(id: string): Promise<ReviewDecision[]> {
  await getProduction(id)
  return productionRepo.listReviewDecisions(id)
}

export async function listProductionReviews(id: string): Promise<{ reviewJobs: ReviewJob[]; reviewDecisions: ReviewDecision[] }> {
  await getProduction(id)
  const [reviewJobs, reviewDecisions] = await Promise.all([
    productionRepo.listReviewJobs(id),
    productionRepo.listReviewDecisions(id),
  ])
  return { reviewJobs, reviewDecisions }
}

export async function listProductionEvents(id: string, limit?: number): Promise<ProductionEvent[]> {
  await getProduction(id)
  return productionRepo.listEvents(id, limit)
}

export async function listProductionEscalations(id: string): Promise<Escalation[]> {
  await getProduction(id)
  return productionRepo.listEscalations(id)
}

export async function listOpenEscalationInbox(limit = 50): Promise<EscalationInboxItem[]> {
  const escalations = await productionRepo.listOpenEscalations(limit)
  const items: Array<EscalationInboxItem | null> = await Promise.all(escalations.map(async (escalation) => {
    const [production, task] = await Promise.all([
      productionRepo.findById(escalation.productionId),
      escalation.taskId ? productionRepo.findTaskById(escalation.taskId) : Promise.resolve(null),
    ])
    if (!production) return null
    return {
      production,
      escalation,
      task: task || undefined,
    } satisfies EscalationInboxItem
  }))
  return items.filter((item): item is EscalationInboxItem => Boolean(item))
}

export async function listOpenHumanInbox(limit = 100): Promise<HumanInboxItem[]> {
  const [reviewItems, escalationItems] = await Promise.all([
    listOpenReviewInbox(limit),
    listOpenEscalationInbox(limit),
  ])
  return [
    ...reviewItems.map((item) => ({
      kind: 'review' as const,
      production: item.production,
      reviewJob: item.reviewJob,
      artifact: item.artifact,
      task: item.task,
    })),
    ...escalationItems.map((item) => ({
      kind: 'escalation' as const,
      production: item.production,
      escalation: item.escalation,
      task: item.task,
    })),
  ].sort((a, b) => new Date(getHumanInboxItemCreatedAt(b)).getTime() - new Date(getHumanInboxItemCreatedAt(a)).getTime())
}

export async function getProductionEscalation(productionId: string, escalationId: string): Promise<Escalation> {
  await getProduction(productionId)
  const escalation = await productionRepo.findEscalationById(escalationId)
  if (!escalation || escalation.productionId !== productionId) {
    throw createError(RESOURCE_NOT_FOUND, 'Escalation 不存在')
  }
  return escalation
}

export async function submitReviewDecision(input: {
  reviewJobId: string
  decision: 'approved' | 'request_revision' | 'rejected'
  score?: number
  findings?: string[]
  revisionRequest?: {
    mustFix?: string[]
    shouldFix?: string[]
  }
}) {
  const result = await productionRepo.recordReviewDecision(input)
  if (!result) throw createError(RESOURCE_NOT_FOUND, 'ReviewJob 不存在')
  await productionRepo.appendEvent({
    productionId: result.reviewJob.productionId,
    stageId: (await productionRepo.findTaskById(result.reviewJob.taskId))?.stageId,
    taskId: result.reviewJob.taskId,
    taskAttemptId: result.reviewJob.taskAttemptId,
    eventType: 'review.completed',
    payload: {
      reviewJobId: result.reviewJob.id,
      reviewDecisionId: result.reviewDecision.id,
      decision: result.reviewDecision.decision,
    },
  })
  const stageGate = await stageGateService.evaluateStageGateForReviewJob(result.reviewJob.id)
  return {
    ...result,
    stageGate,
  }
}

export async function resolveEscalation(input: {
  productionId: string
  escalationId: string
  decisionType: string
  payload?: Record<string, unknown>
  decidedBy?: string
}) {
  const result = await productionRepo.resolveEscalation(input)
  if (!result) throw createError(RESOURCE_NOT_FOUND, 'Escalation 不存在')
  await productionRepo.updateState(input.productionId, { status: 'active' })
  await productionRepo.appendEvent({
    productionId: input.productionId,
    eventType: 'escalation.resolved',
    payload: {
      escalationId: input.escalationId,
      decisionType: input.decisionType,
    },
  })
  void import('./production-engine.service')
    .then((engine) => engine.runProductionGuarded(input.productionId))
    .catch((error) => {
      logger.warn('APS resolveEscalation auto-resume failed', {
        productionId: input.productionId,
        escalationId: input.escalationId,
        error,
      })
    })
  return result
}
