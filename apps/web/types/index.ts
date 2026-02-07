/**
 * Semibot Frontend Type Definitions
 *
 * 基于 DATA_MODEL.md 和 ARCHITECTURE.md 设计
 */

// ═══════════════════════════════════════════════════════════════
// Agent2UI 消息类型
// ═══════════════════════════════════════════════════════════════

export type Agent2UIType =
  | 'text'
  | 'markdown'
  | 'code'
  | 'table'
  | 'chart'
  | 'image'
  | 'file'
  | 'plan'
  | 'progress'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'thinking'
  | 'report'
  | 'sandbox_log'
  | 'sandbox_output'

export interface Agent2UIMessage {
  id: string
  type: Agent2UIType
  data: Agent2UIData
  timestamp: string
  metadata?: Record<string, unknown>
}

export type Agent2UIData =
  | TextData
  | MarkdownData
  | CodeData
  | TableData
  | ChartData
  | ImageData
  | FileData
  | PlanData
  | ProgressData
  | ToolCallData
  | ToolResultData
  | ErrorData
  | ThinkingData
  | ReportData
  | SandboxLogData
  | SandboxOutputData

// ═══════════════════════════════════════════════════════════════
// 各类型数据结构
// ═══════════════════════════════════════════════════════════════

export interface TextData {
  content: string
}

export interface MarkdownData {
  content: string
}

export interface CodeData {
  language: string
  code: string
  filename?: string
}

export interface TableData {
  columns: TableColumn[]
  rows: Record<string, unknown>[]
  pagination?: {
    page: number
    pageSize: number
    total: number
  }
}

export interface TableColumn {
  key: string
  title: string
  type?: 'string' | 'number' | 'date'
}

export interface ChartData {
  chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'area'
  title?: string
  xAxis?: { data: string[]; name?: string }
  yAxis?: { name: string }
  series: ChartSeries[]
}

export interface ChartSeries {
  name: string
  data: number[]
}

export interface ImageData {
  url: string
  alt?: string
  caption?: string
  width?: number
  height?: number
}

export interface FileData {
  filename: string
  url: string
  size?: number
  mimeType?: string
}

export interface PlanData {
  steps: PlanStep[]
  currentStep: string
}

export interface PlanStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  substeps?: PlanStep[]
}

export interface ProgressData {
  current: number
  total: number
  percentage?: number
  label?: string
  message?: string
}

export interface ToolCallData {
  toolName: string
  arguments: Record<string, unknown>
  status: 'calling' | 'success' | 'error'
  result?: unknown
  duration?: number
}

export interface ToolResultData {
  toolName: string
  result: unknown
  success: boolean
  error?: string
}

export interface ErrorData {
  code: string
  message: string
  details?: unknown
}

export interface ThinkingData {
  content: string
}

export interface ReportData {
  title: string
  sections: ReportSection[]
  summary?: string
}

export interface ReportSection {
  heading: string
  content: Agent2UIMessage[]
}

// ═══════════════════════════════════════════════════════════════
// 沙箱日志类型
// ═══════════════════════════════════════════════════════════════

export type SandboxLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface SandboxLogData {
  sandboxId: string
  level: SandboxLogLevel
  message: string
  timestamp: string
  source?: string
}

export type SandboxOutputStream = 'stdout' | 'stderr'

export interface SandboxOutputData {
  sandboxId: string
  stream: SandboxOutputStream
  content: string
  timestamp: string
  exitCode?: number
}

export type SandboxStatus = 'starting' | 'running' | 'success' | 'error' | 'timeout'

export interface SandboxStatusData {
  sandboxId: string
  status: SandboxStatus
  startedAt?: string
  endedAt?: string
  durationMs?: number
  resourceUsage?: {
    cpuPercent?: number
    memoryMb?: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 用户和组织
// ═══════════════════════════════════════════════════════════════

export interface User {
  id: string
  email: string
  name?: string
  avatarUrl?: string
  orgId: string
  role: 'owner' | 'admin' | 'member'
}

export interface Organization {
  id: string
  name: string
  slug: string
  plan: 'free' | 'pro' | 'enterprise'
}

// ═══════════════════════════════════════════════════════════════
// Agent 相关
// ═══════════════════════════════════════════════════════════════

export interface Agent {
  id: string
  orgId: string
  name: string
  description?: string
  systemPrompt: string
  config: AgentConfig
  skills: string[]
  subAgents: string[]
  version: number
  isActive: boolean
  isPublic: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  model: string
  temperature: number
  maxTokens: number
  timeoutSeconds: number
  retryAttempts?: number
  fallbackModel?: string
}

// ═══════════════════════════════════════════════════════════════
// 技能和工具
// ═══════════════════════════════════════════════════════════════

export interface Skill {
  id: string
  orgId?: string
  name: string
  description?: string
  triggerKeywords: string[]
  tools: ToolConfig[]
  isBuiltin: boolean
  isActive: boolean
}

export interface ToolConfig {
  toolId: string
  required: boolean
  defaultParams?: Record<string, unknown>
}

export interface Tool {
  id: string
  orgId?: string
  name: string
  type: 'api' | 'code' | 'query' | 'mcp' | 'browser'
  description?: string
  schema: ToolSchema
  implementation: Record<string, unknown>
  isBuiltin: boolean
  isActive: boolean
}

export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required?: string[]
  }
}

