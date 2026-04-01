/**
 * Semibot Frontend Type Definitions
 *
 * 从 @semibot/shared-types 重新导出类型，确保前后端类型一致
 */

// ═══════════════════════════════════════════════════════════════
// 从 shared-types 导入核心类型
// ═══════════════════════════════════════════════════════════════

export type {
  // Agent 相关
  Agent,
  AgentModelConfig,
  AgentState,
  AgentActionType,
  AgentPlan,
  AgentStatus,
  AgentVersion,
  // Skill 相关
  Tool,
  ToolType,
  ToolSchema,
  ToolParameterSchema,
  // Session 相关
  Session,
  SessionStatus,
  // Message 相关
  Message,
  MessageRole,
  ToolCall,
  // Agent2UI 相关
  Agent2UIType,
  Agent2UIMessage,
  Agent2UIData,
  TextData,
  MarkdownData,
  CodeData,
  TableData,
  ChartData,
  ImageData,
  FileData,
  PlanData,
  PlanStepData,
  ProgressData,
  ToolCallData,
  ToolResultData,
  SkillCallData,
  SkillResultData,
  McpCallData,
  McpResultData,
  ErrorData,
  ThinkingData,
  ReportData,
  // Table 相关
  TableColumn,
  // Sandbox 相关
  SandboxLogLevel,
  SandboxLogData,
  SandboxOutputStream,
  SandboxOutputData,
  SandboxStatus,
  SandboxStatusData,
  // DTO 相关
  CreateAgentInput,
  UpdateAgentInput,
  AgentModelConfigInput,
  CreateSessionInput,
  UpdateSessionInput,
  AddMessageInput,
  ChatMessageInput,
  StartChatInput,
  CreateSkillInput,
  UpdateSkillInput,
  SkillToolInput,
  CreateToolInput,
  UpdateToolInput,
  CreateMcpServerInput,
  UpdateMcpServerInput,
  McpTransport,
  McpAuthType,
  CreateMemoryInput,
  SearchMemoriesInput,
  CreateApiKeyInput,
  RegisterInput,
  LoginInput,
  RefreshTokenInput,
  // API 响应
  ApiResponse,
  PaginationMeta,
  CursorPaginationMeta,
  // Studio 相关
  Studio,
  StudioRun,
  AgentNode,
  StudioEdge,
  StudioSchema,
  StudioInputHint,
  NodeResult,
  NodeOutput,
  CreateStudioInput,
  UpdateStudioInput,
  TriggerStudioRunInput,
  Production,
  ProductionPlan,
  ProductionStage,
  ProductionTask,
  TaskAttempt,
  ArtifactVersion,
  ArtifactLineageSummary,
  ArtifactDiffSummary,
  ReviewJob,
  ReviewDecision,
  Escalation,
  HumanDecision,
  ProductionEvent,
  ProductionStageHealth,
  ProductionControlRoomSummary,
  ProductionPlanSnapshot,
  ProductionGraphDiffSummary,
  ProductionPortfolioIssue,
  ProductionPortfolioItem,
  ProductionPortfolioSummary,
  ProductionStatus,
  ProductionStageStatus,
  ProductionTaskStatus,
  ProductionTaskKind,
  CreateProductionInput,
  ReplanProductionInput,
  UpdateProductionInput,
  DispatchProductionTaskInput,
} from '@semibot/shared-types'

// ═══════════════════════════════════════════════════════════════
// 前端专用类型（不在 shared-types 中）
// ═══════════════════════════════════════════════════════════════

/**
 * 用户信息
 */
export interface User {
  id: string
  email: string
  name?: string
  avatarUrl?: string
  role: 'owner' | 'admin' | 'member'
}

/**
 * 前端使用的 Agent 配置（兼容旧代码）
 */
export interface AgentConfig {
  model: string
  temperature: number
  maxTokens: number
  timeoutSeconds: number
  retryAttempts?: number
  fallbackModel?: string
  modelRoles?: ModelRoleConfig
}

