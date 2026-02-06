/**
 * Data Transfer Object (DTO) type definitions
 *
 * These types represent the input/output contracts for API requests,
 * ensuring consistency between frontend and backend.
 */

import type { SessionStatus } from './session';
import type { MessageRole, ToolCall } from './message';

// =============================================================================
// Agent DTOs
// =============================================================================

/**
 * Agent model configuration input (all fields optional with defaults)
 */
export interface AgentModelConfigInput {
  /** Model identifier (e.g., 'gpt-4o', 'claude-3-sonnet') */
  model?: string;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Request timeout in seconds */
  timeoutSeconds?: number;
  /** Number of retry attempts on failure */
  retryAttempts?: number;
  /** Fallback model if primary fails */
  fallbackModel?: string;
}

/**
 * Create Agent request DTO
 */
export interface CreateAgentInput {
  /** Display name */
  name: string;
  /** Description of agent's purpose */
  description?: string;
  /** System prompt for LLM */
  systemPrompt: string;
  /** Model configuration (optional, uses defaults) */
  config?: AgentModelConfigInput;
  /** List of skill IDs */
  skills?: string[];
  /** List of sub-agent IDs for delegation */
  subAgents?: string[];
  /** Whether agent is publicly accessible */
  isPublic?: boolean;
}

/**
 * Update Agent request DTO
 */
export interface UpdateAgentInput {
  /** Display name */
  name?: string;
  /** Description of agent's purpose */
  description?: string;
  /** System prompt for LLM */
  systemPrompt?: string;
  /** Model configuration */
  config?: AgentModelConfigInput;
  /** List of skill IDs */
  skills?: string[];
  /** List of sub-agent IDs for delegation */
  subAgents?: string[];
  /** Whether agent is active */
  isActive?: boolean;
  /** Whether agent is publicly accessible */
  isPublic?: boolean;
}

// =============================================================================
// Session DTOs
// =============================================================================

/**
 * Create Session request DTO
 */
