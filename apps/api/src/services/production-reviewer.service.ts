import { createLogger } from '../lib/logger'
import * as agentService from './agent.service'
import * as productionRepo from '../repositories/production.repository'
import * as productionService from './production.service'
import * as sessionService from './session.service'
import { validateReviewerDecisionEnvelope } from './production-contracts'
import {
  consumeRuntimeSse,
  extractJsonObject,
  getRuntimeBaseUrl,
} from './production-runtime-client'
import type { ReviewerDecisionEnvelope, ReviewJob } from '@semibot/shared-types'

const logger = createLogger('production-reviewer-service')

const APS_REVIEWER_USER_ID = 'aps-reviewer'
const POLL_INTERVAL_MS = 1500
const MAX_WAIT_MS = 2 * 60 * 1000
const MAX_RUNTIME_REVIEW_ATTEMPTS = 2

function buildReviewerPrompt(input: {
  productionName: string
  productionGoal: string
  taskGoal: string
  reviewerRole: string
  artifactText: string
  taskKind: string
  rubric: string[]
  repairReason?: string
}): string {
  return [
    'You are an APS reviewer. Return exactly one JSON object.',
    'Schema: {"schemaVersion":"1.0","decision":"approved|request_revision|rejected","score":0.0-1.0,"findings":["..."],"revisionRequest":{"mustFix":["..."],"shouldFix":["..."]}}',
    'Use decision=request_revision when the content is salvageable but needs concrete fixes.',
    'Use decision=rejected only for fundamentally unusable output.',
    'revisionRequest.mustFix must contain at least one concrete fix when decision=request_revision.',
    `Production: ${input.productionName}`,
    `Production Goal: ${input.productionGoal}`,
    `Reviewer Role: ${input.reviewerRole}`,
    `Task Kind: ${input.taskKind}`,
    `Task Goal: ${input.taskGoal}`,
    `Rubric:\n${input.rubric.map((item) => `- ${item}`).join('\n')}`,
    input.repairReason ? `Repair previous invalid review output because: ${input.repairReason}` : '',
    `Artifact Content:\n${input.artifactText || '(empty)'}`,
  ].join('\n\n')
}

function buildReviewerRubric(task: { kind: string; goal: string; outputContract?: Array<{ artifactType?: string }> }): string[] {
  const base = [
    'Check whether the artifact satisfies the task goal.',
    'Check structure, clarity, and actionability of the artifact.',
  ]
  if (task.kind === 'generation') {
    return [
      ...base,
      'Check completeness versus the requested deliverable scope.',
      'Check whether the artifact is coherent and can be handed to the next stage.',
    ]
  }
  if (task.kind === 'revision') {
    return [
      ...base,
      'Check whether the revision addressed previously requested fixes.',
      'Check whether new regressions were introduced.',
    ]
  }
  if (task.kind === 'analysis') {
    return [
      ...base,
      'Check whether key findings are supported by the content.',
      'Check whether conclusions are specific rather than generic.',
    ]
  }
  if (task.kind === 'aggregation') {
    return [
      ...base,
      'Check whether inputs were merged consistently.',
      'Check whether cross-input contradictions are resolved or called out.',
    ]
  }
  return [
    ...base,
    'Check whether the output is usable as-is by the next stage.',
  ]
}

