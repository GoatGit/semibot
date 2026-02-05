/**
 * Session-related type definitions
 *
 * Based on docs/design/DATA_MODEL.md
 */

// =============================================================================
// Session Status
// =============================================================================

/**
 * Session lifecycle status
 */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed';

// =============================================================================
// Session Entity
// =============================================================================

/**
 * Session entity representing a conversation between user and agent
 */
export interface Session {
  /** Unique identifier (UUID) */
  id: string;
  /** Organization ID (multi-tenant isolation) */
  orgId: string;
  /** Associated agent ID */
  agentId: string;
  /** User identifier */
  userId: string;
  /** Session status */
  status: SessionStatus;
  /** Auto-generated title based on conversation */
  title?: string;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Session start timestamp */
  startedAt: string;
  /** Session end timestamp (when completed/failed) */
  endedAt?: string;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Session creation request
 */
export interface CreateSessionRequest {
  agentId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Session update request
 */
export interface UpdateSessionRequest {
  status?: SessionStatus;
  title?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Session List & Pagination
// =============================================================================

/**
 * Session list item (summary view)
 */
export interface SessionListItem {
  id: string;
  agentId: string;
  agentName: string;
  title?: string;
  status: SessionStatus;
  lastMessageAt?: string;
  createdAt: string;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page: number;
  pageSize: number;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// =============================================================================
// Memory Types
// =============================================================================

/**
 * Memory types for agent long-term memory
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

/**
 * Memory entity for vector storage
 */
export interface Memory {
  id: string;
  agentId: string;
  sessionId?: string;
  content: string;
  /** Vector embedding (stored as array for transport) */
  embedding?: number[];
  memoryType: MemoryType;
  /** Importance score (0-1) */
  importance: number;
  metadata: Record<string, unknown>;
  expiresAt?: string;
  createdAt: string;
}
