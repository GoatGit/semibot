/**
 * Autonomous Production System (APS) shared contracts.
 */

export type ProductionStatus =
  | 'planned'
  | 'active'
  | 'paused'
  | 'awaiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ProductionStageStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'failed'

export type ProductionTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'superseded'

export type ProductionTaskKind =
  | 'generation'
  | 'revision'
  | 'review'
  | 'analysis'
  | 'aggregation'

export type TaskAttemptStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ReviewJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ReviewDecisionType = 'approved' | 'request_revision' | 'rejected'
export type TypedResultFailureKind =
  | 'missing_output'
  | 'missing_required_artifact'
  | 'invalid_output_contract'
  | 'session_failed'
  | 'dispatch_failed'
  | 'runtime_failed'
  | 'unknown'

export type ArtifactReviewState = 'draft' | 'review_pending' | 'approved' | 'revision_requested' | 'rejected'

export interface ProductionConstraints {
  deliveryScope?: string
  audience?: string
  style?: string
  outputLanguage?: string
  budget?: {
    maxTokens?: number
    maxDurationSeconds?: number
    maxAttemptsPerTask?: number
  }
  [key: string]: unknown
}

export interface ProductionConfig {
  defaultAgentId?: string
  autoStart?: boolean
  autoDispatch?: boolean
  [key: string]: unknown
}

export interface ArtifactRef {
  artifactKey?: string
  artifactVersionId?: string
  required?: boolean
  purpose?: string
}

export interface OutputArtifactContract {
  artifactKey: string
  artifactType: string
  schemaVersion: string
  required?: boolean
}

export interface ReviewPolicy {
  required?: boolean
  reviewerRole?: string
  reviewerType?: 'llm_auto' | 'human'
}

export interface ExecutionPolicy {
  agentId?: string
  sessionTitle?: string
  [key: string]: unknown
}

export interface BudgetPolicy {
  maxTokens?: number
  maxDurationSeconds?: number
  maxAttempts?: number
}

export interface TaskEnvelope {
  schemaVersion: string
  productionId: string
  productionName: string
  productionGoal: string
  stageId?: string
  stageTitle?: string
  taskId: string
  taskKey: string
  taskTitle?: string
  taskGoal: string
  taskKind: ProductionTaskKind
  attemptNo: number
  role: string
  inputArtifacts: Array<{
    artifactVersionId: string
    artifactKey: string
    artifactType: string
    version: number
    summary?: string
    purpose?: string
  }>
  outputContracts: OutputArtifactContract[]
  reviewPolicy: ReviewPolicy
  executionPolicy: ExecutionPolicy
  budgetPolicy: BudgetPolicy
  deadlineAt?: string
  allowedCapabilities?: string[]
  revisionContext?: {
    reviewDecisionId?: string
    priorArtifactVersionId?: string
    mustFix: string[]
    shouldFix?: string[]
  }
}

export interface TypedResultArtifactRef {
  artifactKey: string
  artifactType: string
  artifactVersionId?: string
  storageUri?: string
  content?: string
  summary?: string
}

export interface TypedResult {
  schemaVersion: string
  status: 'completed' | 'failed'
  text?: string
  artifacts: TypedResultArtifactRef[]
  usage: Record<string, unknown>
  metrics?: Record<string, unknown>
  failure?: {
    kind: TypedResultFailureKind | string
    detail?: Record<string, unknown>
  }
}

export interface ReviewerDecisionEnvelope {
  schemaVersion: string
  decision: ReviewDecisionType
  score?: number
  findings: string[]
  revisionRequest?: {
    mustFix: string[]
    shouldFix?: string[]
  }
}

export interface ProductionTaskDefinition {
  key: string
  title?: string
  role: string
  kind: ProductionTaskKind
  goal: string
  dependsOnTaskKeys?: string[]
  inputArtifactRefs?: ArtifactRef[]
  outputContract?: OutputArtifactContract[]
  reviewPolicy?: ReviewPolicy
  executionPolicy?: ExecutionPolicy
  budgetPolicy?: BudgetPolicy
  priority?: number
}

