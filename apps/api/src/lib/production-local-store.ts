/**
 * APS SQLite 存储
 */

import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { getLocalDb } from './db-local'
import { createLogger } from './logger'
import { defaultPlanForInput } from '../services/production-default-plan'
import type {
  ArtifactVersion,
  CreateProductionInput,
  Escalation,
  HumanDecision,
  Production,
  ProductionEvent,
  ProductionPlan,
  ProductionStage,
  ProductionStatus,
  ProductionTask,
  ReviewDecision,
  ReviewJob,
  ReplanProductionInput,
  ReviewPolicy,
  TaskAttempt,
} from '@semibot/shared-types'

const logger = createLogger('production-local-store')

const DEFAULT_ORG_ID = process.env.SEMIBOT_SINGLE_ORG_ID || '11111111-1111-1111-1111-111111111111'

function resolveArtifactsRoot(): string {
  const explicitRoot = String(process.env.SEMIBOT_ARTIFACTS_ROOT || '').trim()
  if (explicitRoot) return explicitRoot
  const semibotHome = String(process.env.SEMIBOT_HOME || '').trim()
  if (semibotHome) return path.join(semibotHome, 'artifacts')
  return path.join(os.homedir(), '.semibot', 'artifacts')
}

type DbRow = Record<string, unknown>

export interface LocalProductionRow extends Production {}
export interface LocalProductionPlanRow {
  id: string
  production_id: string
  plan_version: number
  schema_version: string
  planner_type: string
  rationale: string | null
  metadata: Record<string, unknown>
  graph: ProductionPlan
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToProduction(row: DbRow): LocalProductionRow {
  return {
    id: String(row.production_id),
    orgId: String(row.org_id),
    name: String(row.name),
    goal: String(row.goal),
    constraints: parseJson(row.constraints_json, {}),
    config: parseJson(row.config_json, {}),
    status: row.status as ProductionStatus,
    currentPlanId: (row.current_plan_id as string) || undefined,
    currentStageId: (row.current_stage_id as string) || undefined,
    isPaused: Number(row.is_paused || 0) === 1,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string) || undefined,
  }
}

function rowToPlan(row: DbRow): LocalProductionPlanRow {
  return {
    id: String(row.plan_id),
    production_id: String(row.production_id),
    plan_version: Number(row.plan_version),
    schema_version: String(row.schema_version),
    planner_type: String(row.planner_type),
    rationale: (row.rationale as string) ?? null,
    metadata: parseJson(row.metadata_json, {}),
    graph: parseJson<ProductionPlan>(row.graph_json, { schemaVersion: '1', stages: [] }),
    created_at: String(row.created_at),
  }
}

function rowToStage(row: DbRow): ProductionStage {
  return {
    id: String(row.stage_id),
    productionId: String(row.production_id),
    planId: String(row.plan_id),
    key: String(row.stage_key),
    title: String(row.title),
    description: (row.description as string) || undefined,
    sequence: Number(row.sequence),
    status: row.status as ProductionStage['status'],
    exitCriteria: (row.exit_criteria as string) || undefined,
    reviewGateConfig: parseJson(row.review_gate_config_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string) || undefined,
  }
}

function rowToTask(row: DbRow): ProductionTask {
  return {
    id: String(row.task_id),
    productionId: String(row.production_id),
    planId: String(row.plan_id),
    stageId: String(row.stage_id),
    key: String(row.task_key),
    title: (row.title as string) || undefined,
    role: String(row.role),
    kind: row.kind as ProductionTask['kind'],
    status: row.status as ProductionTask['status'],
    priority: Number(row.priority),
    goal: String(row.goal),
    dependsOnTaskIds: parseJson(row.depends_on_task_ids_json, []),
    inputArtifactRefs: parseJson(row.input_artifact_refs_json, []),
    outputContract: parseJson(row.output_contract_json, []),
    reviewPolicy: parseJson(row.review_policy_json, {}),
    executionPolicy: parseJson(row.execution_policy_json, {}),
    budgetPolicy: parseJson(row.budget_policy_json, {}),
    currentAttemptId: (row.current_attempt_id as string) || undefined,
    leaseExpiresAt: (row.lease_expires_at as string) || undefined,
    leasedBy: (row.leased_by as string) || undefined,
    failureReason: (row.failure_reason as string) || undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string) || undefined,
  }
}

function rowToAttempt(row: DbRow): TaskAttempt {
  return {
    id: String(row.task_attempt_id),
    taskId: String(row.task_id),
    attemptNo: Number(row.attempt_no),
    workerId: (row.worker_id as string) || undefined,
    status: row.status as TaskAttempt['status'],
    inputEnvelope: parseJson(row.input_envelope_json, {}),
    outputResult: row.output_result_json ? parseJson(row.output_result_json, {}) : undefined,
    leaseExpiresAt: (row.lease_expires_at as string) || undefined,
    heartbeatAt: (row.heartbeat_at as string) || undefined,
    checkpointRef: (row.checkpoint_ref as string) || undefined,
    failureKind: (row.failure_kind as string) || undefined,
    failureDetail: parseJson(row.failure_detail_json, {}),
    usage: parseJson(row.usage_json, {}),
    startedAt: String(row.started_at),
    endedAt: (row.ended_at as string) || undefined,
  }
}

function rowToArtifact(row: DbRow): ArtifactVersion {
  return {
    id: String(row.artifact_version_id),
    productionId: String(row.production_id),
    artifactKey: String(row.artifact_key),
    version: Number(row.version),
    artifactType: String(row.artifact_type),
    schemaVersion: String(row.schema_version),
    reviewState: row.review_state as ArtifactVersion['reviewState'],
    storageUri: String(row.storage_uri),
    summary: (row.summary as string) || undefined,
    metadata: parseJson(row.metadata_json, {}),
    lineageRefs: parseJson(row.lineage_refs_json, []),
    createdByTaskId: (row.created_by_task_id as string) || undefined,
    createdByAttemptId: (row.created_by_attempt_id as string) || undefined,
    createdAt: String(row.created_at),
  }
}