export interface CreateSessionInput {
  /** Agent ID */
  agentId: string;
  /** Session title */
  title?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Update Session request DTO
 * Note: Only title and status can be updated
 */
export interface UpdateSessionInput {
  /** Session title */
  title?: string;
  /** Session status */
  status?: SessionStatus;
}

// =============================================================================
// Message DTOs
// =============================================================================

/**
 * Add Message request DTO
 */
export interface AddMessageInput {
  /** Message role */
  role: MessageRole;
  /** Message content */
  content: string;
  /** Parent message ID (for branching conversations) */
  parentMessageId?: string;
  /** Tool calls made by assistant */
  toolCalls?: ToolCall[];
  /** Tool call ID (for tool role messages) */
  toolCallId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Chat message request DTO
 */
export interface ChatMessageInput {
  /** User message content */
  message: string;
  /** Parent message ID (for branching) */
  parentMessageId?: string;
}

/**
 * Start chat request DTO
 */
export interface StartChatInput {
  /** Agent ID */
  agentId: string;
  /** User message content */
  message: string;
}

// =============================================================================
// Skill DTOs
// =============================================================================

/**
 * Tool reference in skill
 */
export interface SkillToolInput {
  /** Tool name */
  name: string;
  /** Tool type */
  type: 'function' | 'mcp';
  /** Tool configuration */
  config?: Record<string, unknown>;
}

/**
 * Create Skill request DTO
 */
export interface CreateSkillInput {
  /** Skill name */
  name: string;
  /** Skill description */
  description?: string;
  /** Trigger keywords */
  triggerKeywords?: string[];
  /** Tools used by skill */
  tools?: SkillToolInput[];
  /** Skill configuration */
  config?: {
    maxExecutionTime?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
  };
}

/**
 * Update Skill request DTO
 */
export interface UpdateSkillInput {
  /** Skill name */
  name?: string;
  /** Skill description */
  description?: string;
  /** Trigger keywords */
  triggerKeywords?: string[];
  /** Tools used by skill */
  tools?: SkillToolInput[];
  /** Skill configuration */
  config?: {
    maxExecutionTime?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
  };
  /** Whether skill is active */
  isActive?: boolean;
}

// =============================================================================
// Tool DTOs
// =============================================================================

/**
 * Create Tool request DTO
 */
export interface CreateToolInput {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** Tool type */
  type: string;
  /** Tool schema */
  schema?: {
    parameters?: Record<string, unknown>;
    returns?: Record<string, unknown>;
  };
  /** Tool configuration */
  config?: {
    timeout?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
    rateLimit?: number;
  };
}

/**
 * Update Tool request DTO
 */
export interface UpdateToolInput {
  /** Tool name */
  name?: string;
  /** Tool description */
  description?: string;
  /** Tool type */
  type?: string;
  /** Tool schema */
  schema?: {
    parameters?: Record<string, unknown>;
    returns?: Record<string, unknown>;
  };
  /** Tool configuration */
  config?: {
    timeout?: number;
    retryAttempts?: number;
    requiresApproval?: boolean;
    rateLimit?: number;
  };
  /** Whether tool is active */
  isActive?: boolean;
}

// =============================================================================
// MCP Server DTOs
// =============================================================================

/**
 * MCP transport types
 */
export type McpTransport = 'stdio' | 'http' | 'websocket';

/**
 * MCP auth types
 */
export type McpAuthType = 'none' | 'api_key' | 'oauth';

/**
 * Create MCP Server request DTO
 */
export interface CreateMcpServerInput {
  /** Server name */
  name: string;
  /** Server description */
  description?: string;
  /** Server endpoint */
  endpoint: string;
  /** Transport type */
  transport: McpTransport;
  /** Auth type */
  authType?: McpAuthType;
  /** Auth configuration */
  authConfig?: {
    apiKey?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  };
}

/**
 * Update MCP Server request DTO
 */
export interface UpdateMcpServerInput {
  /** Server name */
  name?: string;
  /** Server description */
  description?: string;
  /** Server endpoint */
  endpoint?: string;
  /** Transport type */
  transport?: McpTransport;
  /** Auth type */
  authType?: McpAuthType;
  /** Auth configuration */
  authConfig?: {
    apiKey?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  };
  /** Whether server is active */
  isActive?: boolean;
}

// =============================================================================
// Memory DTOs
// =============================================================================

/**
 * Memory types
 */
export type MemoryTypeInput = 'episodic' | 'semantic' | 'procedural';

/**
 * Create Memory request DTO
 */
export interface CreateMemoryInput {
  /** Agent ID */
  agentId: string;
  /** Session ID */
  sessionId?: string;
  /** User ID */
  userId?: string;
  /** Memory content */
  content: string;
  /** Vector embedding */
  embedding?: number[];
  /** Memory type */
  memoryType?: MemoryTypeInput;
  /** Importance score (0-1) */
  importance?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Expiration timestamp */
  expiresAt?: string;
}

/**
 * Search Memories request DTO
 */
export interface SearchMemoriesInput {
  /** Agent ID */
  agentId: string;
  /** Query embedding */
  embedding: number[];
  /** Max results */
  limit?: number;
  /** Minimum similarity score */
  minSimilarity?: number;
}

// =============================================================================
// API Key DTOs
// =============================================================================

/**
 * Create API Key request DTO
 */
export interface CreateApiKeyInput {
  /** Key name */
  name: string;
  /** Permissions */
  permissions?: string[];
  /** Expiration timestamp */
  expiresAt?: string;
}

// =============================================================================
// Organization DTOs
// =============================================================================

/**
 * Update Organization request DTO
 */
export interface UpdateOrganizationInput {
  /** Organization name */
  name?: string;
  /** Organization settings */
  settings?: Record<string, unknown>;
}

// =============================================================================
// Auth DTOs
// =============================================================================

/**
 * Register request DTO
 */
export interface RegisterInput {
  /** User email */
  email: string;
  /** User password */
  password: string;
  /** User name */
  name: string;
  /** Organization name */
  orgName: string;
}

/**
 * Login request DTO
 */
export interface LoginInput {
  /** User email */
  email: string;
  /** User password */
  password: string;
}

/**
 * Refresh token request DTO
 */
export interface RefreshTokenInput {
  /** Refresh token */
  refreshToken: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  /** Whether the request succeeded */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error information */
  error?: {
    code: string;
    message: string;
    details?: Array<{
      field: string;
      message: string;
    }>;
  };
  /** Pagination metadata */
  meta?: PaginationMeta;
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  /** Current page */
  page: number;
  /** Items per page */
  limit: number;
  /** Total items */
  total: number;
  /** Total pages */
  totalPages: number;
}

/**
 * Cursor pagination metadata
 */
export interface CursorPaginationMeta {
  /** Next cursor for pagination */
  nextCursor?: string;
}
