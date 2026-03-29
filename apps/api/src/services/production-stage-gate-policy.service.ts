/**
 * APS StageGate policy
 *
 * Pure decision layer. Side effects stay in production-stage-gate.service.ts.
 */

import type {
  Production,
  ProductionStage,
  ProductionTask,
  ReviewDecision,
  ReviewJob,
  StageGateCounts,
  StageGateEvaluation,
} from '@semibot/shared-types'

export type StageGateDecision = 'pass' | 'block' | 'request_revision' | 'replan' | 'escalate'

export interface EvaluateStageGatePolicyInput {
  production: Production
  stage: ProductionStage
  tasks: ProductionTask[]
  reviewJobs: ReviewJob[]
  reviewDecisions: ReviewDecision[]
}

function getNumberConfig(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getApprovalStrategy(config: Record<string, unknown>): 'all_approved' | 'majority' | 'weighted' {
  const value = config.approvalStrategy
  if (value === 'majority' || value === 'weighted') return value
  return 'all_approved'
}

function buildStageGateCounts(input: {
  tasks: ProductionTask[]
  reviewJobs: ReviewJob[]
  reviewDecisions: ReviewDecision[]
}): StageGateCounts {
  return {
    reviewJobsTotal: input.reviewJobs.length,
    pendingReviews: input.reviewJobs.filter((job) => job.status !== 'completed').length,
    approved: input.reviewDecisions.filter((decision) => decision.decision === 'approved').length,
    revisionRequested: input.reviewDecisions.filter((decision) => decision.decision === 'request_revision').length,
    rejected: input.reviewDecisions.filter((decision) => decision.decision === 'rejected').length,
    failedTasks: input.tasks.filter((task) => task.status === 'failed').length,
    runningTasks: input.tasks.filter((task) => task.status === 'running').length,
    doneTasks: input.tasks.filter((task) => task.status === 'done').length,
  }
}

export function evaluateStageGatePolicy(input: EvaluateStageGatePolicyInput): StageGateEvaluation {
  const gateConfig = (input.stage.reviewGateConfig || {}) as Record<string, unknown>
  const stageTaskIds = new Set(input.tasks.map((task) => task.id))
  const stageReviewJobs = input.reviewJobs.filter((job) => stageTaskIds.has(job.taskId))
  const stageReviewDecisions = input.reviewDecisions
    .filter((decision) => stageTaskIds.has(decision.taskId))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
  const counts = buildStageGateCounts({
    tasks: input.tasks,
    reviewJobs: stageReviewJobs,
    reviewDecisions: stageReviewDecisions,
  })
  const reviewedCount = counts.approved + counts.revisionRequested + counts.rejected
  const approvalStrategy = getApprovalStrategy(gateConfig)
  const replanOnFailedTasksAt = getNumberConfig(gateConfig, 'replanOnFailedTasksAt')
  const replanOnRevisionRequestsAt = getNumberConfig(gateConfig, 'replanOnRevisionRequestsAt')
  const minWeightedScore = getNumberConfig(gateConfig, 'minWeightedScore') ?? 0.75

  const rejectedDecisions = stageReviewDecisions.filter((decision) => decision.decision === 'rejected')
  if (rejectedDecisions.length > 0) {
    return {
      decision: 'escalate',
      stageId: input.stage.id,
      reason: rejectedDecisions.length > 1 ? 'multiple_reviews_rejected' : 'review_rejected',
      reviewDecisionId: rejectedDecisions[0].id,
      reviewDecisionIds: rejectedDecisions.map((decision) => decision.id),
      counts,
    }
  }

  const revisionDecisions = stageReviewDecisions.filter((decision) => decision.decision === 'request_revision')
  if (replanOnRevisionRequestsAt && revisionDecisions.length >= replanOnRevisionRequestsAt) {
    return {
      decision: 'replan',
      stageId: input.stage.id,
      reason: 'revision_threshold_for_replan',
      reviewDecisionId: revisionDecisions[0]?.id,
      reviewDecisionIds: revisionDecisions.map((decision) => decision.id),
      counts,
    }
  }
  if (revisionDecisions.length > 0) {
    return {
      decision: 'request_revision',
      stageId: input.stage.id,
      reason: revisionDecisions.length > 1 ? 'multiple_reviews_requested_revision' : 'review_requested_revision',
      reviewDecisionId: revisionDecisions[0].id,
      reviewDecisionIds: revisionDecisions.map((decision) => decision.id),
      counts,
    }
  }

  const hasPendingReview = stageReviewJobs.some((job) => job.status !== 'completed')
  const allDone = input.tasks.length > 0 && input.tasks.every((task) => task.status === 'done')
  const allApproved = stageReviewDecisions.length > 0 && stageReviewDecisions.every((decision) => decision.decision === 'approved')
  const averageScore = reviewedCount > 0
    ? stageReviewDecisions.reduce((sum, decision) => sum + (typeof decision.score === 'number' ? decision.score : 0), 0) / reviewedCount
    : 0

  if (counts.failedTasks > 0) {
    if (replanOnFailedTasksAt && counts.failedTasks >= replanOnFailedTasksAt) {
      return {
        decision: 'replan',
        stageId: input.stage.id,
        reason: 'failed_task_threshold_for_replan',
        counts,
      }
    }
    return {
      decision: 'block',
      stageId: input.stage.id,
      reason: 'failed_tasks',
      counts,
    }
  }

  const passByStrategy = (() => {
    if (stageReviewJobs.length === 0) return true
    if (approvalStrategy === 'all_approved') return allApproved
    if (approvalStrategy === 'majority') return counts.approved > counts.revisionRequested
    return counts.approved >= counts.revisionRequested && averageScore >= minWeightedScore
  })()

  if (allDone && !hasPendingReview && passByStrategy) {
    return {
      decision: 'pass',
      stageId: input.stage.id,
      reason:
        approvalStrategy === 'majority'
          ? 'stage_ready_by_majority'
          : approvalStrategy === 'weighted'
            ? 'stage_ready_by_weighted_score'
            : 'stage_ready_to_advance',
      counts,
    }
  }

  return {
    decision: 'block',
    stageId: input.stage.id,
    reason: hasPendingReview ? 'pending_reviews' : counts.runningTasks > 0 ? 'running_tasks' : 'stage_not_ready',
    counts,
  }
}
