/**
 * Message-related type definitions
 *
 * Based on docs/design/DATA_MODEL.md
 */

// =============================================================================
// Message Roles
// =============================================================================

/**
 * Message role types (OpenAI-compatible)
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// =============================================================================
// Tool Call Types
// =============================================================================

/**
 * Tool call request structure
 */
export interface ToolCall {
  /** Unique tool call identifier */
  id: string;
  /** Type of call (always 'function' for now) */
  type: 'function';
  /** Function call details */
  function: {
    /** Tool/function name */
    name: string;
    /** JSON-encoded arguments */
    arguments: string;
  };
}

/**
 * Tool call result
 */
export interface ToolCallResult {
  /** Corresponding tool call ID */
  toolCallId: string;
  /** Result content */
  content: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs?: number;
}

// =============================================================================
// Message Entity
// =============================================================================

/**
 * Message entity representing a single message in a conversation
 */
export interface Message {
  /** Unique identifier (UUID) */
  id: string;
  /** Parent session ID */
  sessionId: string;
  /** Parent message ID (for branching conversations) */
  parentId?: string;
  /** Message role */
  role: MessageRole;
  /** Message content */
  content: string;
  /** Tool calls made by assistant */
  toolCalls?: ToolCall[];
  /** Tool call ID (for tool role messages) */
  toolCallId?: string;
  /** Tokens consumed */
  tokensUsed?: number;
  /** Response latency in milliseconds */
  latencyMs?: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Message creation request
 */
export interface CreateMessageRequest {
  sessionId: string;
  role: MessageRole;
  content: string;
  parentId?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Chat Request/Response
// =============================================================================

/**
 * Chat completion request
 */
export interface ChatRequest {
  /** Session ID (creates new if not provided) */
  sessionId?: string;
  /** Agent ID (required if no sessionId) */
  agentId?: string;
  /** User message content */
  message: string;
  /** Whether to stream the response */
  stream?: boolean;
  /** Additional context/metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Chat completion response (non-streaming)
 */
export interface ChatResponse {
  /** Session ID */
  sessionId: string;
  /** Response message */
  message: Message;
  /** Tool calls made during response */
  toolCalls?: ToolCallResult[];
  /** Usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// =============================================================================
// Execution Logs
// =============================================================================

/**
 * Execution log entry for debugging and auditing
 */
export interface ExecutionLog {
  id: string;
  orgId: string;
  agentId: string;
  sessionId: string;
  requestId?: string;
  stepId?: string;
  actionId?: string;
  state: string;
  actionType?: string;
  actionName?: string;
  actionInput?: Record<string, unknown>;
  actionOutput?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retryCount: number;
  durationMs?: number;
  tokensInput: number;
  tokensOutput: number;
  model?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
