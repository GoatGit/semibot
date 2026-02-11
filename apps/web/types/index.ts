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
  Skill,
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
  UpdateOrganizationInput,
  RegisterInput,
  LoginInput,
  RefreshTokenInput,
  // API 响应
  ApiResponse,
  PaginationMeta,
  CursorPaginationMeta,
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
  orgId: string
  role: 'owner' | 'admin' | 'member'
}

/**
 * 组织信息
 */
export interface Organization {
  id: string
  name: string
  slug: string
  plan: 'free' | 'pro' | 'enterprise'
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
  messageId: string
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
  orgId: string
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