function rowToReviewJob(row: DbRow): ReviewJob {
  return {
    id: String(row.review_job_id),
    productionId: String(row.production_id),
    taskId: String(row.task_id),
    taskAttemptId: String(row.task_attempt_id),
    artifactVersionId: String(row.artifact_version_id),
    reviewerRole: String(row.reviewer_role),
    reviewerType: row.reviewer_type as ReviewJob['reviewerType'],
    status: row.status as ReviewJob['status'],
    retryCount: Number(row.retry_count),
    leaseExpiresAt: (row.lease_expires_at as string) || undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string) || undefined,
  }
}

function rowToReviewDecision(row: DbRow): ReviewDecision {
  const revisionRequest = parseJson<{ mustFix?: string[]; shouldFix?: string[] }>(row.revision_request_json, {})
  return {
    id: String(row.review_decision_id),
    reviewJobId: String(row.review_job_id),
    productionId: String(row.production_id),
    taskId: String(row.task_id),
    taskAttemptId: String(row.task_attempt_id),
    reviewerRole: String(row.reviewer_role),
    reviewerType: row.reviewer_type as ReviewDecision['reviewerType'],
    decision: row.decision as ReviewDecision['decision'],
    score: row.score !== null && row.score !== undefined ? Number(row.score) : undefined,
    findings: parseJson(row.findings_json, []),
    revisionRequest: {
      mustFix: Array.isArray(revisionRequest.mustFix) ? revisionRequest.mustFix : [],
      shouldFix: Array.isArray(revisionRequest.shouldFix) ? revisionRequest.shouldFix : [],
    },
    createdAt: String(row.created_at),
  }
}

function rowToEvent(row: DbRow): ProductionEvent {
  return {
    id: String(row.production_event_id),
    productionId: String(row.production_id),
    stageId: (row.stage_id as string) || undefined,
    taskId: (row.task_id as string) || undefined,
    taskAttemptId: (row.task_attempt_id as string) || undefined,
    eventType: String(row.event_type),
    eventVersion: String(row.event_version || '1'),
    payload: parseJson(row.payload_json, {}),
    createdAt: String(row.created_at),
  }
}

function rowToEscalation(row: DbRow): Escalation {
  return {
    id: String(row.escalation_id),
    productionId: String(row.production_id),
    stageId: (row.stage_id as string) || undefined,
    taskId: (row.task_id as string) || undefined,
    taskAttemptId: (row.task_attempt_id as string) || undefined,
    artifactVersionId: (row.artifact_version_id as string) || undefined,
    sourceType: String(row.source_type),
    reasonCode: String(row.reason_code),
    payload: parseJson(row.payload_json, {}),
    status: row.status as Escalation['status'],
    createdAt: String(row.created_at),
    resolvedAt: (row.resolved_at as string) || undefined,
  }
}

function rowToHumanDecision(row: DbRow): HumanDecision {
  return {
    id: String(row.human_decision_id),
    escalationId: String(row.escalation_id),
    productionId: String(row.production_id),
    decisionType: String(row.decision_type),
    payload: parseJson(row.payload_json, {}),
    decidedBy: (row.decided_by as string) || undefined,
    createdAt: String(row.created_at),
  }
}

export function localCreateProduction(input: CreateProductionInput & { plannerMetadata?: Record<string, unknown> }, createdBy: string): {
  production: LocalProductionRow
  plan: LocalProductionPlanRow
  stages: ProductionStage[]
  tasks: ProductionTask[]
} {
  const db = getLocalDb()
  const productionId = randomUUID()
  const planId = randomUUID()
  const now = nowIso()
  const plan = input.plan ?? defaultPlanForInput(input)
  const productionStatus: ProductionStatus = input.config?.autoStart ? 'active' : 'planned'

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO productions (
        production_id, org_id, name, goal, constraints_json, config_json, status,
        current_plan_id, current_stage_id, is_paused, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)
    `).run(
      productionId,
      DEFAULT_ORG_ID,
      input.name,
      input.goal,
      JSON.stringify(input.constraints ?? {}),
      JSON.stringify(input.config ?? {}),
      productionStatus,
      planId,
      createdBy,
      now,
      now,
    )

    db.prepare(`
      INSERT INTO production_plans (
        plan_id, production_id, plan_version, schema_version, planner_type, rationale, metadata_json, graph_json, created_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      productionId,
      plan.schemaVersion || '1',
      String(input.plannerMetadata?.plannerType || 'default'),
      plan.rationale ?? null,
      JSON.stringify(input.plannerMetadata ?? {}),
      JSON.stringify(plan),
      now,
    )

    const taskIdByKey = new Map<string, string>()
    const stageIdByKey = new Map<string, string>()

    for (const stageDef of plan.stages) {
      const stageId = randomUUID()
      stageIdByKey.set(stageDef.key, stageId)
      db.prepare(`
        INSERT INTO production_stages (
          stage_id, production_id, plan_id, stage_key, title, description, sequence,
          status, exit_criteria, review_gate_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stageId,
        productionId,
        planId,
        stageDef.key,
        stageDef.title,
        stageDef.description ?? null,
        stageDef.sequence,
        stageDef.sequence === 1 && productionStatus === 'active' ? 'active' : 'pending',
        stageDef.exitCriteria ?? null,
        JSON.stringify(stageDef.reviewGateConfig ?? {}),
        now,
        now,
      )

      for (const taskDef of stageDef.tasks) {
        taskIdByKey.set(taskDef.key, randomUUID())
      }
    }

    let currentStageId: string | null = null

    for (const stageDef of plan.stages) {
      const stageId = stageIdByKey.get(stageDef.key)!
      if (!currentStageId && stageDef.sequence === 1) currentStageId = stageId

      for (const taskDef of stageDef.tasks) {
        const taskId = taskIdByKey.get(taskDef.key)!
        const dependsOnTaskIds = (taskDef.dependsOnTaskKeys ?? []).map((key) => taskIdByKey.get(key)).filter(Boolean)
        db.prepare(`
          INSERT INTO production_tasks (
            task_id, production_id, plan_id, stage_id, task_key, title, role, kind, status,
            priority, goal, depends_on_task_ids_json, input_artifact_refs_json, output_contract_json,
            review_policy_json, execution_policy_json, budget_policy_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          productionId,
          planId,
          stageId,
          taskDef.key,
          taskDef.title ?? null,
          taskDef.role,
          taskDef.kind,
          taskDef.priority ?? 50,
          taskDef.goal,
          JSON.stringify(dependsOnTaskIds),
          JSON.stringify(taskDef.inputArtifactRefs ?? []),
          JSON.stringify(taskDef.outputContract ?? []),
          JSON.stringify(taskDef.reviewPolicy ?? {}),
          JSON.stringify(taskDef.executionPolicy ?? {}),
          JSON.stringify(taskDef.budgetPolicy ?? {}),
          now,
          now,
        )
      }
    }

    if (currentStageId) {
      db.prepare('UPDATE productions SET current_stage_id = ? WHERE production_id = ?').run(currentStageId, productionId)
    }

    db.prepare(`
      INSERT INTO production_events (
        production_event_id, production_id, event_type, payload_json, created_at
      ) VALUES (?, ?, 'production.created', ?, ?)
    `).run(randomUUID(), productionId, JSON.stringify({ name: input.name, status: productionStatus }), now)

    db.prepare(`
      INSERT INTO production_events (
        production_event_id, production_id, event_type, payload_json, created_at
      ) VALUES (?, ?, 'plan.created', ?, ?)
    `).run(randomUUID(), productionId, JSON.stringify({ planId, stageCount: plan.stages.length }), now)
  })

  tx()

  const production = localFindProductionById(productionId)!
  const storedPlan = localFindProductionPlanById(planId)!
  const stages = localListProductionStages(productionId)
  const tasks = localListProductionTasks(productionId)
  logger.info('APS production 已创建', { productionId, planId, stages: stages.length, tasks: tasks.length })
  return { production, plan: storedPlan, stages, tasks }
}

