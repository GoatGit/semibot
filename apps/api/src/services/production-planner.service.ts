import { createLogger } from '../lib/logger'
import * as agentService from './agent.service'
import * as sessionService from './session.service'
import {
  consumeRuntimeSse,
  extractJsonObject,
  getRuntimeBaseUrl,
} from './production-runtime-client'
import { buildDefaultPlan } from './production-default-plan'
import type {
  CreateProductionInput,
  PlannerOutput,
  PlannerPlanMode,
  PlannerValidationFailure,
  ProductionPlan,
  ReplanProductionInput,
} from '@semibot/shared-types'

const logger = createLogger('production-planner-service')

const APS_PLANNER_USER_ID = 'aps-planner'
const POLL_INTERVAL_MS = 1500
const MAX_WAIT_MS = 2 * 60 * 1000
const MAX_RUNTIME_PLAN_ATTEMPTS = 2

export interface PlannerBuildResult {
  plan: ProductionPlan
  plannerMetadata: Record<string, unknown>
}

function wrapPlannerOutput(plan: ProductionPlan, planMode: PlannerPlanMode, rationale?: string): PlannerOutput {
  return {
    schemaVersion: '1.0',
    planMode,
    rationale: rationale || plan.rationale,
    plan,
  }
}

function resolvePlannerMode(config?: Record<string, unknown>): 'runtime' | 'default' {
  const explicit = String(config?.plannerMode || process.env.SEMIBOT_APS_PLANNER_MODE || '').trim().toLowerCase()
  return explicit === 'runtime' ? 'runtime' : 'default'
}

function buildPlannerFailure(code: PlannerValidationFailure['code'], message: string): PlannerValidationFailure {
  return { code, message }
}

function isValidPlan(value: unknown): value is ProductionPlan {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return typeof data.schemaVersion === 'string' && Array.isArray(data.stages) && data.stages.length > 0
}

function isPlannerOutput(value: unknown): value is PlannerOutput {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return typeof data.schemaVersion === 'string' && typeof data.planMode === 'string' && isValidPlan(data.plan)
}

function extractPlannerOutputCandidate(parsed: unknown, planMode: PlannerPlanMode): {
  output: PlannerOutput | null
  failure?: PlannerValidationFailure
} {
  if (isPlannerOutput(parsed)) {
    return { output: parsed }
  }
  if (isValidPlan(parsed)) {
    return { output: wrapPlannerOutput(parsed, planMode) }
  }
  return {
    output: null,
    failure: buildPlannerFailure('invalid_envelope', 'planner output did not satisfy PlannerOutput or ProductionPlan schema'),
  }
}