async function sendReviewerPrompt(sessionId: string, message: string, agentId: string): Promise<void> {
  const agent = await agentService.getAgent(agentId)
  const runtimeAgentConfig = await agentService.resolveRuntimeAgentConfig(agent.config)
  const response = await fetch(`${getRuntimeBaseUrl()}/api/v1/chat/sessions/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      agent_id: agent.id,
      model: runtimeAgentConfig.model,
      model_provider_key: runtimeAgentConfig.modelProviderKey,
      fallback_model: runtimeAgentConfig.fallbackModel,
      fallback_provider_key: runtimeAgentConfig.fallbackProviderKey,
      model_roles: runtimeAgentConfig.modelRoles,
      system_prompt: agent.systemPrompt || 'You are an APS reviewer. Return only valid JSON.',
      skill_index: [],
      capabilities: [],
      skillContext: [],
      stream: true,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`reviewer runtime call failed: ${response.status} ${body.slice(0, 200)}`)
  }
  await consumeRuntimeSse(response)
}

async function waitForReviewerSessionCompletion(sessionId: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const session = await sessionService.getSession(sessionId).catch(() => null)
    if (session?.status === 'completed' || session?.status === 'failed') return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`reviewer session ${sessionId} timed out`)
}

async function collectReviewerOutput(sessionId: string): Promise<string> {
  const messages = await sessionService.getSessionMessages(sessionId)
  return messages
    .filter((msg) => msg.role === 'assistant')
    .map((msg) => msg.content)
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export async function processAutoReviewJob(reviewJobId: string): Promise<void> {
  const reviewJob = await productionRepo.findReviewJobById(reviewJobId)
  if (!reviewJob || reviewJob.reviewerType !== 'llm_auto' || reviewJob.status !== 'pending') return

  const [production, task, artifactContent] = await Promise.all([
    productionService.getProduction(reviewJob.productionId),
    productionRepo.findTaskById(reviewJob.taskId),
    productionRepo.readArtifactContent(reviewJob.artifactVersionId),
  ])

  if (!task || !artifactContent) {
    const escalationId = await productionRepo.createEscalation({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      artifactVersionId: reviewJob.artifactVersionId,
      sourceType: 'auto_review',
      reasonCode: 'auto_review_missing_context',
      payload: { reviewJobId },
    })
    await productionRepo.updateState(reviewJob.productionId, { status: 'awaiting_human' })
    await productionRepo.appendEvent({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      eventType: 'review.auto_failed',
      payload: { reviewJobId, escalationId, reason: 'missing_context' },
    })
    return
  }

  const agentId =
    typeof (task.executionPolicy as Record<string, unknown>)?.reviewerAgentId === 'string'
      ? String((task.executionPolicy as Record<string, unknown>).reviewerAgentId)
      : typeof (production.config as Record<string, unknown>)?.defaultAgentId === 'string'
        ? String((production.config as Record<string, unknown>).defaultAgentId)
        : ''

  if (!agentId) {
    const escalationId = await productionRepo.createEscalation({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      artifactVersionId: reviewJob.artifactVersionId,
      sourceType: 'auto_review',
      reasonCode: 'auto_review_missing_agent',
      payload: { reviewJobId },
    })
    await productionRepo.updateState(reviewJob.productionId, { status: 'awaiting_human' })
    await productionRepo.appendEvent({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      eventType: 'review.auto_failed',
      payload: { reviewJobId, escalationId, reason: 'missing_agent' },
    })
    return
  }

  try {
    let normalized: ReviewerDecisionEnvelope | null = null
    let repairReason: string | undefined
    for (let attempt = 1; attempt <= MAX_RUNTIME_REVIEW_ATTEMPTS; attempt += 1) {
      const session = await sessionService.createSession(APS_REVIEWER_USER_ID, {
        agentId,
        title: `APS Review / ${task.title || task.key}`,
        metadata: {
          apsReviewer: true,
          reviewJobId,
          productionId: reviewJob.productionId,
          reviewerAttempt: attempt,
        },
      })

      await sendReviewerPrompt(
        session.id,
        buildReviewerPrompt({
          productionName: production.name,
          productionGoal: production.goal,
          taskGoal: task.goal,
          reviewerRole: reviewJob.reviewerRole,
          artifactText: artifactContent.content,
          taskKind: task.kind,
          rubric: buildReviewerRubric(task),
          repairReason,
        }),
        agentId
      )
      await waitForReviewerSessionCompletion(session.id)
      const raw = await collectReviewerOutput(session.id)
      const json = extractJsonObject(raw)
      if (!json) {
        repairReason = 'reviewer did not return a JSON object'
        await productionRepo.appendEvent({
          productionId: reviewJob.productionId,
          taskId: reviewJob.taskId,
          taskAttemptId: reviewJob.taskAttemptId,
          eventType: 'review.repair_requested',
          payload: { reviewJobId, reviewerAttempt: attempt, reason: repairReason },
        })
        continue
      }
      try {
        normalized = validateReviewerDecisionEnvelope(JSON.parse(json))
      } catch {
        normalized = null
      }
      if (normalized) break
      repairReason = 'reviewer returned invalid decision schema'
      await productionRepo.appendEvent({
        productionId: reviewJob.productionId,
        taskId: reviewJob.taskId,
        taskAttemptId: reviewJob.taskAttemptId,
        eventType: 'review.repair_requested',
        payload: { reviewJobId, reviewerAttempt: attempt, reason: repairReason },
      })
    }
    if (!normalized) throw new Error('invalid reviewer json')

    await productionService.submitReviewDecision({
      reviewJobId,
      decision: normalized.decision,
      score: normalized.score,
      findings: normalized.findings,
      revisionRequest: normalized.revisionRequest,
    })
    await productionRepo.appendEvent({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      eventType: 'review.auto_completed',
      payload: { reviewJobId, decision: normalized.decision },
    })
  } catch (error) {
    const escalationId = await productionRepo.createEscalation({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      artifactVersionId: reviewJob.artifactVersionId,
      sourceType: 'auto_review',
      reasonCode: 'auto_review_failed',
      payload: { reviewJobId, message: error instanceof Error ? error.message : String(error) },
    })
    await productionRepo.updateState(reviewJob.productionId, { status: 'awaiting_human' })
    await productionRepo.appendEvent({
      productionId: reviewJob.productionId,
      taskId: reviewJob.taskId,
      taskAttemptId: reviewJob.taskAttemptId,
      eventType: 'review.auto_failed',
      payload: { reviewJobId, escalationId, message: error instanceof Error ? error.message : String(error) },
    })
    logger.warn('APS auto review failed', { reviewJobId, error })
  }
}

export async function processAutoReviewJobs(reviewJobs: ReviewJob[]): Promise<void> {
  await Promise.allSettled(
    reviewJobs
      .filter((reviewJob) => reviewJob.reviewerType === 'llm_auto')
      .map((reviewJob) => processAutoReviewJob(reviewJob.id)),
  )
}