export function localReplanProduction(
  productionId: string,
  input: ReplanProductionInput & { plannerMetadata?: Record<string, unknown> }
): {
  production: LocalProductionRow
  plan: LocalProductionPlanRow
  stages: ProductionStage[]
  tasks: ProductionTask[]
} | null {
  const db = getLocalDb()
  const existing = localFindProductionById(productionId)
  if (!existing) return null

  const nextGoal = input.goal ?? existing.goal
  const nextConstraints = input.constraints ?? existing.constraints
  const nextConfig = input.config ?? existing.config
  const plan = input.plan ?? defaultPlanForInput({
    name: existing.name,
    goal: nextGoal,
    constraints: nextConstraints,
    config: nextConfig,
  })
  const planId = randomUUID()
  const now = nowIso()
  const planVersion = Number((db.prepare(`
    SELECT COALESCE(MAX(plan_version), 0) as version
    FROM production_plans
    WHERE production_id = ?
  `).get(productionId) as { version: number }).version || 0) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO production_plans (
        plan_id, production_id, plan_version, schema_version, planner_type, rationale, metadata_json, graph_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      productionId,
      planVersion,
      plan.schemaVersion || '1',
      String(input.plannerMetadata?.plannerType || 'replan'),
      plan.rationale ?? null,
      JSON.stringify(input.plannerMetadata ?? {}),
      JSON.stringify(plan),
      now,
    )

    db.prepare(`
      UPDATE production_tasks
      SET status = 'failed', failure_reason = 'superseded', updated_at = ?, completed_at = ?
      WHERE production_id = ? AND status = 'pending'
    `).run(now, now, productionId)

    const taskIdByKey = new Map<string, string>()
    const stageIdByKey = new Map<string, string>()

    for (const stageDef of plan.stages) {
      const stageId = randomUUID()
      stageIdByKey.set(stageDef.key, stageId)
      db.prepare(`
        INSERT INTO production_stages (
          stage_id, production_id, plan_id, stage_key, title, description, sequence,
          status, exit_criteria, review_gate_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stageId,
        productionId,
        planId,
        stageDef.key,
        stageDef.title,
        stageDef.description ?? null,
        stageDef.sequence,
        stageDef.sequence === 1 && existing.status === 'active' ? 'active' : 'pending',
        stageDef.exitCriteria ?? null,
        JSON.stringify(stageDef.reviewGateConfig ?? {}),
        now,
        now,
      )
      for (const taskDef of stageDef.tasks) {
        taskIdByKey.set(taskDef.key, randomUUID())
      }
    }

    let currentStageId: string | null = null

    for (const stageDef of plan.stages) {
      const stageId = stageIdByKey.get(stageDef.key)!
      if (!currentStageId && stageDef.sequence === 1) currentStageId = stageId

      for (const taskDef of stageDef.tasks) {
        const taskId = taskIdByKey.get(taskDef.key)!
        const dependsOnTaskIds = (taskDef.dependsOnTaskKeys ?? []).map((key) => taskIdByKey.get(key)).filter(Boolean)
        db.prepare(`
          INSERT INTO production_tasks (
            task_id, production_id, plan_id, stage_id, task_key, title, role, kind, status,
            priority, goal, depends_on_task_ids_json, input_artifact_refs_json, output_contract_json,
            review_policy_json, execution_policy_json, budget_policy_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          productionId,
          planId,
          stageId,
          taskDef.key,
          taskDef.title ?? null,
          taskDef.role,
          taskDef.kind,
          taskDef.priority ?? 50,
          taskDef.goal,
          JSON.stringify(dependsOnTaskIds),
          JSON.stringify(taskDef.inputArtifactRefs ?? []),
          JSON.stringify(taskDef.outputContract ?? []),
          JSON.stringify(taskDef.reviewPolicy ?? {}),
          JSON.stringify(taskDef.executionPolicy ?? {}),
          JSON.stringify(taskDef.budgetPolicy ?? {}),
          now,
          now,
        )
      }
    }

    db.prepare(`
      UPDATE productions
      SET goal = ?, constraints_json = ?, config_json = ?, current_plan_id = ?, current_stage_id = ?, updated_at = ?
      WHERE production_id = ?
    `).run(
      nextGoal,
      JSON.stringify(nextConstraints),
      JSON.stringify(nextConfig),
      planId,
      currentStageId,
      now,
      productionId,
    )
  })

  tx()

  localAppendProductionEvent({
    productionId,
    eventType: 'production.replanned',
    payload: {
      planId,
      planVersion,
      previousPlanId: existing.currentPlanId,
    },
  })

  return {
    production: localFindProductionById(productionId)!,
    plan: localFindProductionPlanById(planId)!,
    stages: localListProductionStages(productionId),
    tasks: localListProductionTasks(productionId),
  }
}