function normalizePlan(plan: ProductionPlan): { plan: ProductionPlan | null; failure?: PlannerValidationFailure } {
  const seenStageKeys = new Set<string>()
  const seenTaskKeys = new Set<string>()
  const normalizedStages: ProductionPlan['stages'] = []

  for (const stage of [...plan.stages].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))) {
    if (!stage || typeof stage.key !== 'string' || typeof stage.title !== 'string') {
      return { plan: null, failure: buildPlannerFailure('invalid_plan_shape', 'stage key/title is missing') }
    }
    const stageKey = String(stage.key || '').trim()
    if (!stageKey) {
      return { plan: null, failure: buildPlannerFailure('invalid_plan_shape', 'stage key is missing') }
    }
    if (seenStageKeys.has(stageKey)) {
      return { plan: null, failure: buildPlannerFailure('duplicate_stage_key', `duplicate stage key: ${stageKey}`) }
    }
    seenStageKeys.add(stageKey)

    const normalizedTasks: NonNullable<typeof stage.tasks> = []
    for (const task of Array.isArray(stage.tasks) ? stage.tasks : []) {
      const taskKey = String(task?.key || '').trim()
      const role = String(task?.role || '').trim()
      const goal = String(task?.goal || '').trim()
      if (!taskKey || !role || !goal) {
        return { plan: null, failure: buildPlannerFailure('missing_task_fields', `task in stage ${stageKey} is missing key/role/goal`) }
      }
      if (seenTaskKeys.has(taskKey)) {
        return { plan: null, failure: buildPlannerFailure('duplicate_task_key', `duplicate task key: ${taskKey}`) }
      }
      seenTaskKeys.add(taskKey)

      normalizedTasks.push({
        ...task,
        key: taskKey,
        role,
        goal,
        dependsOnTaskKeys: Array.isArray(task.dependsOnTaskKeys) ? task.dependsOnTaskKeys.map((item) => String(item)) : [],
        outputContract: Array.isArray(task.outputContract)
          ? task.outputContract.filter((item) => item && item.artifactKey && item.artifactType && item.schemaVersion)
          : [],
      })
    }

    if (normalizedTasks.length === 0) {
      return { plan: null, failure: buildPlannerFailure('empty_stage', `stage ${stageKey} has no valid tasks`) }
    }

    normalizedStages.push({
      ...stage,
      key: stageKey,
      title: String(stage.title).trim(),
      sequence: normalizedStages.length + 1,
      tasks: normalizedTasks,
    })
  }

  if (normalizedStages.length === 0) {
    return { plan: null, failure: buildPlannerFailure('invalid_plan_shape', 'plan must contain at least one valid stage') }
  }

  return {
    plan: {
      schemaVersion: String(plan.schemaVersion || '1'),
      rationale: typeof plan.rationale === 'string' ? plan.rationale : undefined,
      stages: normalizedStages,
    },
  }
}

function validateNormalizedPlan(plan: ProductionPlan | null, inheritedFailure?: PlannerValidationFailure): {
  plan: ProductionPlan | null
  failure?: PlannerValidationFailure
} {
  if (!plan) return { plan: null, failure: inheritedFailure || buildPlannerFailure('invalid_plan_shape', 'planner returned null plan after normalization') }
  if (!Array.isArray(plan.stages) || plan.stages.length === 0) {
    return { plan: null, failure: buildPlannerFailure('invalid_plan_shape', 'plan must contain at least one stage') }
  }
  for (const stage of plan.stages) {
    if (!Array.isArray(stage.tasks) || stage.tasks.length === 0) {
      return { plan: null, failure: buildPlannerFailure('empty_stage', `stage ${stage.key} has no tasks`) }
    }
    for (const task of stage.tasks) {
      if (!task.kind || !['generation', 'revision', 'review', 'analysis', 'aggregation'].includes(String(task.kind))) {
        return { plan: null, failure: buildPlannerFailure('invalid_task_kind', `task ${task.key} has invalid kind`) }
      }
    }
  }
  return { plan }
}

async function sendPlannerPromptToRuntime(sessionId: string, message: string, agentId: string): Promise<void> {
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
      system_prompt:
        agent.systemPrompt ||
        'You are an APS planner. Return only valid JSON matching the PlannerOutput schema.',
      skill_index: [],
      stream: true,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`planner runtime call failed: ${response.status} ${body.slice(0, 200)}`)
  }
  await consumeRuntimeSse(response)
}

async function waitForPlannerSessionCompletion(sessionId: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const session = await sessionService.getSession(sessionId).catch(() => null)
    if (session?.status === 'completed' || session?.status === 'failed') return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`planner session ${sessionId} timed out`)
}

