/**
 * APS execution engine
 *
 * Runs a task through the existing chat/runtime pipeline.
 */

import { createLogger } from '../lib/logger'
import * as productionRepo from '../repositories/production.repository'
import * as productionReviewerService from './production-reviewer.service'
import * as productionService from './production.service'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
import {
  buildTypedResultRepairReason,
  validateTypedResult,
} from './production-contracts'
import {
  consumeRuntimeSse,
  getRuntimeBaseUrl,
} from './production-runtime-client'
import type {
  ProductionStage,
  ProductionTask,
  TaskEnvelope,
  TypedResult,
  TypedResultArtifactRef,
} from '@semibot/shared-types'

const logger = createLogger('production-engine')

const APS_USER_ID = 'aps-engine'
const POLL_INTERVAL_MS = 2000
const MAX_WAIT_MS = 30 * 60 * 1000
const MAX_RUN_PRODUCTION_ITERATIONS = 100
const RUN_PRODUCTION_DEADLINE_MS = 15 * 60 * 1000
const APS_ATTEMPT_ALREADY_COMPLETED = 'apsAttemptAlreadyCompleted'
const MAX_TYPED_RESULT_REPAIR_ATTEMPTS = 2
const runningProductionIds = new Set<string>()

async function sendMessageToRuntime(
  sessionId: string,
  message: string,
  agent: Awaited<ReturnType<typeof agentService.getAgent>>
): Promise<{ finalResponse: string; usage: Record<string, unknown> }> {
  const baseUrl = getRuntimeBaseUrl()
  const runtimeAgentConfig = await agentService.resolveRuntimeAgentConfig(agent.config)
  const response = await fetch(`${baseUrl}/api/v1/chat/sessions/${sessionId}`, {
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
      system_prompt: agent.systemPrompt || `你是 ${agent.name}，负责执行 APS 任务。`,
      skill_index: [],
      stream: true,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Runtime 调用失败: HTTP ${response.status} ${body.slice(0, 200)}`)
  }

  const result = await consumeRuntimeSse(response)
  return {
    finalResponse: result.finalResponse,
    usage: result.usage,
  }
}

async function waitForSessionCompletion(sessionId: string): Promise<'completed' | 'failed'> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const session = await sessionService.getSession(sessionId)
      if (session.status === 'completed') return 'completed'
      if (session.status === 'failed') return 'failed'
    } catch {
      // session may not be fully visible yet
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`session ${sessionId} 超时（30分钟）`)
}

function buildTaskPrompt(input: TaskEnvelope, repairReason?: string): string {
  const outputInstructions = input.outputContracts.length > 1
    ? [
        '# Output Formatting',
        'You must separate each deliverable using exact markers.',
        ...input.outputContracts.map((output) => `[[artifact:${output.artifactKey}]]`),
      ].join('\n')
    : '# Output Requirement\n请直接给出最终可交付内容。'
  const sections = [
    `# TaskEnvelope\n${JSON.stringify(input, null, 2)}`,
    outputInstructions,
    repairReason ? `# Repair Required\n${repairReason}` : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}

async function collectAssistantOutput(
  sessionId: string,
  fallbackFinalResponse?: string,
  fallbackUsage?: Record<string, unknown>,
): Promise<{ text: string; usage: Record<string, unknown> }> {
  const messages = await sessionService.getSessionMessages(sessionId)
  const assistantText = messages
    .filter((msg) => msg.role === 'assistant')
    .map((msg) => msg.content)
    .filter((content) => Boolean(content?.trim()))
    .join('\n\n')
    .trim()
  return {
    text: (fallbackFinalResponse || '').trim() || assistantText || '',
    usage: fallbackUsage || {},
  }
}

function buildTaskEnvelope(input: {
  production: Awaited<ReturnType<typeof productionService.getProduction>>
  stage?: ProductionStage
  task: ProductionTask
  attemptNo: number
  inputArtifacts: Array<NonNullable<Awaited<ReturnType<typeof productionRepo.findArtifactById>>>>
}): TaskEnvelope {
  const revisionContext = (input.task.executionPolicy as Record<string, unknown> | undefined)?.revisionContext as
    | {
        reviewDecisionId?: string
        priorArtifactVersionId?: string
        mustFix?: string[]
        shouldFix?: string[]
      }
    | undefined
  return {
    schemaVersion: '1.0',
    productionId: input.production.id,
    productionName: input.production.name,
    productionGoal: input.production.goal,
    stageId: input.stage?.id,
    stageTitle: input.stage?.title,
    taskId: input.task.id,
    taskKey: input.task.key,
    taskTitle: input.task.title,
    taskGoal: input.task.goal,
    taskKind: input.task.kind,
    attemptNo: input.attemptNo,
    role: input.task.role,
    inputArtifacts: input.inputArtifacts.map((artifact) => ({
      artifactVersionId: artifact.id,
      artifactKey: artifact.artifactKey,
      artifactType: artifact.artifactType,
      version: artifact.version,
      summary: artifact.summary,
    })),
    outputContracts: input.task.outputContract,
    reviewPolicy: input.task.reviewPolicy,
    executionPolicy: input.task.executionPolicy,
    budgetPolicy: input.task.budgetPolicy,
    deadlineAt: input.task.budgetPolicy?.maxDurationSeconds
      ? new Date(Date.now() + input.task.budgetPolicy.maxDurationSeconds * 1000).toISOString()
      : undefined,
    revisionContext: revisionContext
      ? {
          reviewDecisionId: revisionContext.reviewDecisionId,
          priorArtifactVersionId: revisionContext.priorArtifactVersionId,
          mustFix: Array.isArray(revisionContext.mustFix) ? revisionContext.mustFix : [],
          shouldFix: Array.isArray(revisionContext.shouldFix) ? revisionContext.shouldFix : [],
        }
      : undefined,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitArtifactContent(
  outputText: string,
  outputContracts: Array<{ artifactKey: string }>,
): Record<string, string> {
  const trimmed = outputText.trim()
  if (!trimmed) return {}
  if (outputContracts.length <= 1) {
    return outputContracts[0] ? { [outputContracts[0].artifactKey]: trimmed } : {}
  }

  const result: Record<string, string> = {}
  for (let index = 0; index < outputContracts.length; index += 1) {
    const current = outputContracts[index]
    const next = outputContracts[index + 1]
    const startPattern = new RegExp(`\\[\\[\\s*artifact\\s*:\\s*${escapeRegex(current.artifactKey)}\\s*\\]\\]`, 'i')
    const endPattern = next
      ? new RegExp(`\\[\\[\\s*artifact\\s*:\\s*${escapeRegex(next.artifactKey)}\\s*\\]\\]`, 'i')
      : null
    const startMatch = startPattern.exec(trimmed)
    if (!startMatch || startMatch.index < 0) continue
    const contentStart = startMatch.index + startMatch[0].length
    const tail = trimmed.slice(contentStart)
    const endMatch = endPattern ? endPattern.exec(tail) : null
    const slice = (endMatch ? tail.slice(0, endMatch.index) : tail).trim()
    if (slice) result[current.artifactKey] = slice
  }
  if (Object.keys(result).length === 0 && outputContracts[0]) {
    result[outputContracts[0].artifactKey] = trimmed
  }
  return result
}

function buildTypedResultMetrics(input: {
  text: string
  artifacts: TypedResultArtifactRef[]
  inputArtifactsCount: number
  outputContractsCount: number
  requiredArtifactKeys: string[]
}): Record<string, unknown> {
  return {
    textChars: input.text.length,
    textLines: input.text ? input.text.split('\n').length : 0,
    artifactCount: input.artifacts.length,
    inputArtifactsCount: input.inputArtifactsCount,
    outputContractsCount: input.outputContractsCount,
    requiredArtifactKeys: input.requiredArtifactKeys,
  }
}

async function refreshStageAndProductionStatus(productionId: string): Promise<void> {
  const [production, stages, tasks, reviewJobs] = await Promise.all([
    productionService.getProduction(productionId),
    productionRepo.listStages(productionId),
    productionRepo.listTasks(productionId),
    productionRepo.listReviewJobs(productionId),
  ])

  let currentStageId: string | undefined = production.currentStageId

  for (const stage of stages) {
    const stageTasks = tasks.filter((task) => task.stageId === stage.id)
    const stageReviewJobs = reviewJobs.filter((job) => stageTasks.some((task) => task.id === job.taskId))
    const allDone = stageTasks.length > 0 && stageTasks.every((task) => task.status === 'done')
    const hasFailure = stageTasks.some((task) => task.status === 'failed')
    const hasPendingReviews = stageReviewJobs.some((job) => job.status !== 'completed')

    let nextStatus: ProductionStage['status'] = stage.status
    if (hasFailure) nextStatus = 'failed'
    else if (allDone && !hasPendingReviews) nextStatus = 'completed'
    else if (stage.id === production.currentStageId && production.status === 'active') nextStatus = 'active'
    else if (stage.status === 'completed') nextStatus = 'completed'
    else nextStatus = 'pending'

    if (nextStatus !== stage.status) {
      await productionRepo.appendEvent({
        productionId,
        stageId: stage.id,
        eventType: 'stage.status_changed',
        payload: { from: stage.status, to: nextStatus },
      })
      await productionRepo.updateStageStatus(stage.id, nextStatus)
    }
  }

  const updatedStages = await productionRepo.listStages(productionId)
  const activeStage = updatedStages.find((stage) => stage.status === 'active')
  if (!activeStage) {
    const nextPending = updatedStages.find((stage) => stage.status === 'pending')
    if (nextPending && production.status === 'active') {
      await productionRepo.updateStageStatus(nextPending.id, 'active')
      currentStageId = nextPending.id
    }
  } else {
    currentStageId = activeStage.id
  }

  const finalTasks = await productionRepo.listTasks(productionId)
  if (finalTasks.length > 0 && finalTasks.every((task) => task.status === 'done')) {
    await productionRepo.updateState(productionId, {
      status: 'completed',
      currentStageId,
      completedAt: new Date().toISOString(),
    })
    await productionRepo.appendEvent({
      productionId,
      eventType: 'production.completed',
      payload: {},
    })
    return
  }

  await productionRepo.updateState(productionId, { currentStageId })
}

export async function dispatchNextTask(productionId: string, workerId = 'aps-engine'): Promise<{ taskId: string } | null> {
  const claim = await productionRepo.claimNextRunnableTask(productionId, workerId)
  if (!claim) return null

  const production = await productionService.getProduction(productionId)
  const task = claim.task
  const attempt = claim.attempt
  const stages = await productionRepo.listStages(productionId)
  const artifacts = await productionRepo.listArtifacts(productionId)
  const stage = stages.find((item) => item.id === task.stageId)
  const inputArtifacts = task.inputArtifactRefs
    .map((ref) => {
      if (ref.artifactVersionId) return artifacts.find((artifact) => artifact.id === ref.artifactVersionId)
      if (ref.artifactKey) {
        const matching = artifacts
          .filter((artifact) => artifact.artifactKey === ref.artifactKey)
          .sort((a, b) => b.version - a.version)
        return matching[0]
      }
      return undefined
    })
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
  const executionPolicy = task.executionPolicy as { agentId?: string; sessionTitle?: string }
  const defaultAgentId = (production.config as { defaultAgentId?: string }).defaultAgentId
  const agentId = executionPolicy.agentId || defaultAgentId
  if (!agentId) {
    await productionRepo.completeAttempt({
      taskAttemptId: attempt.id,
      success: false,
      failureKind: 'missing_agent_id',
      failureDetail: { taskId: task.id },
    })
    throw new Error(`Task ${task.id} 缺少 agentId`)
  }

  const agent = await agentService.getAgent(agentId)
  const session = await sessionService.createSession(APS_USER_ID, {
    agentId,
    title: executionPolicy.sessionTitle || `${production.name} / ${task.title || task.key}`,
    metadata: {
      productionId,
      taskId: task.id,
      taskAttemptId: attempt.id,
      aps: true,
    },
  })

  await productionRepo.updateAttemptHeartbeat(attempt.id)
  await productionRepo.appendEvent({
    productionId,
    stageId: task.stageId,
    taskId: task.id,
    taskAttemptId: attempt.id,
    eventType: 'attempt.started',
    payload: { sessionId: session.id, agentId },
  })

  const taskEnvelope = buildTaskEnvelope({
    production,
    stage,
    task,
    attemptNo: attempt.attemptNo,
    inputArtifacts,
  })

  try {
    await productionRepo.startAttempt(attempt.id, taskEnvelope as unknown as Record<string, unknown>)
    let output: { text: string; usage: Record<string, unknown> } = { text: '', usage: {} }
    let outputResult: TypedResult | null = null
    let finalCreatedArtifacts: NonNullable<Awaited<ReturnType<typeof productionRepo.registerArtifact>>>[] = []
    let repairReason: string | undefined
    const repairEvents: Array<Record<string, unknown>> = []

    for (let repairAttempt = 1; repairAttempt <= MAX_TYPED_RESULT_REPAIR_ATTEMPTS; repairAttempt += 1) {
      const runtimeResult = await sendMessageToRuntime(session.id, buildTaskPrompt(taskEnvelope, repairReason), agent)
      const sessionStatus = await waitForSessionCompletion(session.id)
      output = await collectAssistantOutput(session.id, runtimeResult.finalResponse, runtimeResult.usage)

      if (sessionStatus !== 'completed') {
        await productionRepo.completeAttempt({
          taskAttemptId: attempt.id,
          success: false,
          failureKind: 'session_failed',
          failureDetail: { sessionId: session.id },
        })
        throw new Error(`APS task ${task.id} 执行失败`)
      }

      const createdArtifacts: NonNullable<Awaited<ReturnType<typeof productionRepo.registerArtifact>>>[] = []
      const artifactContents = splitArtifactContent(output.text, task.outputContract)
      for (const contract of task.outputContract) {
        const artifactContent = artifactContents[contract.artifactKey] || output.text
        if (!artifactContent.trim()) continue
        const artifact = await productionRepo.registerArtifact({
          productionId,
          artifactKey: contract.artifactKey,
          artifactType: contract.artifactType,
          schemaVersion: contract.schemaVersion,
          content: artifactContent,
          summary: artifactContent.slice(0, 300),
          metadata: {
            taskId: task.id,
            taskAttemptId: attempt.id,
            sessionId: session.id,
            repairAttempt,
          },
          createdByTaskId: task.id,
          createdByAttemptId: attempt.id,
        })
        if (artifact) createdArtifacts.push(artifact)
      }
      finalCreatedArtifacts = createdArtifacts

      outputResult = {
        schemaVersion: '1.0',
        status: 'completed',
        text: output.text,
        artifacts: createdArtifacts.map((artifact) => ({
          artifactKey: artifact.artifactKey,
          artifactType: artifact.artifactType,
          artifactVersionId: artifact.id,
          storageUri: artifact.storageUri,
          summary: artifact.summary,
        })),
        usage: output.usage,
        metrics: buildTypedResultMetrics({
          text: output.text,
          artifacts: createdArtifacts.map((artifact) => ({
            artifactKey: artifact.artifactKey,
            artifactType: artifact.artifactType,
            artifactVersionId: artifact.id,
            storageUri: artifact.storageUri,
            summary: artifact.summary,
          })),
          inputArtifactsCount: inputArtifacts.length,
          outputContractsCount: task.outputContract.length,
          requiredArtifactKeys: task.outputContract.filter((contract) => contract.required !== false).map((contract) => contract.artifactKey),
        }),
      }

      const validation = validateTypedResult({
        result: outputResult,
        outputContracts: task.outputContract,
      })
      if (validation.ok) {
        outputResult = validation.result
        break
      }

      const repairEventPayload = {
        reason: validation.reason,
        failureKind: validation.failure.kind,
        repairAttempt,
      }
      await productionRepo.appendEvent({
        productionId,
        stageId: task.stageId,
        taskId: task.id,
        taskAttemptId: attempt.id,
        eventType: 'attempt.repair_requested',
        payload: repairEventPayload,
      })
      repairEvents.push({
        eventType: 'attempt.repair_requested',
        payload: repairEventPayload,
        createdAt: new Date().toISOString(),
      })

      outputResult = {
        ...outputResult,
        status: 'failed',
        failure: validation.failure,
      }

      if (repairAttempt >= MAX_TYPED_RESULT_REPAIR_ATTEMPTS) {
        await productionRepo.completeAttempt({
          taskAttemptId: attempt.id,
          success: false,
        outputResult: {
          sessionId: session.id,
          typedResult: outputResult,
          events: repairEvents,
        },
        usage: output.usage,
          failureKind: validation.failure.kind,
          failureDetail: validation.failure.detail,
        })
        const error = new Error(`APS task ${task.id} typed result invalid: ${validation.reason}`)
        ;(error as Error & { [APS_ATTEMPT_ALREADY_COMPLETED]?: boolean })[APS_ATTEMPT_ALREADY_COMPLETED] = true
        throw error
      }

      repairReason = buildTypedResultRepairReason({
        reason: validation.reason,
        outputContracts: task.outputContract,
        failure: validation.failure,
      })
    }

    await productionRepo.completeAttempt({
      taskAttemptId: attempt.id,
      success: true,
      outputResult: {
        sessionId: session.id,
        typedResult: outputResult!,
        events: repairEvents,
      },
      usage: outputResult?.usage || output.usage,
    })

    const reviewJobs = await productionRepo.createReviewJobsForTask(task, attempt.id, finalCreatedArtifacts)
    await productionReviewerService.processAutoReviewJobs(reviewJobs)
    await refreshStageAndProductionStatus(productionId)
    return { taskId: task.id }
  } catch (error) {
    logger.error('APS task 执行失败', error as Error, {
      productionId,
      taskId: task.id,
      taskAttemptId: attempt.id,
    })
    if (!(error as Record<string, unknown> | null)?.[APS_ATTEMPT_ALREADY_COMPLETED]) {
      await productionRepo.completeAttempt({
        taskAttemptId: attempt.id,
        success: false,
        failureKind: error instanceof Error ? error.name || 'dispatch_failed' : 'dispatch_failed',
        failureDetail: { message: error instanceof Error ? error.message : String(error), sessionId: session.id },
      })
    }
    await refreshStageAndProductionStatus(productionId)
    throw error
  }
}

export async function runProduction(productionId: string): Promise<void> {
  const production = await productionService.getProduction(productionId)
  if (production.status !== 'active') {
    await productionService.activateProduction(productionId)
  }

  const deadline = Date.now() + RUN_PRODUCTION_DEADLINE_MS
  await productionRepo.sweepExpiredAttempts()
  for (let iteration = 0; iteration < MAX_RUN_PRODUCTION_ITERATIONS; iteration += 1) {
    const next = await dispatchNextTask(productionId)
    if (!next) break
    const updated = await productionService.getProduction(productionId)
    if (updated.status !== 'active') break
    if (Date.now() >= deadline) {
      await productionRepo.appendEvent({
        productionId,
        eventType: 'production.run_stopped',
        payload: { reason: 'deadline_exceeded', iteration: iteration + 1 },
      })
      break
    }
  }
}

export async function runProductionGuarded(productionId: string): Promise<boolean> {
  if (runningProductionIds.has(productionId)) {
    return false
  }
  runningProductionIds.add(productionId)
  try {
    await runProduction(productionId)
    return true
  } finally {
    runningProductionIds.delete(productionId)
  }
}