export function localFindProductionById(productionId: string): LocalProductionRow | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM productions WHERE production_id = ?').get(productionId) as DbRow | undefined
  return row ? rowToProduction(row) : null
}

export function localFindProductionPlanById(planId: string): LocalProductionPlanRow | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM production_plans WHERE plan_id = ?').get(planId) as DbRow | undefined
  return row ? rowToPlan(row) : null
}

export function localListProductionPlans(productionId: string): LocalProductionPlanRow[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM production_plans WHERE production_id = ? ORDER BY plan_version DESC, created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToPlan)
}

export function localListProductions(params: { page?: number; limit?: number; status?: ProductionStatus; search?: string }): {
  data: LocalProductionRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
} {
  const db = getLocalDb()
  const page = Math.max(1, params.page ?? 1)
  const limit = Math.min(100, Math.max(1, params.limit ?? 20))
  const offset = (page - 1) * limit

  let where = 'WHERE 1 = 1'
  const args: unknown[] = []
  if (params.status) {
    where += ' AND status = ?'
    args.push(params.status)
  }
  if (params.search) {
    where += ' AND (name LIKE ? OR goal LIKE ?)'
    args.push(`%${params.search}%`, `%${params.search}%`)
  }

  const total = Number((db.prepare(`SELECT COUNT(*) as cnt FROM productions ${where}`).get(...args) as { cnt: number }).cnt || 0)
  const rows = db.prepare(`SELECT * FROM productions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as DbRow[]
  return {
    data: rows.map(rowToProduction),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export function localUpdateProductionState(
  productionId: string,
  fields: Partial<Pick<Production, 'status' | 'currentStageId' | 'currentPlanId' | 'completedAt'>> & { isPaused?: boolean }
): LocalProductionRow | null {
  const db = getLocalDb()
  const existing = localFindProductionById(productionId)
  if (!existing) return null
  const sets: string[] = ['updated_at = ?']
  const args: unknown[] = [nowIso()]
  if (fields.status !== undefined) {
    sets.push('status = ?')
    args.push(fields.status)
  }
  if (fields.currentStageId !== undefined) {
    sets.push('current_stage_id = ?')
    args.push(fields.currentStageId ?? null)
  }
  if (fields.currentPlanId !== undefined) {
    sets.push('current_plan_id = ?')
    args.push(fields.currentPlanId ?? null)
  }
  if (fields.isPaused !== undefined) {
    sets.push('is_paused = ?')
    args.push(fields.isPaused ? 1 : 0)
  }
  if (fields.completedAt !== undefined) {
    sets.push('completed_at = ?')
    args.push(fields.completedAt ?? null)
  }
  args.push(productionId)
  db.prepare(`UPDATE productions SET ${sets.join(', ')} WHERE production_id = ?`).run(...args)
  return localFindProductionById(productionId)
}

export function localListProductionStages(productionId: string): ProductionStage[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM production_stages WHERE production_id = ? ORDER BY sequence ASC').all(productionId) as DbRow[]
  return rows.map(rowToStage)
}

export function localFindProductionStageById(stageId: string): ProductionStage | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM production_stages WHERE stage_id = ?').get(stageId) as DbRow | undefined
  return row ? rowToStage(row) : null
}

export function localUpdateStageStatus(stageId: string, status: ProductionStage['status']): ProductionStage | null {
  const db = getLocalDb()
  const now = nowIso()
  db.prepare(`
    UPDATE production_stages
    SET status = ?, updated_at = ?, completed_at = ?
    WHERE stage_id = ?
  `).run(status, now, status === 'completed' ? now : null, stageId)
  const row = db.prepare('SELECT * FROM production_stages WHERE stage_id = ?').get(stageId) as DbRow | undefined
  return row ? rowToStage(row) : null
}

export function localListProductionTasks(productionId: string): ProductionTask[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM production_tasks WHERE production_id = ? ORDER BY created_at ASC, priority ASC').all(productionId) as DbRow[]
  return rows.map(rowToTask)
}

export function localFindProductionTaskById(taskId: string): ProductionTask | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM production_tasks WHERE task_id = ?').get(taskId) as DbRow | undefined
  return row ? rowToTask(row) : null
}

export function localListProductionAttempts(productionId: string): TaskAttempt[] {
  const db = getLocalDb()
  const rows = db.prepare(`
    SELECT ta.* FROM task_attempts ta
    INNER JOIN production_tasks t ON t.task_id = ta.task_id
    WHERE t.production_id = ?
    ORDER BY ta.started_at DESC
  `).all(productionId) as DbRow[]
  return rows.map(rowToAttempt)
}

export function localFindAttemptById(taskAttemptId: string): TaskAttempt | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM task_attempts WHERE task_attempt_id = ?').get(taskAttemptId) as DbRow | undefined
  return row ? rowToAttempt(row) : null
}

export function localListProductionArtifacts(productionId: string): ArtifactVersion[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM artifact_versions WHERE production_id = ? ORDER BY created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToArtifact)
}

export function localFindArtifactById(artifactVersionId: string): ArtifactVersion | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM artifact_versions WHERE artifact_version_id = ?').get(artifactVersionId) as DbRow | undefined
  return row ? rowToArtifact(row) : null
}

export function localReadArtifactContent(artifactVersionId: string): { artifact: ArtifactVersion; content: string } | null {
  const artifact = localFindArtifactById(artifactVersionId)
  if (!artifact) return null
  if (!artifact.storageUri.startsWith('file://')) return { artifact, content: '' }
  const filePath = artifact.storageUri.replace(/^file:\/\//, '')
  return {
    artifact,
    content: readFileSync(filePath, 'utf8'),
  }
}

export function localListProductionReviewJobs(productionId: string): ReviewJob[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM review_jobs WHERE production_id = ? ORDER BY created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToReviewJob)
}

export function localListOpenReviewJobs(limit = 100): ReviewJob[] {
  const db = getLocalDb()
  const rows = db.prepare(`
    SELECT * FROM review_jobs
    WHERE status IN ('pending', 'running')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as DbRow[]
  return rows.map(rowToReviewJob)
}

export function localFindReviewJobById(reviewJobId: string): ReviewJob | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM review_jobs WHERE review_job_id = ?').get(reviewJobId) as DbRow | undefined
  return row ? rowToReviewJob(row) : null
}