async function collectPlannerOutput(sessionId: string): Promise<string> {
  const messages = await sessionService.getSessionMessages(sessionId)
  return messages
    .filter((msg) => msg.role === 'assistant')
    .map((msg) => msg.content)
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function buildPlannerPrompt(input: {
  productionName?: string
  goal: string
  planMode: PlannerPlanMode
  constraints?: Record<string, unknown>
  existingPlan?: ProductionPlan
  repairReason?: string
}): string {
  return [
    'Return exactly one JSON object with this shape: { "schemaVersion": "1.0", "planMode": "initial|incremental_replan|full_replan", "rationale": string, "plan": { "schemaVersion": "1", "rationale": string, "stages": [...] } }.',
    'Each stage must contain key, title, sequence, tasks[].',
    'Each task must contain key, role, kind, goal.',
    'Allowed task kinds: generation, revision, review, analysis, aggregation.',
    'Stage keys and task keys must be unique.',
    'Every stage must contain at least one task.',
    'Do not add markdown fences or explanations.',
    input.productionName ? `Production Name: ${input.productionName}` : '',
    `Plan Mode: ${input.planMode}`,
    `Goal: ${input.goal}`,
    input.constraints ? `Constraints JSON: ${JSON.stringify(input.constraints)}` : '',
    input.existingPlan ? `Existing Plan JSON: ${JSON.stringify(input.existingPlan)}` : '',
    input.repairReason ? `Repair previous invalid output because: ${input.repairReason}` : '',
  ].filter(Boolean).join('\n')
}

async function buildRuntimePlan(input: {
  goal: string
  planMode: PlannerPlanMode
  constraints?: Record<string, unknown>
  config?: Record<string, unknown>
  existingPlan?: ProductionPlan
}): Promise<ProductionPlan | null> {
  const plannerAgentId = typeof input.config?.plannerAgentId === 'string' ? input.config.plannerAgentId : undefined
  const defaultAgentId = typeof input.config?.defaultAgentId === 'string' ? input.config.defaultAgentId : undefined
  const agentId = plannerAgentId || defaultAgentId
  if (!agentId) return null

  let repairReason: string | undefined
  for (let attempt = 1; attempt <= MAX_RUNTIME_PLAN_ATTEMPTS; attempt += 1) {
    const session = await sessionService.createSession(APS_PLANNER_USER_ID, {
      agentId,
      title: `APS Planner / ${input.goal.slice(0, 60)}`,
      metadata: {
        apsPlanner: true,
        plannerAttempt: attempt,
        planMode: input.planMode,
      },
    })
    await sendPlannerPromptToRuntime(
      session.id,
      buildPlannerPrompt({
        goal: input.goal,
        planMode: input.planMode,
        constraints: input.constraints,
        existingPlan: input.existingPlan,
        repairReason,
      }),
      agentId,
    )
    await waitForPlannerSessionCompletion(session.id)
    const raw = await collectPlannerOutput(session.id)
    const json = extractJsonObject(raw)
    if (!json) {
      repairReason = '[missing_json] planner did not return a JSON object'
      continue
    }
    try {
      const parsed = JSON.parse(json) as unknown
      const candidate = extractPlannerOutputCandidate(parsed, input.planMode)
      if (!candidate.output) {
        repairReason = `[${candidate.failure?.code || 'invalid_envelope'}] ${candidate.failure?.message || 'invalid planner envelope'}`
        continue
      }
      const normalized = normalizePlan(candidate.output.plan)
      const validation = validateNormalizedPlan(normalized.plan, normalized.failure)
      if (validation.plan) return validation.plan
      repairReason = `[${validation.failure?.code || 'invalid_plan_shape'}] ${validation.failure?.message || 'normalized plan failed validation'}`
    } catch {
      repairReason = '[invalid_json] planner returned invalid JSON'
    }
  }
  logger.warn('APS runtime planner exhausted repair loop', {
    goalLength: input.goal.length,
    repairReason,
    planMode: input.planMode,
  })
  return null
}

export async function buildInitialPlanResult(input: CreateProductionInput): Promise<PlannerBuildResult> {
  if (input.plan) {
    return {
      plan: input.plan,
      plannerMetadata: {
        plannerType: 'manual',
        plannerOutputSchemaVersion: '1.0',
        planMode: 'initial',
      },
    }
  }

  if (resolvePlannerMode(input.config) === 'runtime') {
    try {
      const runtimePlan = await buildRuntimePlan({
        goal: input.goal,
        planMode: 'initial',
        constraints: input.constraints,
        config: input.config,
      })
      if (runtimePlan) {
        logger.info('APS planner 使用 runtime plan', { stageCount: runtimePlan.stages.length })
        return {
          plan: runtimePlan,
          plannerMetadata: {
            plannerType: 'runtime',
            plannerOutputSchemaVersion: '1.0',
            planMode: 'initial',
            usedRepairLoop: true,
          },
        }
      }
    } catch (error) {
      logger.warn('APS runtime planner failed; fallback to default', { error })
    }
  }

  const plan = buildDefaultPlan(
    input.goal,
    input.config?.defaultAgentId,
    (input.constraints?.budget as Record<string, unknown> | undefined) || {},
    'Default single-stage production plan',
  )
  logger.info('APS planner 使用默认初始 plan', { stageCount: plan.stages.length, goalLength: input.goal.length })
  return {
    plan,
    plannerMetadata: {
      plannerType: 'default',
      plannerOutputSchemaVersion: '1.0',
      planMode: 'initial',
      fallbackReason: 'default_initial_plan',
    },
  }
}

export async function buildInitialPlan(input: CreateProductionInput): Promise<ProductionPlan> {
  return (await buildInitialPlanResult(input)).plan
}

export async function buildReplanResult(
  existing: { name: string; goal: string; constraints?: Record<string, unknown>; config?: Record<string, unknown>; currentPlan?: ProductionPlan },
  input: ReplanProductionInput
): Promise<PlannerBuildResult> {
  if (input.plan) {
    return {
      plan: input.plan,
      plannerMetadata: {
        plannerType: 'manual',
        plannerOutputSchemaVersion: '1.0',
        planMode: 'manual_replan',
      },
    }
  }

  const nextGoal = input.goal ?? existing.goal
  const nextConfig = { ...(existing.config || {}), ...(input.config || {}) }
  const planMode: PlannerPlanMode = input.goal && input.goal !== existing.goal ? 'full_replan' : 'incremental_replan'

  if (resolvePlannerMode(nextConfig) === 'runtime') {
    try {
      const runtimePlan = await buildRuntimePlan({
        goal: nextGoal,
        planMode,
        constraints: (input.constraints as Record<string, unknown> | undefined) || existing.constraints,
        config: nextConfig,
        existingPlan: existing.currentPlan,
      })
      if (runtimePlan) {
        logger.info('APS planner 使用 runtime replan', { stageCount: runtimePlan.stages.length, planMode })
        return {
          plan: runtimePlan,
          plannerMetadata: {
            plannerType: 'runtime',
            plannerOutputSchemaVersion: '1.0',
            planMode,
            usedRepairLoop: true,
          },
        }
      }
    } catch (error) {
      logger.warn('APS runtime replan failed; fallback to default', { error })
    }
  }

  const defaultAgentId = typeof nextConfig.defaultAgentId === 'string' ? nextConfig.defaultAgentId : undefined
  const plan = buildDefaultPlan(
    nextGoal,
    defaultAgentId,
    (input.constraints?.budget as Record<string, unknown> | undefined)
      || (existing.constraints?.budget as Record<string, unknown> | undefined)
      || {},
    'Fallback replan generated by APS default planner',
  )
  logger.info('APS planner 使用默认 replan', { goalLength: nextGoal.length, stageCount: plan.stages.length, planMode })
  return {
    plan,
    plannerMetadata: {
      plannerType: 'default',
      plannerOutputSchemaVersion: '1.0',
      planMode,
      fallbackReason: 'default_replan',
    },
  }
}

export async function buildReplan(
  existing: { name: string; goal: string; constraints?: Record<string, unknown>; config?: Record<string, unknown>; currentPlan?: ProductionPlan },
  input: ReplanProductionInput
): Promise<ProductionPlan> {
  return (await buildReplanResult(existing, input)).plan
}