export interface ProductionStageDefinition {
  key: string
  title: string
  description?: string
  sequence: number
  exitCriteria?: string
  reviewGateConfig?: Record<string, unknown>
  tasks: ProductionTaskDefinition[]
}

export interface ProductionPlan {
  schemaVersion: string
  rationale?: string
  stages: ProductionStageDefinition[]
}

export type PlannerPlanMode = 'initial' | 'incremental_replan' | 'full_replan'

export type PlannerValidationFailureCode =
  | 'missing_json'
  | 'invalid_json'
  | 'invalid_envelope'
  | 'invalid_plan_shape'
  | 'duplicate_stage_key'
  | 'duplicate_task_key'
  | 'empty_stage'
  | 'invalid_task_kind'
  | 'missing_task_fields'

export interface PlannerValidationFailure {
  code: PlannerValidationFailureCode
  message: string
}

export interface PlannerOutput {
  schemaVersion: string
  planMode: PlannerPlanMode
  rationale?: string
  plan: ProductionPlan
}

export interface ReplanProductionInput {
  goal?: string
  constraints?: ProductionConstraints
  config?: ProductionConfig
  plan?: ProductionPlan
}

export interface Production {
  id: string
  orgId: string
  name: string
  goal: string
  constraints: ProductionConstraints
  config: ProductionConfig
  status: ProductionStatus
  currentPlanId?: string
  currentStageId?: string
  isPaused: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ProductionStage {
  id: string
  productionId: string
  planId: string
  key: string
  title: string
  description?: string
  sequence: number
  status: ProductionStageStatus
  exitCriteria?: string
  reviewGateConfig: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ProductionTask {
  id: string
  productionId: string
  planId: string
  stageId: string
  key: string
  title?: string
  role: string
  kind: ProductionTaskKind
  status: ProductionTaskStatus
  priority: number
  goal: string
  dependsOnTaskIds: string[]
  inputArtifactRefs: ArtifactRef[]
  outputContract: OutputArtifactContract[]
  reviewPolicy: ReviewPolicy
  executionPolicy: ExecutionPolicy
  budgetPolicy: BudgetPolicy
  currentAttemptId?: string
  leaseExpiresAt?: string
  leasedBy?: string
  failureReason?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface TaskAttempt {
  id: string
  taskId: string
  attemptNo: number
  workerId?: string
  status: TaskAttemptStatus
  inputEnvelope: Record<string, unknown>
  outputResult?: Record<string, unknown>
  leaseExpiresAt?: string
  heartbeatAt?: string
  checkpointRef?: string
  failureKind?: string
  failureDetail: Record<string, unknown>
  usage: Record<string, unknown>
  startedAt: string
  endedAt?: string
}

export interface ArtifactVersion {
  id: string
  productionId: string
  artifactKey: string
  version: number
  artifactType: string
  schemaVersion: string
  reviewState: ArtifactReviewState
  storageUri: string
  summary?: string
  metadata: Record<string, unknown>
  lineageRefs: string[]
  createdByTaskId?: string
  createdByAttemptId?: string
  createdAt: string
}

export interface ArtifactLineageSummary {
  current: ArtifactVersion
  previous?: ArtifactVersion
  related: ArtifactVersion[]
}

export interface ArtifactDiffLine {
  type: 'context' | 'added' | 'removed'
  content: string
}

export interface ArtifactDiffSummary {
  artifact: ArtifactVersion
  baseArtifact?: ArtifactVersion
  stats: {
    added: number
    removed: number
    changed: boolean
  }
  lines: ArtifactDiffLine[]
}

export interface ReviewJob {
  id: string
  productionId: string
  taskId: string
  taskAttemptId: string
  artifactVersionId: string
  reviewerRole: string
  reviewerType: 'llm_auto' | 'human'
  status: ReviewJobStatus
  retryCount: number
  leaseExpiresAt?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ReviewDecision {
  id: string
  reviewJobId: string
  productionId: string
  taskId: string
  taskAttemptId: string
  reviewerRole: string
  reviewerType: 'llm_auto' | 'human'
  decision: ReviewDecisionType
  score?: number
  findings: string[]
  revisionRequest: {
    mustFix: string[]
    shouldFix?: string[]
  }
  createdAt: string
}

export type StageGateReasonCode =
  | 'review_rejected'
  | 'multiple_reviews_rejected'
  | 'review_requested_revision'
  | 'multiple_reviews_requested_revision'
  | 'pending_reviews'
  | 'stage_not_ready'
  | 'stage_ready_to_advance'
  | 'failed_tasks'
  | 'running_tasks'

export interface Escalation {
  id: string
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  artifactVersionId?: string
  sourceType: string
  reasonCode: string
  payload: Record<string, unknown>
  status: 'open' | 'resolved' | 'cancelled'
  createdAt: string
  resolvedAt?: string
}

export interface HumanDecision {
  id: string
  escalationId: string
  productionId: string
  decisionType: string
  payload: Record<string, unknown>
  decidedBy?: string
  createdAt: string
}

export interface ProductionEvent {
  id: string
  productionId: string
  stageId?: string
  taskId?: string
  taskAttemptId?: string
  eventType: string
  eventVersion: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface ProductionStageHealth {
  stageId: string
  stageKey: string
  stageTitle: string
  status: ProductionStageStatus
  health: 'healthy' | 'waiting_review' | 'blocked' | 'at_risk' | 'completed'
  reason: string
  taskCounts: {
    total: number
    pending: number
    running: number
    done: number
    failed: number
    superseded: number
  }
  reviewCounts: {
    total: number
    pending: number
    approved: number
    revisionRequested: number
    rejected: number
  }
}

export interface ProductionControlRoomSummary {
  pendingReviews: number
  openEscalations: number
  runningTasks: number
  revisionTasks: number
  failedTasks: number
  totalTokens: number
  stageHealth: ProductionStageHealth[]
}

export interface StageGateCounts {
  reviewJobsTotal: number
  pendingReviews: number
  approved: number
  revisionRequested: number
  rejected: number
  failedTasks: number
  runningTasks: number
  doneTasks: number
}

export interface StageGateEvaluation {
  decision: 'pass' | 'block' | 'request_revision' | 'replan' | 'escalate'
  stageId: string
  reason: StageGateReasonCode | string
  reviewDecisionId?: string
  reviewDecisionIds?: string[]
  counts: StageGateCounts
}

export interface ProductionPlanSnapshot {
  id: string
  productionId: string
  planVersion: number
  schemaVersion: string
  plannerType: string
  rationale?: string
  plannerMetadata?: Record<string, unknown>
  graph: ProductionPlan
  createdAt: string
}

export interface ProductionGraphDiffSummary {
  currentPlan?: ProductionPlanSnapshot
  basePlan?: ProductionPlanSnapshot
  stats: {
    addedStages: number
    removedStages: number
    addedTasks: number
    removedTasks: number
    supersededTasks: number
  }
  addedStageKeys: string[]
  removedStageKeys: string[]
  addedTaskKeys: string[]
  removedTaskKeys: string[]
  supersededTaskIds: string[]
}

export interface ProductionPortfolioIssue {
  severity: 'info' | 'warning' | 'critical'
  code: 'awaiting_human' | 'blocked_stage' | 'pending_reviews' | 'running' | 'failed_tasks' | 'healthy'
  title: string
  description: string
}

export interface ProductionPortfolioItem {
  production: Production
  controlRoom: ProductionControlRoomSummary
  currentStage?: ProductionStage
  topIssue: ProductionPortfolioIssue
}

export interface ProductionPortfolioSummary {
  totals: {
    productions: number
    active: number
    awaitingHuman: number
    blocked: number
    pendingReviews: number
    openEscalations: number
    runningTasks: number
    totalTokens: number
  }
  items: ProductionPortfolioItem[]
}

export interface CreateProductionInput {
  name: string
  goal: string
  constraints?: ProductionConstraints
  config?: ProductionConfig
  plan?: ProductionPlan
}

export interface UpdateProductionInput {
  name?: string
  goal?: string
  constraints?: ProductionConstraints
  config?: ProductionConfig
  status?: ProductionStatus
  isPaused?: boolean
}

export interface DispatchProductionTaskInput {
  workerId?: string
}