export function localListProductionReviewDecisions(productionId: string): ReviewDecision[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM review_decisions WHERE production_id = ? ORDER BY created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToReviewDecision)
}

export function localListEscalations(productionId: string): Escalation[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM escalations WHERE production_id = ? ORDER BY created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToEscalation)
}

export function localListOpenEscalations(limit = 100): Escalation[] {
  const db = getLocalDb()
  const rows = db.prepare(`
    SELECT * FROM escalations
    WHERE status = 'open'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as DbRow[]
  return rows.map(rowToEscalation)
}

export function localFindEscalationById(escalationId: string): Escalation | null {
  const db = getLocalDb()
  const row = db.prepare('SELECT * FROM escalations WHERE escalation_id = ?').get(escalationId) as DbRow | undefined
  return row ? rowToEscalation(row) : null
}

export function localListHumanDecisions(productionId: string): HumanDecision[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM human_decisions WHERE production_id = ? ORDER BY created_at DESC').all(productionId) as DbRow[]
  return rows.map(rowToHumanDecision)
}

export function localRecordReviewDecision(input: {
  reviewJobId: string
  decision: ReviewDecision['decision']
  score?: number
  findings?: string[]
  revisionRequest?: {
    mustFix?: string[]
    shouldFix?: string[]
  }
}): { reviewJob: ReviewJob; reviewDecision: ReviewDecision } | null {
  const db = getLocalDb()
  const reviewJob = localFindReviewJobById(input.reviewJobId)
  if (!reviewJob) return null
  const now = nowIso()
  const reviewDecisionId = randomUUID()
  const revisionRequest = {
    mustFix: Array.isArray(input.revisionRequest?.mustFix) ? input.revisionRequest?.mustFix ?? [] : [],
    shouldFix: Array.isArray(input.revisionRequest?.shouldFix) ? input.revisionRequest?.shouldFix ?? [] : [],
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE review_jobs
      SET status = 'completed', updated_at = ?, completed_at = ?
      WHERE review_job_id = ?
    `).run(now, now, input.reviewJobId)

    db.prepare(`
      INSERT INTO review_decisions (
        review_decision_id, review_job_id, production_id, task_id, task_attempt_id,
        reviewer_role, reviewer_type, decision, score, findings_json, revision_request_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewDecisionId,
      reviewJob.id,
      reviewJob.productionId,
      reviewJob.taskId,
      reviewJob.taskAttemptId,
      reviewJob.reviewerRole,
      reviewJob.reviewerType,
      input.decision,
      input.score ?? null,
      JSON.stringify(input.findings ?? []),
      JSON.stringify(revisionRequest),
      now,
    )
  })
  tx()

  return {
    reviewJob: localFindReviewJobById(reviewJob.id)!,
    reviewDecision: rowToReviewDecision({
      review_decision_id: reviewDecisionId,
      review_job_id: reviewJob.id,
      production_id: reviewJob.productionId,
      task_id: reviewJob.taskId,
      task_attempt_id: reviewJob.taskAttemptId,
      reviewer_role: reviewJob.reviewerRole,
      reviewer_type: reviewJob.reviewerType,
      decision: input.decision,
      score: input.score ?? null,
      findings_json: JSON.stringify(input.findings ?? []),
      revision_request_json: JSON.stringify(revisionRequest),
      created_at: now,
    }),
  }
}

export function localListProductionEvents(productionId: string, limit = 100): ProductionEvent[] {
  const db = getLocalDb()
  const rows = db.prepare('SELECT * FROM production_events WHERE production_id = ? ORDER BY created_at DESC LIMIT ?').all(productionId, limit) as DbRow[]
  return rows.map(rowToEvent)
}

export function localAppendProductionEvent(input: {
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  eventType: string
  eventVersion?: string
  payload?: Record<string, unknown>
}): ProductionEvent {
  const db = getLocalDb()
  const id = randomUUID()
  const now = nowIso()
  db.prepare(`
    INSERT INTO production_events (
      production_event_id, production_id, stage_id, task_id, task_attempt_id, event_type, event_version, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.productionId,
    input.stageId ?? null,
    input.taskId ?? null,
    input.taskAttemptId ?? null,
    input.eventType,
    input.eventVersion ?? '1',
    JSON.stringify(input.payload ?? {}),
    now,
  )
  return rowToEvent({
    production_event_id: id,
    production_id: input.productionId,
    stage_id: input.stageId ?? null,
    task_id: input.taskId ?? null,
      task_attempt_id: input.taskAttemptId ?? null,
      event_type: input.eventType,
      event_version: input.eventVersion ?? '1',
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: now,
    })
  }

export function localClaimNextRunnableTask(productionId: string, workerId: string): {
  task: ProductionTask
  attempt: TaskAttempt
} | null {
  const db = getLocalDb()
  const now = nowIso()
  const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const tx = db.transaction(() => {
    const production = localFindProductionById(productionId)
    if (!production || production.status !== 'active' || production.isPaused) return null

    const tasks = localListProductionTasks(productionId)
    const done = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.id))
    const candidate = tasks.find((task) =>
      task.status === 'pending' &&
      task.dependsOnTaskIds.every((depId) => done.has(depId))
    )
    if (!candidate) return null

    const attemptNo = Number((db.prepare('SELECT COALESCE(MAX(attempt_no), 0) as n FROM task_attempts WHERE task_id = ?').get(candidate.id) as { n: number }).n || 0) + 1
    const taskAttemptId = randomUUID()
    const claimResult = db.prepare(`
      UPDATE production_tasks
      SET status = 'running', leased_by = ?, lease_expires_at = ?, current_attempt_id = ?, updated_at = ?
      WHERE task_id = ? AND status = 'pending' AND leased_by IS NULL
    `).run(workerId, leaseExpiresAt, taskAttemptId, now, candidate.id)
    if (claimResult.changes === 0) return null

    db.prepare(`
      INSERT INTO task_attempts (
        task_attempt_id, task_id, attempt_no, worker_id, status, input_envelope_json,
        lease_expires_at, heartbeat_at, started_at
      ) VALUES (?, ?, ?, ?, 'created', '{}', ?, ?, ?)
    `).run(taskAttemptId, candidate.id, attemptNo, workerId, leaseExpiresAt, now, now)

    localAppendProductionEvent({
      productionId,
      stageId: candidate.stageId,
      taskId: candidate.id,
      taskAttemptId,
      eventType: 'task.claimed',
      payload: { workerId, attemptNo },
    })
    localAppendProductionEvent({
      productionId,
      stageId: candidate.stageId,
      taskId: candidate.id,
      taskAttemptId,
      eventType: 'attempt.created',
      payload: { workerId, attemptNo },
    })

    return {
      task: localFindProductionTaskById(candidate.id)!,
      attempt: rowToAttempt({
        task_attempt_id: taskAttemptId,
        task_id: candidate.id,
        attempt_no: attemptNo,
        worker_id: workerId,
        status: 'created',
        input_envelope_json: '{}',
        output_result_json: null,
        lease_expires_at: leaseExpiresAt,
        heartbeat_at: now,
        checkpoint_ref: null,
        failure_kind: null,
        failure_detail_json: '{}',
        usage_json: '{}',
        started_at: now,
        ended_at: null,
      }),
    }
  })

  return tx()
}