export interface NodeModelConfig {
  model?: string
  temperature?: number
}

export interface ModelRoleConfig {
  plan?: NodeModelConfig
  act?: NodeModelConfig
  textProcessing?: NodeModelConfig
}

/**
 * 前端使用的 Tool 配置
 */
export interface ToolConfig {
  toolId: string
  required: boolean
  defaultParams?: Record<string, unknown>
}

/**
 * Tool 参数定义
 */
export interface ToolParameter {
  type: string
  description?: string
  default?: unknown
  enum?: unknown[]
}

/**
 * 图表系列数据
 */
export interface ChartSeries {
  name: string
  data: number[]
}

/**
 * 计划步骤
 */
export interface PlanStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  substeps?: PlanStep[]
}

/**
 * 报告章节
 */
export interface ReportSection {
  heading: string
  content: import('@semibot/shared-types').Agent2UIMessage[]
}

// ═══════════════════════════════════════════════════════════════
// API 响应类型（前端专用扩展）
// ═══════════════════════════════════════════════════════════════

export interface ApiError {
  code: string
  message: string
  details?: unknown
}

// ═══════════════════════════════════════════════════════════════
// SSE 事件
// ═══════════════════════════════════════════════════════════════

export interface SSEEvent {
  event: 'message' | 'done' | 'error' | 'heartbeat'
  data: import('@semibot/shared-types').Agent2UIMessage | SSEDoneData | SSEErrorData | null
}

export interface SSEDoneData {
  sessionId: string
  messageId?: string
  status?: string
  pendingApprovalIds?: string[]
}

export interface SSEErrorData {
  code: string
  message: string
}

// ═══════════════════════════════════════════════════════════════
// Memory 类型
// ═══════════════════════════════════════════════════════════════

export type MemoryType = 'episodic' | 'semantic' | 'procedural'

export interface Memory {
  id: string
  agentId: string
  sessionId?: string
  content: string
  embedding?: number[]
  memoryType: MemoryType
  importance: number
  metadata: Record<string, unknown>
  expiresAt?: string
  createdAt: string
}

// ═══════════════════════════════════════════════════════════════
// 执行日志类型
// ═══════════════════════════════════════════════════════════════

export interface ExecutionLog {
  id: string
  agentId: string
  sessionId: string
  requestId?: string
  stepId?: string
  actionId?: string
  state: string
  actionType?: string
  actionName?: string
  actionInput?: Record<string, unknown>
  actionOutput?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  retryCount: number
  durationMs?: number
  tokensInput: number
  tokensOutput: number
  model?: string
  metadata: Record<string, unknown>
  createdAt: string
}

// ═══════════════════════════════════════════════════════════════
// Event Engine 类型（前端）
// ═══════════════════════════════════════════════════════════════

export type RiskLevel = 'low' | 'medium' | 'high'

export interface EventRecord {
  id: string
  eventType: string
  source: string
  subject?: string
  payload?: Record<string, unknown>
  riskHint?: RiskLevel
  createdAt: string
}

export type RuleActionType = 'notify' | 'run_agent' | 'execute_plan' | 'call_webhook' | 'log_only'
export type RuleActionMode = 'ask' | 'suggest' | 'auto' | 'skip'

export interface RuleAction {
  actionType: RuleActionType
  params?: Record<string, unknown>
}

export interface EventRule {
  id: string
  name: string
  eventType: string
  conditions?: Record<string, unknown>
  actionMode: RuleActionMode
  actions?: RuleAction[]
  riskLevel: RiskLevel
  priority: number
  isActive: boolean
  dedupeWindowSeconds?: number
  cooldownSeconds?: number
  attentionBudgetPerDay?: number
  createdAt?: string
  updatedAt?: string
  effectiveAt?: string
}

