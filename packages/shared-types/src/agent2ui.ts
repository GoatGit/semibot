/**
 * Agent2UI Message Type Definitions
 *
 * Based on docs/design/ARCHITECTURE.md Section 2.1.3
 *
 * Agent2UI design philosophy: Backend only transmits structured JSON data,
 * frontend components are responsible for intelligent rendering.
 */

// =============================================================================
// Agent2UI Message Types
// =============================================================================

/**
 * All supported Agent2UI message types
 */
export type Agent2UIType =
  | 'text'        // Plain text
  | 'markdown'    // Markdown rich text
  | 'code'        // Code block
  | 'table'       // Data table
  | 'chart'       // Chart visualization
  | 'image'       // Image
  | 'file'        // File download
  | 'plan'        // Execution plan
  | 'progress'    // Progress indicator
  | 'tool_call'   // Tool invocation
  | 'tool_result' // Tool result
  | 'skill_call'  // Skill invocation
  | 'skill_result' // Skill result
  | 'mcp_call'    // MCP tool invocation
  | 'mcp_result'  // MCP tool result
  | 'plan_step'   // Plan step update
  | 'error'       // Error message
  | 'thinking'    // Thinking process
  | 'report';     // Structured report

// =============================================================================
// Data Structures for Each Type
// =============================================================================

/**
 * Text content data
 */
export interface TextData {
  content: string;
}

/**
 * Markdown content data
 */
export interface MarkdownData {
  content: string;
}

/**
 * Code block data
 */
export interface CodeData {
  language: string;
  code: string;
  filename?: string;
  highlightLines?: number[];
}

/**
 * Table column definition
 */
export interface TableColumn {
  key: string;
  title: string;
  type?: 'string' | 'number' | 'date' | 'boolean';
  width?: number;
  sortable?: boolean;
}

/**
 * Table data structure
 */
export interface TableData {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
}

/**
 * Chart types supported
 */
export type ChartType = 'line' | 'bar' | 'pie' | 'scatter' | 'area';

/**
 * Chart data structure (ECharts-compatible)
 */
export interface ChartData {
  chartType: ChartType;
  title?: string;
  xAxis?: {
    data: string[];
    name?: string;
  };
  yAxis?: {
    name?: string;
  };
  series: Array<{
    name: string;
    data: number[];
    type?: ChartType;
  }>;
}

/**
 * Image data structure
 */
export interface ImageData {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
}

/**
 * File download data
 */
export interface FileData {
  url: string;
  filename: string;
  mimeType: string;
  size?: number;
}

/**
 * Plan step status
 */
export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Plan step definition
 */
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  description?: string;
  durationMs?: number;
  substeps?: Array<{
    id: string;
    title: string;
    status: PlanStepStatus;
  }>;
}

/**
 * Execution plan data
 */
export interface PlanData {
  steps: PlanStep[];
  currentStep: string;
  progress?: number;
}

/**
 * Progress indicator data
 */
export interface ProgressData {
  current: number;
  total: number;
  percentage: number;
  label?: string;
  status?: 'active' | 'success' | 'error';
}

/**
 * Tool call status
 */
export type ToolCallStatus = 'calling' | 'success' | 'error';

/**
 * Tool call data
 */
export interface ToolCallData {
  toolName: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  duration?: number;
}

/**
 * Tool result data
 */
export interface ToolResultData {
  toolName: string;
  result: unknown;
  success: boolean;
  error?: string;
  duration?: number;
}

/**
 * Skill call data
 */
export interface SkillCallData {
  skillId: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  duration?: number;
}

/**
 * Skill result data
 */
export interface SkillResultData {
  skillId: string;
  skillName: string;
  result: unknown;
  success: boolean;
  error?: string;
  duration?: number;
}

/**
 * MCP call data
 */
export interface McpCallData {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  duration?: number;
}

/**
 * MCP result data
 */
export interface McpResultData {
  serverId: string;
  toolName: string;
  result: unknown;
  success: boolean;
  error?: string;
  duration?: number;
}

/**
 * Plan step update data
 */
export interface PlanStepData {
  stepId: string;
  title: string;
  status: PlanStepStatus;
  tool?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

/**
 * Error data
 */
export interface ErrorData {
  code: string;
  message: string;
  details?: string;
  recoverable?: boolean;
  retryAction?: string;
}

/**
 * Thinking process data
 */
export interface ThinkingData {
  content: string;
  stage?: 'analyzing' | 'planning' | 'reasoning' | 'concluding';
}

/**
 * Report section
 */
export interface ReportSection {
  heading: string;
  content: Agent2UIMessage[];
}

/**
 * Structured report data
 */
export interface ReportData {
  title: string;
  sections: ReportSection[];
  summary?: string;
  generatedAt?: string;
}

// =============================================================================
// Union Type for All Data
// =============================================================================

/**
 * Union type for all Agent2UI data payloads
 */
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
  | SkillCallData
  | SkillResultData
  | McpCallData
  | McpResultData
  | PlanStepData
  | ErrorData
  | ThinkingData
  | ReportData;

// =============================================================================
// Agent2UI Message
// =============================================================================

/**
 * Agent2UI message structure
 *
 * This is the core message format sent from backend to frontend
 * via SSE or WebSocket for real-time updates.
 */
export interface Agent2UIMessage {
  /** Unique message identifier */
  id: string;
  /** Message type determines rendering component */
  type: Agent2UIType;
  /** Type-specific data payload */
  data: Agent2UIData;
  /** ISO timestamp */
  timestamp: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for text data
 */
export function isTextData(data: Agent2UIData): data is TextData {
  return 'content' in data && typeof (data as TextData).content === 'string';
}

/**
 * Type guard for table data
 */
export function isTableData(data: Agent2UIData): data is TableData {
  return 'columns' in data && 'rows' in data;
}

/**
 * Type guard for chart data
 */
export function isChartData(data: Agent2UIData): data is ChartData {
  return 'chartType' in data && 'series' in data;
}

/**
 * Type guard for plan data
 */
export function isPlanData(data: Agent2UIData): data is PlanData {
  return 'steps' in data && 'currentStep' in data;
}

/**
 * Type guard for tool call data
 */
export function isToolCallData(data: Agent2UIData): data is ToolCallData {
  return 'toolName' in data && 'arguments' in data && 'status' in data;
}

/**
 * Type guard for error data
 */
export function isErrorData(data: Agent2UIData): data is ErrorData {
  return 'code' in data && 'message' in data;
}

/**
 * Type guard for report data
 */
export function isReportData(data: Agent2UIData): data is ReportData {
  return 'title' in data && 'sections' in data;
}

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * SSE event types for streaming
 */
export type SSEEventType =
  | 'message'   // Regular Agent2UI message
  | 'error'     // Error occurred
  | 'done'      // Stream completed
  | 'heartbeat'; // Keep-alive ping

/**
 * SSE event wrapper
 */
export interface SSEEvent {
  event: SSEEventType;
  data: Agent2UIMessage | { sessionId: string; messageId: string } | null;
}