export function localStartAttempt(
  taskAttemptId: string,
  inputEnvelope: Record<string, unknown>,
): TaskAttempt | null {
  const db = getLocalDb()
  const now = nowIso()
  db.prepare(`
    UPDATE task_attempts
    SET status = 'running', input_envelope_json = ?, heartbeat_at = ?, started_at = ?
    WHERE task_attempt_id = ?
  `).run(JSON.stringify(inputEnvelope), now, now, taskAttemptId)
  const row = db.prepare('SELECT * FROM task_attempts WHERE task_attempt_id = ?').get(taskAttemptId) as DbRow | undefined
  return row ? rowToAttempt(row) : null
}

export function localUpdateAttemptHeartbeat(taskAttemptId: string): void {
  const db = getLocalDb()
  db.prepare('UPDATE task_attempts SET heartbeat_at = ? WHERE task_attempt_id = ?').run(nowIso(), taskAttemptId)
}

export function localSweepExpiredAttempts(input?: {
  now?: string
  heartbeatTimeoutMs?: number
}): Array<{ attemptId: string; taskId: string; productionId: string; reason: string }> {
  const db = getLocalDb()
  const now = input?.now || nowIso()
  const heartbeatTimeoutMs = input?.heartbeatTimeoutMs ?? 5 * 60 * 1000
  const nowMs = new Date(now).getTime()
  const staleAttempts = db.prepare(`
    SELECT ta.*, t.production_id
    FROM task_attempts ta
    INNER JOIN production_tasks t ON t.task_id = ta.task_id
    WHERE ta.status IN ('created', 'running')
      AND (
        (ta.lease_expires_at IS NOT NULL AND ta.lease_expires_at < ?)
        OR (ta.heartbeat_at IS NOT NULL AND ta.heartbeat_at < ?)
      )
  `).all(
    now,
    new Date(nowMs - heartbeatTimeoutMs).toISOString(),
  ) as Array<DbRow & { production_id: string }>

  if (staleAttempts.length === 0) return []

  const tx = db.transaction(() => {
    const recovered: Array<{ attemptId: string; taskId: string; productionId: string; reason: string }> = []
    for (const row of staleAttempts) {
      const attemptId = String(row.task_attempt_id)
      const taskId = String(row.task_id)
      const productionId = String(row.production_id)
      const reason = row.lease_expires_at && String(row.lease_expires_at) < now ? 'lease_expired' : 'heartbeat_timeout'

      db.prepare(`
        UPDATE task_attempts
        SET status = 'failed', failure_kind = ?, failure_detail_json = ?, ended_at = ?, heartbeat_at = ?
        WHERE task_attempt_id = ? AND status IN ('created', 'running')
      `).run(
        reason,
        JSON.stringify({ recovered: true, at: now }),
        now,
        now,
        attemptId,
      )

      db.prepare(`
        UPDATE production_tasks
        SET status = 'pending', leased_by = NULL, lease_expires_at = NULL, current_attempt_id = NULL, failure_reason = ?, updated_at = ?
        WHERE task_id = ? AND current_attempt_id = ?
      `).run(reason, now, taskId, attemptId)

      localAppendProductionEvent({
        productionId,
        taskId,
        taskAttemptId: attemptId,
        eventType: 'attempt.recovered',
        payload: { reason },
      })
      recovered.push({ attemptId, taskId, productionId, reason })
    }
    return recovered
  })

  return tx()
}