export interface ApprovalRecord {
  id: string
  eventId?: string
  eventType?: string
  sessionId?: string
  attemptId?: string
  userMessageId?: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  riskLevel: RiskLevel
  reason?: string
  toolName?: string
  capabilityId?: string
  action?: string
  target?: string
  summary?: string
  context?: Record<string, unknown>
  createdAt: string
  resolvedAt?: string
}

export interface RuntimeMonitorSummary {
  signalCount: number
  failureCount: number
  heartbeatCount: number
  usageCallCount: number
  routeDecisionCount: number
  routeModeCounts: {
    direct_answer: number
    direct_reasoning: number
    plan_act: number
    delegate: number
  }
  drRunCount: number
  drUpgradeCount: number
  promptTokens24h: number
  completionTokens24h: number
  totalTokens24h: number
  latestSignalAt?: string | null
  latestFailureAt?: string | null
  latestHeartbeatAt?: string | null
  loopAlertCount: number
  retryableFailureCount: number
  activeSessionCount: number
  staleSessionCount: number
}

export interface RuntimeStaleSession {
  sessionId: string
  lastHeartbeatAt: string
  ageSeconds: number
}

export interface RuntimeMonitorSnapshot {
  available: boolean
  error?: string
  summary: RuntimeMonitorSummary
  timeline: EventRecord[]
  signals: EventRecord[]
  failures: EventRecord[]
  heartbeats: EventRecord[]
  usage: EventRecord[]
  staleSessions: RuntimeStaleSession[]
}

export interface SessionNotice {
  kind: 'awaiting_approval' | 'error' | 'warning'
  code: string
  message: string
  approvalIds?: string[]
}

export interface SessionRunStateView {
  sessionId: string
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'idle'
  pendingApprovalIds: string[]
  updatedAt: string
  error?: string
}

export interface SessionProcessTraceView {
  version: 1
  messages: import('@semibot/shared-types').Agent2UIMessage[]
}

export interface RuntimeAttemptSummary {
  id: string
  sessionId: string
  userMessageId: string
  agentId: string
  attemptSeq: number
  executionMode: string
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  approvalSetRevision: number
  approvalBlockCount: number
  resumeCount: number
  latestRevision: number
  checkpointId?: string
  artifactMessageId?: string
  terminalReason?: string
  leasedBy?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  metadata?: Record<string, unknown>
  startedAt: string
  updatedAt: string
  endedAt?: string
}

export interface RuntimeAttemptCheckpointView {
  checkpointId: string
  attemptId: string
  sessionId: string
  userMessageId: string
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  revision: number
  payload?: Record<string, unknown>
  createdAt: string
}

export interface RuntimeAttemptOutboxEventView {
  id: string
  revision: number
  eventType: string
  status: string
  createdAt: string
  deliveredAt?: string
}

export interface RuntimeAttemptOutboxCheckpointView {
  id: string
  checkpointId: string
  revision: number
  projectionTarget: string
  status: string
  createdAt: string
  deliveredAt?: string
}

export interface SessionView {
  session: import('@semibot/shared-types').Session
  messages: import('@semibot/shared-types').Message[]
  currentAttempt?: RuntimeAttemptSummary | null
  attemptsSummary?: RuntimeAttemptSummary[]
  runState: SessionRunStateView | null
  notices: SessionNotice[]
  processTrace: SessionProcessTraceView | null
}

export interface RuntimeAttemptView {
  attempt: RuntimeAttemptSummary
  session: import('@semibot/shared-types').Session
  messages: import('@semibot/shared-types').Message[]
  latestCheckpoint: RuntimeAttemptCheckpointView | null
  eventOutbox: RuntimeAttemptOutboxEventView[]
  checkpointOutbox: RuntimeAttemptOutboxCheckpointView[]
  runState: SessionRunStateView | null
  notices: SessionNotice[]
  processTrace: SessionProcessTraceView | null
}
