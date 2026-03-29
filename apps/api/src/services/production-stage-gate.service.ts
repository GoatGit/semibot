/**
 * APS StageGate
 */

import { createLogger } from '../lib/logger'
import * as productionRepo from '../repositories/production.repository'
import * as productionService from './production.service'
import { evaluateStageGatePolicy, type StageGateDecision } from './production-stage-gate-policy.service'

const logger = createLogger('production-stage-gate')

export interface StageGateResult {
  decision: StageGateDecision
  stageId: string
  reason: string
  reviewDecisionIds?: string[]
  counts?: {
    reviewJobsTotal: number
    pendingReviews: number
    approved: number
    revisionRequested: number
    rejected: number
    failedTasks: number
    runningTasks: number
    doneTasks: number
  }
  revisionTaskId?: string
  escalationId?: string
}

export async function evaluateStageGateForReviewJob(reviewJobId: string): Promise<StageGateResult | null> {
  const reviewJob = await productionRepo.findReviewJobById(reviewJobId)
  if (!reviewJob) return null
  const production = await productionService.getProduction(reviewJob.productionId)
  const [stages, tasks, reviewJobs, reviewDecisions] = await Promise.all([
    productionRepo.listStages(production.id),
    productionRepo.listTasks(production.id),
    productionRepo.listReviewJobs(production.id),
    productionRepo.listReviewDecisions(production.id),
  ])

  const task = tasks.find((item) => item.id === reviewJob.taskId)
  const stage = stages.find((item) => item.id === task?.stageId)
  if (!task || !stage) return null

  const stageTaskIds = new Set(tasks.filter((item) => item.stageId === stage.id).map((item) => item.id))
  const stageReviewJobs = reviewJobs.filter((job) => stageTaskIds.has(job.taskId))
  const stageReviewDecisions = reviewDecisions.filter((decision) => stageTaskIds.has(decision.taskId))
  const policy = evaluateStageGatePolicy({
    production,
    stage,
    tasks: tasks.filter((item) => item.stageId === stage.id),
    reviewJobs: stageReviewJobs,
    reviewDecisions: stageReviewDecisions,
  })

  if (policy.decision === 'escalate') {
    const rejectedDecision = stageReviewDecisions.find((decision) => decision.id === policy.reviewDecisionId)
    if (!rejectedDecision) {
      return {
        decision: 'block',
        stageId: stage.id,
        reason: 'missing_review_decision_for_escalation',
        reviewDecisionIds: policy.reviewDecisionIds,
        counts: policy.counts,
      }
    }
    const escalationId = await productionRepo.createEscalation({
      productionId: production.id,
      stageId: stage.id,
      taskId: rejectedDecision.taskId,
      taskAttemptId: rejectedDecision.taskAttemptId,
      sourceType: 'review_decision',
      reasonCode: 'review_rejected',
      payload: { reviewDecisionId: rejectedDecision.id },
    })
    await productionRepo.updateStageStatus(stage.id, 'blocked')
    await productionRepo.updateState(production.id, { status: 'awaiting_human' })
    logger.info('APS StageGate escalated rejected review', { productionId: production.id, stageId: stage.id, escalationId })
    return {
      decision: 'escalate',
      stageId: stage.id,
      reason: policy.reason,
      reviewDecisionIds: policy.reviewDecisionIds,
      counts: policy.counts,
      escalationId,
    }
  }

  if (policy.decision === 'request_revision') {
    const revisionDecision = stageReviewDecisions.find((decision) => decision.id === policy.reviewDecisionId)
    if (!revisionDecision) {
      return {
        decision: 'block',
        stageId: stage.id,
        reason: 'missing_review_decision_for_revision',
        reviewDecisionIds: policy.reviewDecisionIds,
        counts: policy.counts,
      }
    }
    const sourceReviewJob = stageReviewJobs.find((job) => job.id === revisionDecision.reviewJobId)
    if (!sourceReviewJob) {
      return {
        decision: 'block',
        stageId: stage.id,
        reason: 'missing_review_job_for_revision',
        reviewDecisionIds: policy.reviewDecisionIds,
        counts: policy.counts,
      }
    }
    const revisionTask = await productionRepo.createRevisionTask({
      sourceTaskId: revisionDecision.taskId,
      reviewDecisionId: revisionDecision.id,
      artifactVersionId: sourceReviewJob.artifactVersionId,
      mustFix: revisionDecision.revisionRequest.mustFix,
      shouldFix: revisionDecision.revisionRequest.shouldFix,
    })
    await productionRepo.updateStageStatus(stage.id, 'active')
    logger.info('APS StageGate requested revision', {
      productionId: production.id,
      stageId: stage.id,
      reviewDecisionId: revisionDecision.id,
      revisionTaskId: revisionTask?.id,
    })
    return {
      decision: 'request_revision',
      stageId: stage.id,
      reason: policy.reason,
      reviewDecisionIds: policy.reviewDecisionIds,
      counts: policy.counts,
      revisionTaskId: revisionTask?.id,
    }
  }

  if (policy.decision === 'pass') {
    await productionRepo.updateStageStatus(stage.id, 'completed')
    const nextStage = stages
      .filter((item) => item.sequence > stage.sequence)
      .sort((a, b) => a.sequence - b.sequence)[0]
    if (nextStage) {
      await productionRepo.updateStageStatus(nextStage.id, 'active')
      await productionRepo.updateState(production.id, { currentStageId: nextStage.id, status: 'active' })
    } else {
      await productionRepo.updateState(production.id, {
        currentStageId: stage.id,
        status: 'completed',
        completedAt: new Date().toISOString(),
      })
    }
    logger.info('APS StageGate passed stage', { productionId: production.id, stageId: stage.id })
    return {
      decision: 'pass',
      stageId: stage.id,
      reason: policy.reason,
      reviewDecisionIds: policy.reviewDecisionIds,
      counts: policy.counts,
    }
  }

  return {
    decision: policy.decision,
    stageId: stage.id,
    reason: policy.reason,
    reviewDecisionIds: policy.reviewDecisionIds,
    counts: policy.counts,
  }
}