export function localCompleteAttempt(input: {
  taskAttemptId: string
  outputResult?: Record<string, unknown>
  usage?: Record<string, unknown>
  failureKind?: string
  failureDetail?: Record<string, unknown>
  success: boolean
}): { task: ProductionTask; attempt: TaskAttempt } | null {
  const db = getLocalDb()
  const attemptRow = db.prepare('SELECT * FROM task_attempts WHERE task_attempt_id = ?').get(input.taskAttemptId) as DbRow | undefined
  if (!attemptRow) return null
  const attempt = rowToAttempt(attemptRow)
  const task = localFindProductionTaskById(attempt.taskId)
  if (!task) return null
  const now = nowIso()

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE task_attempts
      SET status = ?, output_result_json = ?, usage_json = ?, failure_kind = ?, failure_detail_json = ?, ended_at = ?, heartbeat_at = ?
      WHERE task_attempt_id = ?
    `).run(
      input.success ? 'completed' : 'failed',
      input.outputResult ? JSON.stringify(input.outputResult) : null,
      JSON.stringify(input.usage ?? {}),
      input.failureKind ?? null,
      JSON.stringify(input.failureDetail ?? {}),
      now,
      now,
      input.taskAttemptId,
    )

    db.prepare(`
      UPDATE production_tasks
      SET status = ?, leased_by = NULL, lease_expires_at = NULL, failure_reason = ?, updated_at = ?, completed_at = ?
      WHERE task_id = ?
    `).run(
      input.success ? 'done' : 'failed',
      input.success ? null : (input.failureKind ?? 'attempt_failed'),
      now,
      input.success ? now : null,
      task.id,
    )

    localAppendProductionEvent({
      productionId: task.productionId,
      stageId: task.stageId,
      taskId: task.id,
      taskAttemptId: input.taskAttemptId,
      eventType: input.success ? 'attempt.completed' : 'attempt.failed',
      payload: {
        failureKind: input.failureKind,
        usage: input.usage ?? {},
      },
    })
  })

  tx()
  return {
    task: localFindProductionTaskById(task.id)!,
    attempt: rowToAttempt(db.prepare('SELECT * FROM task_attempts WHERE task_attempt_id = ?').get(input.taskAttemptId) as DbRow),
  }
}

export function localCreateRevisionTask(input: {
  sourceTaskId: string
  reviewDecisionId: string
  artifactVersionId: string
  mustFix: string[]
  shouldFix?: string[]
}): ProductionTask | null {
  const db = getLocalDb()
  const sourceTask = localFindProductionTaskById(input.sourceTaskId)
  if (!sourceTask) return null
  const revisionKey = `${sourceTask.key}__revision__${input.reviewDecisionId.slice(-8)}`
  const existing = db.prepare('SELECT * FROM production_tasks WHERE production_id = ? AND task_key = ?').get(sourceTask.productionId, revisionKey) as DbRow | undefined
  if (existing) return rowToTask(existing)

  const taskId = randomUUID()
  const now = nowIso()
  const executionPolicy = {
    ...sourceTask.executionPolicy,
    revisionContext: {
      reviewDecisionId: input.reviewDecisionId,
      priorArtifactVersionId: input.artifactVersionId,
      mustFix: input.mustFix,
      shouldFix: input.shouldFix ?? [],
    },
  }
  const goalSuffix = [
    '请基于审查意见完成修订。',
    input.mustFix.length > 0 ? `必须修复:\n- ${input.mustFix.join('\n- ')}` : '',
    (input.shouldFix ?? []).length > 0 ? `建议修复:\n- ${(input.shouldFix ?? []).join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  db.prepare(`
    INSERT INTO production_tasks (
      task_id, production_id, plan_id, stage_id, task_key, title, role, kind, status,
      priority, goal, depends_on_task_ids_json, input_artifact_refs_json, output_contract_json,
      review_policy_json, execution_policy_json, budget_policy_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'revision', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    sourceTask.productionId,
    sourceTask.planId,
    sourceTask.stageId,
    revisionKey,
    `${sourceTask.title || sourceTask.key} / revision`,
    sourceTask.role,
    Math.max(1, sourceTask.priority - 5),
    `${sourceTask.goal}\n\n${goalSuffix}`,
    JSON.stringify([sourceTask.id]),
    JSON.stringify([
      ...sourceTask.inputArtifactRefs,
      {
        artifactVersionId: input.artifactVersionId,
        required: true,
        purpose: 'prior_artifact_version',
      },
    ]),
    JSON.stringify(sourceTask.outputContract),
    JSON.stringify(sourceTask.reviewPolicy),
    JSON.stringify(executionPolicy),
    JSON.stringify(sourceTask.budgetPolicy),
    now,
    now,
  )

  localAppendProductionEvent({
    productionId: sourceTask.productionId,
    stageId: sourceTask.stageId,
    taskId,
    eventType: 'revision.task_created',
    payload: {
      sourceTaskId: sourceTask.id,
      reviewDecisionId: input.reviewDecisionId,
      artifactVersionId: input.artifactVersionId,
    },
  })

  return localFindProductionTaskById(taskId)
}

export function localCreateEscalation(input: {
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  artifactVersionId?: string
  sourceType: string
  reasonCode: string
  payload?: Record<string, unknown>
}): string {
  const db = getLocalDb()
  const escalationId = randomUUID()
  const now = nowIso()
  db.prepare(`
    INSERT INTO escalations (
      escalation_id, production_id, stage_id, task_id, task_attempt_id, artifact_version_id,
      source_type, reason_code, payload_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    escalationId,
    input.productionId,
    input.stageId ?? null,
    input.taskId ?? null,
    input.taskAttemptId ?? null,
    input.artifactVersionId ?? null,
    input.sourceType,
    input.reasonCode,
    JSON.stringify(input.payload ?? {}),
    now,
  )
  localAppendProductionEvent({
    productionId: input.productionId,
    stageId: input.stageId,
    taskId: input.taskId,
    taskAttemptId: input.taskAttemptId,
    eventType: 'escalation.opened',
    payload: { escalationId, reasonCode: input.reasonCode },
  })
  return escalationId
}

export function localResolveEscalation(input: {
  escalationId: string
  productionId: string
  decisionType: string
  payload?: Record<string, unknown>
  decidedBy?: string
}): { escalation: Escalation; humanDecision: HumanDecision } | null {
  const db = getLocalDb()
  const escalationRow = db.prepare('SELECT * FROM escalations WHERE escalation_id = ?').get(input.escalationId) as DbRow | undefined
  if (!escalationRow) return null
  const now = nowIso()
  const humanDecisionId = randomUUID()
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE escalations
      SET status = 'resolved', resolved_at = ?
      WHERE escalation_id = ?
    `).run(now, input.escalationId)

    db.prepare(`
      INSERT INTO human_decisions (
        human_decision_id, escalation_id, production_id, decision_type, payload_json, decided_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      humanDecisionId,
      input.escalationId,
      input.productionId,
      input.decisionType,
      JSON.stringify(input.payload ?? {}),
      input.decidedBy ?? null,
      now,
    )
  })
  tx()

  const escalation = rowToEscalation({
    ...escalationRow,
    status: 'resolved',
    resolved_at: now,
  })
  const humanDecision = rowToHumanDecision({
    human_decision_id: humanDecisionId,
    escalation_id: input.escalationId,
    production_id: input.productionId,
    decision_type: input.decisionType,
    payload_json: JSON.stringify(input.payload ?? {}),
    decided_by: input.decidedBy ?? null,
    created_at: now,
  })
  localAppendProductionEvent({
    productionId: input.productionId,
    stageId: escalation.stageId,
    taskId: escalation.taskId,
    taskAttemptId: escalation.taskAttemptId,
    eventType: 'human.decision.recorded',
    payload: { escalationId: input.escalationId, decisionType: input.decisionType },
  })
  return { escalation, humanDecision }
}