export interface ToolParameter {
  type: string
  description?: string
  default?: unknown
  enum?: unknown[]
}

// ═══════════════════════════════════════════════════════════════
// 会话和消息
// ═══════════════════════════════════════════════════════════════

export interface Session {
  id: string
  orgId: string
  agentId: string
  userId: string
  status: 'active' | 'paused' | 'completed' | 'failed'
  title?: string
  metadata?: Record<string, unknown>
  startedAt: string
  endedAt?: string
  createdAt: string
}

export interface Message {
  id: string
  sessionId: string
  parentId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ═══════════════════════════════════════════════════════════════
// API 响应
// ═══════════════════════════════════════════════════════════════

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: ApiError
  meta?: PaginationMeta
}

export interface ApiError {
  code: string
  message: string
  details?: unknown
}

export interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

// ═══════════════════════════════════════════════════════════════
// SSE 事件
// ═══════════════════════════════════════════════════════════════

export interface SSEEvent {
  event: 'message' | 'done' | 'error' | 'heartbeat'
  data: Agent2UIMessage | SSEDoneData | SSEErrorData | null
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

// ═══════════════════════════════════════════════════════════════
// DTO 类型 (用于 API 请求)
// ═══════════════════════════════════════════════════════════════

export interface AgentModelConfigInput {
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutSeconds?: number
  retryAttempts?: number
  fallbackModel?: string
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt: string
  config?: AgentModelConfigInput
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}

export interface UpdateAgentInput {
  name?: string
  description?: string
  systemPrompt?: string
  config?: AgentModelConfigInput
  skills?: string[]
  subAgents?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface SkillToolInput {
  name: string
  type: 'function' | 'mcp'
  config?: Record<string, unknown>
}

export interface CreateSkillInput {
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillToolInput[]
  config?: {
    maxExecutionTime?: number
    retryAttempts?: number
    requiresApproval?: boolean
  }
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillToolInput[]
  config?: {
    maxExecutionTime?: number
    retryAttempts?: number
    requiresApproval?: boolean
  }
  isActive?: boolean
}

export interface CreateToolInput {
  name: string
  description?: string
  type: string
  schema?: {
    parameters?: Record<string, unknown>
    returns?: Record<string, unknown>
  }
  config?: {
    timeout?: number
    retryAttempts?: number
    requiresApproval?: boolean
    rateLimit?: number
  }
}

export interface UpdateToolInput {
  name?: string
  description?: string
  type?: string
  schema?: {
    parameters?: Record<string, unknown>
    returns?: Record<string, unknown>
  }
  config?: {
    timeout?: number
    retryAttempts?: number
    requiresApproval?: boolean
    rateLimit?: number
  }
  isActive?: boolean
}

export type McpTransport = 'stdio' | 'http' | 'websocket'
export type McpAuthType = 'none' | 'api_key' | 'oauth'

export interface CreateMcpServerInput {
  name: string
  description?: string
  endpoint: string
  transport: McpTransport
  authType?: McpAuthType
  authConfig?: {
    apiKey?: string
    oauthClientId?: string
    oauthClientSecret?: string
  }
}

export interface UpdateMcpServerInput {
  name?: string
  description?: string
  endpoint?: string
  transport?: McpTransport
  authType?: McpAuthType
  authConfig?: {
    apiKey?: string
    oauthClientId?: string
    oauthClientSecret?: string
  }
  isActive?: boolean
}

export interface CreateMemoryInput {
  agentId: string
  sessionId?: string
  userId?: string
  content: string
  embedding?: number[]
  memoryType?: MemoryType
  importance?: number
  metadata?: Record<string, unknown>
  expiresAt?: string
}

export interface SearchMemoriesInput {
  agentId: string
  embedding: number[]
  limit?: number
  minSimilarity?: number
}

export interface CreateApiKeyInput {
  name: string
  permissions?: string[]
  expiresAt?: string
}

export interface UpdateOrganizationInput {
  name?: string
  settings?: Record<string, unknown>
}