export function localRegisterArtifact(input: {
  productionId: string
  artifactKey: string
  artifactType: string
  schemaVersion: string
  reviewState?: ArtifactVersion['reviewState']
  content: string
  summary?: string
  metadata?: Record<string, unknown>
  lineageRefs?: string[]
  createdByTaskId?: string
  createdByAttemptId?: string
}): ArtifactVersion {
  const artifactsRoot = resolveArtifactsRoot()
  mkdirSync(artifactsRoot, { recursive: true })
  const db = getLocalDb()
  const nextVersion = Number((db.prepare(`
    SELECT COALESCE(MAX(version), 0) as version
    FROM artifact_versions
    WHERE production_id = ? AND artifact_key = ?
  `).get(input.productionId, input.artifactKey) as { version: number }).version || 0) + 1

  const fileId = `${input.productionId}-${input.artifactKey}-v${nextVersion}.md`
  const filePath = path.join(artifactsRoot, fileId)
  writeFileSync(filePath, input.content, 'utf8')
  const artifactVersionId = randomUUID()
  const now = nowIso()
  const storageUri = `file://${filePath}`

  db.prepare(`
    INSERT INTO artifact_versions (
      artifact_version_id, production_id, artifact_key, version, artifact_type, schema_version,
      review_state, storage_uri, summary, metadata_json, lineage_refs_json, created_by_task_id, created_by_attempt_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactVersionId,
    input.productionId,
    input.artifactKey,
    nextVersion,
    input.artifactType,
    input.schemaVersion,
    input.reviewState ?? 'draft',
    storageUri,
    input.summary ?? null,
    JSON.stringify(input.metadata ?? {}),
    JSON.stringify(input.lineageRefs ?? []),
    input.createdByTaskId ?? null,
    input.createdByAttemptId ?? null,
    now,
  )

  const artifact = rowToArtifact({
    artifact_version_id: artifactVersionId,
    production_id: input.productionId,
    artifact_key: input.artifactKey,
    version: nextVersion,
    artifact_type: input.artifactType,
    schema_version: input.schemaVersion,
    review_state: input.reviewState ?? 'draft',
    storage_uri: storageUri,
    summary: input.summary ?? null,
    metadata_json: JSON.stringify(input.metadata ?? {}),
    lineage_refs_json: JSON.stringify(input.lineageRefs ?? []),
    created_by_task_id: input.createdByTaskId ?? null,
    created_by_attempt_id: input.createdByAttemptId ?? null,
    created_at: now,
  })

  localAppendProductionEvent({
    productionId: input.productionId,
    taskId: input.createdByTaskId,
    taskAttemptId: input.createdByAttemptId,
    eventType: 'artifact.materialized',
    payload: {
      artifactVersionId,
      artifactKey: input.artifactKey,
      version: nextVersion,
      storageUri,
    },
  })

  return artifact
}

export function localUpdateArtifactSummary(artifactVersionId: string, summary: string): ArtifactVersion | null {
  const db = getLocalDb()
  const now = nowIso()
  db.prepare(`
    UPDATE artifact_versions
    SET summary = ?
    WHERE artifact_version_id = ?
  `).run(summary || null, artifactVersionId)
  const artifact = localFindArtifactById(artifactVersionId)
  if (!artifact) return null
  localAppendProductionEvent({
    productionId: artifact.productionId,
    taskId: artifact.createdByTaskId,
    taskAttemptId: artifact.createdByAttemptId,
    eventType: 'artifact.summary_updated',
    payload: { artifactVersionId, summary, updatedAt: now },
  })
  return artifact
}

export function localCreateReviewJobsForTask(task: ProductionTask, taskAttemptId: string, artifacts: ArtifactVersion[]): ReviewJob[] {
  const policy = task.reviewPolicy as ReviewPolicy
  if (!policy.required || artifacts.length === 0) return []
  const db = getLocalDb()
  const now = nowIso()
  const rows: ReviewJob[] = []

  for (const artifact of artifacts) {
    const reviewJobId = randomUUID()
    db.prepare(`
      INSERT INTO review_jobs (
        review_job_id, production_id, task_id, task_attempt_id, artifact_version_id,
        reviewer_role, reviewer_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      reviewJobId,
      task.productionId,
      task.id,
      taskAttemptId,
      artifact.id,
      policy.reviewerRole ?? 'reviewer',
      policy.reviewerType ?? 'llm_auto',
      now,
      now,
    )
    rows.push(rowToReviewJob({
      review_job_id: reviewJobId,
      production_id: task.productionId,
      task_id: task.id,
      task_attempt_id: taskAttemptId,
      artifact_version_id: artifact.id,
      reviewer_role: policy.reviewerRole ?? 'reviewer',
      reviewer_type: policy.reviewerType ?? 'llm_auto',
      status: 'pending',
      retry_count: 0,
      lease_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    }))
  }
  return rows
}
